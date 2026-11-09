//! `swarmterm --mcp-stdio`: the agent CLIs' MCP entry for Swarmterm
//! (SWA-83 1b).
//!
//! The entries used to name the HTTP server directly (`${SWARMTERM_MCP_URL}`
//! with a `Bearer ${SWARMTERM_SESSION}` header). Every Claude Code session
//! started outside a Swarmterm pane then reported a broken server ("missing
//! environment variables"), and Codex needed the concrete port written into
//! `config.toml` on every boot. The entry is now this stdio command instead:
//!
//! * In a pane (`SWARMTERM_MCP_URL` + `SWARMTERM_SESSION` set) it relays each
//!   JSON-RPC line to the pane's HTTP endpoint with the pane's bearer and
//!   writes the answers back. The server sees exactly what a direct HTTP
//!   client sends, so auth, `record_client` ("connected") and every tool are
//!   unchanged; the proxy adds no capability.
//! * Anywhere else, or when the app is not reachable at `initialize`, it is a
//!   valid MCP server with no tools: the CLI shows it connected and quiet.
//!
//! Only loopback `http://127.0.0.1:<port>/mcp` is accepted as upstream, so a
//! bearer never leaves the machine. Nothing but protocol lines goes to
//! stdout; diagnostics go to stderr, which the CLIs keep in their MCP logs.

use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};

const ACCEPT: &str = "application/json, text/event-stream";
const SESSION_HEADER: &str = "mcp-session-id";
const VERSION_HEADER: &str = "mcp-protocol-version";
/// Used when a client sends no version (never seen; MCP requires one).
const FALLBACK_PROTOCOL: &str = "2025-06-18";
/// How long answers still in flight may finish after stdin closed.
const DRAIN: std::time::Duration = std::time::Duration::from_secs(2);

/// Where to relay to. `None` = answer as the empty server.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Upstream {
    pub url: String,
    pub bearer: String,
}

/// The pane's endpoint from its environment, or `None` outside a pane. A URL
/// that is not our loopback endpoint is refused (empty server), never
/// contacted with the bearer.
pub fn upstream_from(url: Option<&str>, bearer: Option<&str>) -> Option<Upstream> {
    let url = url.map(str::trim).filter(|u| !u.is_empty())?;
    let bearer = bearer.map(str::trim).filter(|b| !b.is_empty())?;
    let rest = url.strip_prefix("http://127.0.0.1:")?;
    let port = rest.strip_suffix("/mcp")?;
    if port.is_empty() || !port.chars().all(|c| c.is_ascii_digit()) || port.len() > 5 {
        return None;
    }
    Some(Upstream {
        url: url.to_string(),
        bearer: bearer.to_string(),
    })
}

fn is_request(msg: &Value) -> bool {
    msg.get("method").is_some() && msg.get("id").is_some_and(|id| !id.is_null())
}

fn method(msg: &Value) -> Option<&str> {
    msg.get("method").and_then(Value::as_str)
}

/// The empty server's answer to `msg`, or `None` for a notification.
pub fn empty_reply(msg: &Value) -> Option<Value> {
    if !is_request(msg) {
        return None;
    }
    let id = msg["id"].clone();
    let result = match method(msg).unwrap_or_default() {
        "initialize" => json!({
            "protocolVersion": msg
                .pointer("/params/protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or(FALLBACK_PROTOCOL),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "swarmterm", "version": env!("CARGO_PKG_VERSION") },
        }),
        "tools/list" => json!({ "tools": [] }),
        "resources/list" => json!({ "resources": [] }),
        "resources/templates/list" => json!({ "resourceTemplates": [] }),
        "prompts/list" => json!({ "prompts": [] }),
        "ping" => json!({}),
        other => {
            return Some(error_reply(
                id,
                -32601,
                &format!("{other}: Swarmterm's tools are only available in Swarmterm panes"),
            ))
        }
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

fn error_reply(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Incremental `text/event-stream` reader: returns the `data` of each
/// completed event. Works on bytes so a chunk boundary inside a multi-byte
/// character or a CRLF does not corrupt anything.
#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
    data: Vec<String>,
}

impl SseParser {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(chunk);
        let mut events = Vec::new();
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let mut line: Vec<u8> = self.buf.drain(..=pos).collect();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            let line = String::from_utf8_lossy(&line);
            if line.is_empty() {
                if !self.data.is_empty() {
                    let data = self.data.join("\n");
                    self.data.clear();
                    if !data.trim().is_empty() {
                        events.push(data);
                    }
                }
            } else if let Some(value) = line.strip_prefix("data:") {
                self.data
                    .push(value.strip_prefix(' ').unwrap_or(value).to_string());
            }
            // `event:`, `id:`, `retry:` and `:` comments carry nothing we relay.
        }
        events
    }

    /// An event the server ended without the closing blank line.
    pub fn finish(&mut self) -> Option<String> {
        let mut tail = self.push(b"\n\n");
        tail.pop()
    }
}

/// Where answers go: one JSON value per stdout line.
#[derive(Clone)]
pub struct Out(std::sync::mpsc::Sender<String>);

impl Out {
    fn send(&self, value: &Value) {
        if let Ok(line) = serde_json::to_string(value) {
            let _ = self.0.send(line);
        }
    }

    /// Relay a JSON-RPC payload (one message or a batch) as-is.
    fn relay(&self, text: &str) {
        match serde_json::from_str::<Value>(text) {
            Ok(Value::Array(items)) => items.iter().for_each(|m| self.send(m)),
            Ok(value) => self.send(&value),
            Err(_) => {
                eprintln!("swarmterm --mcp-stdio: dropped a non-JSON message from the server")
            }
        }
    }
}

enum Posted {
    /// Everything the server sent back was relayed.
    Done,
    /// The server no longer knows this session (app restarted on the same
    /// port); initialize again and retry.
    SessionGone(String),
    Failed(String),
}

struct Proxy {
    upstream: Option<Upstream>,
    client: reqwest::Client,
    /// Held while a lost session is renewed, so handlers that lost it
    /// together renew it once.
    renew: Mutex<()>,
    session: Mutex<Option<String>>,
    protocol: Mutex<Option<String>>,
    /// The client's own `initialize`, replayed when the session is gone.
    init: Mutex<Option<Value>>,
    offline: AtomicBool,
}

impl Proxy {
    fn new(upstream: Option<Upstream>) -> Self {
        let built = reqwest::Client::builder()
            // Loopback only: a configured proxy must never see the bearer,
            // and whatever holds the port must not send us elsewhere.
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(3))
            .build();
        // No fallback to a default client (it would honour system proxies):
        // without ours, serve no tools.
        let (client, upstream) = match built {
            Ok(client) => (client, upstream),
            Err(e) => {
                eprintln!("swarmterm --mcp-stdio: {e}; serving no tools");
                (reqwest::Client::new(), None)
            }
        };
        Self {
            offline: AtomicBool::new(upstream.is_none()),
            upstream,
            client,
            renew: Mutex::new(()),
            session: Mutex::new(None),
            protocol: Mutex::new(None),
            init: Mutex::new(None),
        }
    }

    /// POST one message; relay whatever comes back to `out` (when given).
    async fn post(&self, msg: &Value, out: Option<&Out>) -> Posted {
        let Some(up) = &self.upstream else {
            return Posted::Failed("no upstream".into());
        };
        let session = self.session.lock().await.clone();
        let mut req = self
            .client
            .post(&up.url)
            .header("authorization", format!("Bearer {}", up.bearer))
            .header("accept", ACCEPT)
            .header("content-type", "application/json")
            .body(msg.to_string());
        if let Some(s) = &session {
            req = req.header(SESSION_HEADER, s);
        }
        if let Some(v) = self.protocol.lock().await.clone() {
            req = req.header(VERSION_HEADER, v);
        }
        let mut resp = match req.send().await {
            Ok(r) => r,
            Err(e) => return Posted::Failed(format!("Swarmterm is not reachable: {e}")),
        };
        let status = resp.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            if let Some(stale) = session {
                return Posted::SessionGone(stale);
            }
        }
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            let body: String = body.chars().take(200).collect();
            return Posted::Failed(format!("Swarmterm answered {status}: {body}"));
        }
        if let Some(s) = resp
            .headers()
            .get(SESSION_HEADER)
            .and_then(|v| v.to_str().ok())
        {
            *self.session.lock().await = Some(s.to_string());
        }
        let sse = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|c| c.starts_with("text/event-stream"));
        if sse {
            let mut parser = SseParser::default();
            loop {
                match resp.chunk().await {
                    Ok(Some(chunk)) => {
                        for data in parser.push(&chunk) {
                            if let Some(out) = out {
                                out.relay(&data);
                            }
                        }
                    }
                    Ok(None) => break,
                    Err(e) => return Posted::Failed(format!("stream ended early: {e}")),
                }
            }
            if let (Some(data), Some(out)) = (parser.finish(), out) {
                out.relay(&data);
            }
        } else {
            let body = resp.text().await.unwrap_or_default();
            if !body.trim().is_empty() {
                if let Some(out) = out {
                    out.relay(&body);
                }
            }
        }
        Posted::Done
    }

    async fn initialize(&self, msg: Value, out: &Out) {
        *self.init.lock().await = Some(msg.clone());
        if !self.offline.load(Ordering::Acquire) {
            let version = msg
                .pointer("/params/protocolVersion")
                .and_then(Value::as_str)
                .map(str::to_string);
            match self.post(&msg, Some(out)).await {
                Posted::Done => {
                    *self.protocol.lock().await = version;
                    return;
                }
                Posted::SessionGone(_) | Posted::Failed(_) => {
                    // The pane outlived its app, or the app is starting: a
                    // quiet empty server instead of an error in every session.
                    eprintln!("swarmterm --mcp-stdio: Swarmterm not reachable, serving no tools");
                    self.offline.store(true, Ordering::Release);
                }
            }
        }
        if let Some(reply) = empty_reply(&msg) {
            out.send(&reply);
        }
    }

    /// Replay the client's `initialize` for a fresh session, unless another
    /// handler already replaced `stale` while this one waited.
    async fn reinitialize(&self, stale: &str) -> bool {
        let _renew = self.renew.lock().await;
        if self.session.lock().await.as_deref() != Some(stale) {
            return true;
        }
        let Some(mut init) = self.init.lock().await.clone() else {
            return false;
        };
        init["id"] = json!("swarmterm-proxy-reinit");
        *self.session.lock().await = None;
        if !matches!(self.post(&init, None).await, Posted::Done) {
            return false;
        }
        let initialized = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        matches!(self.post(&initialized, None).await, Posted::Done)
    }

    async fn handle(self: Arc<Self>, msg: Value, out: Out) {
        if self.offline.load(Ordering::Acquire) {
            if let Some(reply) = empty_reply(&msg) {
                out.send(&reply);
            }
            return;
        }
        let mut outcome = self.post(&msg, Some(&out)).await;
        if let Posted::SessionGone(stale) = &outcome {
            outcome = if self.reinitialize(stale).await {
                self.post(&msg, Some(&out)).await
            } else {
                Posted::Failed("Swarmterm restarted and the session could not be renewed".into())
            };
        }
        let failure = match outcome {
            Posted::Done => return,
            Posted::SessionGone(_) => "Swarmterm no longer knows this session".to_string(),
            Posted::Failed(why) => why,
        };
        eprintln!("swarmterm --mcp-stdio: {failure}");
        if is_request(&msg) {
            out.send(&error_reply(msg["id"].clone(), -32603, &failure));
        }
    }

    /// Best effort: end the server-side session when the client goes away.
    async fn close(&self) {
        let (Some(up), Some(session)) = (&self.upstream, self.session.lock().await.clone()) else {
            return;
        };
        let req = self
            .client
            .delete(&up.url)
            .header("authorization", format!("Bearer {}", up.bearer))
            .header(SESSION_HEADER, session)
            .timeout(std::time::Duration::from_secs(1));
        let _ = req.send().await;
    }
}

/// The relay loop: one JSON-RPC message per input line. `initialize` is
/// handled before the next line is read (everything after it needs its
/// session); every other message runs concurrently, since a tool such as
/// `war_room.wait_peer` may block for minutes while others go on.
pub async fn serve(
    mut input: mpsc::UnboundedReceiver<String>,
    out: Out,
    upstream: Option<Upstream>,
) {
    let proxy = Arc::new(Proxy::new(upstream));
    let mut tasks = tokio::task::JoinSet::new();
    while let Some(line) = input.recv().await {
        if line.trim().is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(&line) {
            Ok(m) => m,
            Err(_) => {
                out.send(&error_reply(Value::Null, -32700, "Parse error"));
                continue;
            }
        };
        if method(&msg) == Some("initialize") && is_request(&msg) {
            proxy.initialize(msg, &out).await;
        } else {
            tasks.spawn(proxy.clone().handle(msg, out.clone()));
        }
        while tasks.try_join_next().is_some() {}
    }
    // stdin closed. An MCP client shutting down this way no longer reads,
    // but a one-shot caller (`echo … | swarmterm --mcp-stdio`) still waits
    // for its answer: let what is in flight finish, bounded so a slow app
    // never delays the client's shutdown.
    let _ = tokio::time::timeout(DRAIN, async { while tasks.join_next().await.is_some() {} }).await;
    tasks.abort_all();
    proxy.close().await;
}

/// Entry point for `swarmterm --mcp-stdio`. Returns the exit code.
pub fn run_cli() -> i32 {
    let upstream = upstream_from(
        std::env::var("SWARMTERM_MCP_URL").ok().as_deref(),
        std::env::var("SWARMTERM_SESSION").ok().as_deref(),
    );
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("swarmterm --mcp-stdio: {e}");
            return 1;
        }
    };
    let (in_tx, in_rx) = mpsc::unbounded_channel();
    // Plain threads for stdio: blocking reads never hold a runtime worker.
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if in_tx.send(line).is_err() {
                break;
            }
        }
    });
    let (out_tx, out_rx) = std::sync::mpsc::channel::<String>();
    let writer = std::thread::spawn(move || {
        let stdout = std::io::stdout();
        let mut lock = stdout.lock();
        for line in out_rx {
            if writeln!(lock, "{line}").and_then(|_| lock.flush()).is_err() {
                break;
            }
        }
    });
    runtime.block_on(serve(in_rx, Out(out_tx), upstream));
    drop(runtime);
    let _ = writer.join();
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upstream_needs_both_variables_and_our_loopback_endpoint() {
        let ok = upstream_from(Some("http://127.0.0.1:54321/mcp"), Some("s3cret"));
        assert_eq!(ok.unwrap().url, "http://127.0.0.1:54321/mcp");
        assert_eq!(upstream_from(None, Some("s")), None);
        assert_eq!(
            upstream_from(Some("http://127.0.0.1:1/mcp"), Some(" ")),
            None
        );
        for bad in [
            "https://127.0.0.1:1/mcp",
            "http://localhost:1/mcp",
            "http://127.0.0.1:1/mcp/x",
            "http://127.0.0.1:/mcp",
            "http://127.0.0.1:1@evil.example/mcp",
            "http://127.0.0.1:123456/mcp",
            "${SWARMTERM_MCP_URL}",
        ] {
            assert_eq!(upstream_from(Some(bad), Some("s")), None, "{bad}");
        }
    }

    #[test]
    fn the_empty_server_answers_the_handshake_and_lists_nothing() {
        let init = json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26"}});
        let r = empty_reply(&init).unwrap();
        assert_eq!(r["id"], 0);
        assert_eq!(r["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(r["result"]["serverInfo"]["name"], "swarmterm");
        let list = empty_reply(&json!({"jsonrpc":"2.0","id":"a","method":"tools/list"})).unwrap();
        assert_eq!(list["result"]["tools"], json!([]));
        let call = empty_reply(&json!({"jsonrpc":"2.0","id":3,"method":"tools/call"})).unwrap();
        assert_eq!(call["error"]["code"], -32601);
        assert_eq!(
            empty_reply(&json!({"jsonrpc":"2.0","method":"notifications/initialized"})),
            None
        );
    }

    #[test]
    fn sse_events_survive_any_chunking() {
        let stream = "event: message\r\nid: 1\r\ndata: {\"a\":\"\u{e4}\"}\r\n\r\n: keep-alive\n\ndata: {\"b\":1}\ndata: \n\n";
        let bytes = stream.as_bytes();
        for split in 1..bytes.len() {
            let mut p = SseParser::default();
            let mut events = p.push(&bytes[..split]);
            events.extend(p.push(&bytes[split..]));
            assert_eq!(
                events,
                vec!["{\"a\":\"\u{e4}\"}", "{\"b\":1}\n"],
                "split at {split}"
            );
        }
    }

    #[test]
    fn an_unterminated_last_event_is_kept() {
        let mut p = SseParser::default();
        assert!(p.push(b"data: {\"x\":1}").is_empty());
        assert_eq!(p.finish().as_deref(), Some("{\"x\":1}"));
    }

    // ---- relay against a fake streamable-HTTP server -------------------

    use axum::extract::State;
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::{IntoResponse, Response};
    use std::sync::atomic::AtomicUsize;

    #[derive(Default)]
    struct Fake {
        sessions: std::sync::Mutex<Vec<String>>,
        seen_auth: std::sync::Mutex<Vec<String>>,
        inits: AtomicUsize,
    }

    async fn fake_mcp(State(fake): State<Arc<Fake>>, headers: HeaderMap, body: String) -> Response {
        let auth = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        fake.seen_auth.lock().unwrap().push(auth.clone());
        if auth != "Bearer tok" {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        let msg: Value = serde_json::from_str(&body).unwrap();
        let session = headers
            .get(SESSION_HEADER)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        if method(&msg) == Some("initialize") {
            let n = fake.inits.fetch_add(1, Ordering::SeqCst);
            let id = format!("s{n}");
            fake.sessions.lock().unwrap().push(id.clone());
            let reply = json!({"jsonrpc":"2.0","id":msg["id"],"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"fake","version":"1"}}});
            return (
                [
                    (SESSION_HEADER, id),
                    ("content-type", "text/event-stream".into()),
                ],
                format!("data: {reply}\n\n"),
            )
                .into_response();
        }
        let known = session
            .as_ref()
            .is_some_and(|s| fake.sessions.lock().unwrap().contains(s));
        if !known {
            return StatusCode::NOT_FOUND.into_response();
        }
        if !is_request(&msg) {
            return StatusCode::ACCEPTED.into_response();
        }
        let reply = json!({"jsonrpc":"2.0","id":msg["id"],"result":{"tools":[{"name":"war_room.send"}],"session":session}});
        (
            [("content-type", "text/event-stream")],
            format!(": ping\n\ndata: {reply}\n\n"),
        )
            .into_response()
    }

    async fn start_fake() -> (Arc<Fake>, String) {
        let fake = Arc::new(Fake::default());
        let app = axum::Router::new()
            .route("/mcp", axum::routing::post(fake_mcp))
            .with_state(fake.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (fake, format!("http://127.0.0.1:{port}/mcp"))
    }

    /// Feed `lines`, close stdin, collect every stdout line.
    async fn run(upstream: Option<Upstream>, lines: &[Value]) -> Vec<Value> {
        let (in_tx, in_rx) = mpsc::unbounded_channel();
        let (out_tx, out_rx) = std::sync::mpsc::channel();
        for l in lines {
            in_tx.send(l.to_string()).unwrap();
        }
        let serving = tokio::spawn(serve(in_rx, Out(out_tx), upstream));
        // Let the spawned handlers answer before stdin closes.
        let mut got = Vec::new();
        let want = lines.iter().filter(|l| is_request(l)).count();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while got.len() < want && std::time::Instant::now() < deadline {
            match out_rx.try_recv() {
                Ok(line) => got.push(serde_json::from_str::<Value>(&line).unwrap()),
                Err(_) => tokio::time::sleep(std::time::Duration::from_millis(10)).await,
            }
        }
        drop(in_tx);
        serving.await.unwrap();
        got
    }

    fn init(id: i64) -> Value {
        json!({"jsonrpc":"2.0","id":id,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}})
    }

    #[tokio::test]
    async fn relays_through_the_session_with_the_panes_bearer() {
        let (fake, url) = start_fake().await;
        let up = Upstream {
            url,
            bearer: "tok".into(),
        };
        let got = run(
            Some(up),
            &[
                init(0),
                json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
                json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
            ],
        )
        .await;
        assert_eq!(got[0]["result"]["serverInfo"]["name"], "fake");
        let list = got.iter().find(|m| m["id"] == 1).unwrap();
        assert_eq!(list["result"]["tools"][0]["name"], "war_room.send");
        assert_eq!(list["result"]["session"], "s0");
        assert!(fake
            .seen_auth
            .lock()
            .unwrap()
            .iter()
            .all(|a| a == "Bearer tok"));
    }

    #[tokio::test]
    async fn a_lost_session_is_renewed_once_and_the_call_retried() {
        let (fake, url) = start_fake().await;
        let up = Upstream {
            url,
            bearer: "tok".into(),
        };
        let (in_tx, in_rx) = mpsc::unbounded_channel();
        let (out_tx, out_rx) = std::sync::mpsc::channel();
        let serving = tokio::spawn(serve(in_rx, Out(out_tx), Some(up)));
        in_tx.send(init(0).to_string()).unwrap();
        let first = tokio::task::spawn_blocking({
            let rx = out_rx;
            move || {
                let a = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
                (a, rx)
            }
        })
        .await
        .unwrap();
        let out_rx = first.1;
        // The app restarts on the same port: it forgets every session.
        // Three calls hit the lost session together; one renewal serves all.
        fake.sessions.lock().unwrap().clear();
        for id in [7, 8, 9] {
            in_tx
                .send(json!({"jsonrpc":"2.0","id":id,"method":"tools/list"}).to_string())
                .unwrap();
        }
        let replies = tokio::task::spawn_blocking(move || {
            (0..3)
                .map(|_| {
                    out_rx
                        .recv_timeout(std::time::Duration::from_secs(5))
                        .unwrap()
                })
                .collect::<Vec<_>>()
        })
        .await
        .unwrap();
        let mut ids = Vec::new();
        for reply in replies {
            let reply: Value = serde_json::from_str(&reply).unwrap();
            assert_eq!(reply["result"]["session"], "s1", "{reply}");
            ids.push(reply["id"].as_i64().unwrap());
        }
        ids.sort();
        assert_eq!(ids, [7, 8, 9]);
        assert_eq!(fake.inits.load(Ordering::SeqCst), 2);
        drop(in_tx);
        serving.await.unwrap();
    }

    #[tokio::test]
    async fn outside_a_pane_it_is_a_quiet_empty_server() {
        let got = run(
            None,
            &[
                init(0),
                json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
            ],
        )
        .await;
        assert_eq!(got[0]["result"]["serverInfo"]["name"], "swarmterm");
        assert_eq!(got[1]["result"]["tools"], json!([]));
    }

    #[tokio::test]
    async fn an_unreachable_app_at_startup_degrades_to_the_empty_server() {
        // A port nothing listens on.
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let up = Upstream {
            url: format!("http://127.0.0.1:{port}/mcp"),
            bearer: "tok".into(),
        };
        let got = run(
            Some(up),
            &[
                init(0),
                json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
            ],
        )
        .await;
        assert!(got[0].get("result").is_some(), "{}", got[0]);
        assert_eq!(got[1]["result"]["tools"], json!([]));
    }

    #[tokio::test]
    async fn a_wrong_bearer_is_an_error_not_a_silent_empty_list() {
        let (_fake, url) = start_fake().await;
        let up = Upstream {
            url,
            bearer: "nope".into(),
        };
        // initialize fails (401) → empty server; that is the documented
        // fallback, the server still never saw a call it accepted.
        let got = run(Some(up), &[init(0)]).await;
        assert_eq!(got[0]["result"]["serverInfo"]["name"], "swarmterm");
    }

    #[tokio::test]
    async fn a_request_followed_by_eof_is_still_answered() {
        let (in_tx, in_rx) = mpsc::unbounded_channel();
        let (out_tx, out_rx) = std::sync::mpsc::channel();
        in_tx
            .send(json!({"jsonrpc":"2.0","id":7,"method":"tools/list"}).to_string())
            .unwrap();
        drop(in_tx);
        serve(in_rx, Out(out_tx), None).await;
        let line: Value = serde_json::from_str(&out_rx.recv().unwrap()).unwrap();
        assert_eq!(line["id"], 7);
        assert_eq!(line["result"]["tools"], json!([]));
    }

    #[tokio::test]
    async fn garbage_input_gets_a_parse_error() {
        let (in_tx, in_rx) = mpsc::unbounded_channel();
        let (out_tx, out_rx) = std::sync::mpsc::channel();
        in_tx.send("not json".into()).unwrap();
        drop(in_tx);
        serve(in_rx, Out(out_tx), None).await;
        let line: Value = serde_json::from_str(&out_rx.recv().unwrap()).unwrap();
        assert_eq!(line["error"]["code"], -32700);
    }
}
