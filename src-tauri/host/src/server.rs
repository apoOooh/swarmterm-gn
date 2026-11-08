//! Named-pipe endpoint of the host (ADR 0001, pattern of `voice/pipe.rs`).
//!
//! The pipe name is derived from the user SID and the data directory, and
//! the first instance is created with `first_pipe_instance`: that makes the
//! pipe itself the single-instance lock per user and app-id (dev and
//! installed app have different data dirs, so different hosts). The DACL
//! admits only the current user and remote clients are rejected; the token
//! in `host-endpoint.json` is the second factor, so a same-user process that
//! cannot read our app-data folder cannot drive the panes either.
//!
//! Each connection has a reader (this task, one request at a time, in order:
//! that is the keystroke FIFO) and a writer task fed by the engine's frame
//! channel, so answers, events and data never interleave mid-frame.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use tokio::sync::{mpsc, watch};

use crate::engine::Host;
use crate::frame::{self, Decoder, Frame};
use crate::protocol::{self, Op, Request};
use crate::security::CurrentUserOnly;

/// A connection must complete `hello` within this time after accept.
const HELLO_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
/// Frame limit before authentication; a `hello` is well under 1 KiB.
const HELLO_MAX_FRAME: usize = 4096;
/// One frame that cannot be written within this time means the client
/// stopped reading; it is dropped instead of buffering output forever.
const WRITE_DEADLINE: std::time::Duration = std::time::Duration::from_secs(5);
const BACKOFF_MIN: std::time::Duration = std::time::Duration::from_millis(100);
const BACKOFF_MAX: std::time::Duration = std::time::Duration::from_secs(5);

pub const ENDPOINT_FILE: &str = "host-endpoint.json";

/// Stable per user and data dir: FNV-1a over the lowercased path, because
/// Windows paths compare case-insensitively.
pub fn pipe_name(sid: &str, data_dir: &Path) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in data_dir.to_string_lossy().to_lowercase().bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!(r"\\.\pipe\swarmterm-host-{sid}-{h:016x}")
}

fn random_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// Constant-time compare: the token is the only secret on this channel.
fn token_eq(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

pub struct Endpoint {
    pub pipe: String,
    pub token: String,
    pub discovery: PathBuf,
}

fn create(name: &str, first: bool, sd: &CurrentUserOnly) -> std::io::Result<NamedPipeServer> {
    let mut opts = ServerOptions::new();
    opts.first_pipe_instance(first).reject_remote_clients(true);
    // SAFETY: `sd` owns a valid SECURITY_ATTRIBUTES for the whole call.
    unsafe { opts.create_with_security_attributes_raw(name, sd.attributes()) }
}

/// Bind the pipe, publish the discovery file and serve until `stop`. Must be
/// called inside a tokio runtime. Fails with `already-running` when another
/// host owns the name.
pub async fn run(
    host: Arc<Host>,
    data_dir: &Path,
    pipe: String,
    ready: Option<tokio::sync::oneshot::Sender<Endpoint>>,
    mut stop: watch::Receiver<bool>,
) -> Result<(), String> {
    std::fs::create_dir_all(data_dir).map_err(|e| format!("mkdir: {e}"))?;
    let sd = CurrentUserOnly::new()?;
    let first = create(&pipe, true, &sd).map_err(|e| {
        // ERROR_ACCESS_DENIED (5) / ERROR_PIPE_BUSY (231): the name exists.
        match e.raw_os_error() {
            Some(5) | Some(231) => "already-running".to_string(),
            _ => format!("create pipe: {e}"),
        }
    })?;
    let token = random_token();
    let discovery = data_dir.join(ENDPOINT_FILE);
    let body = json!({
        "version": protocol::VERSION,
        "pipe": pipe,
        "token": token,
        "pid": std::process::id(),
        "proto": protocol::PROTOS,
        "hostVersion": env!("CARGO_PKG_VERSION"),
    });
    let tmp = discovery.with_extension("json.tmp");
    std::fs::write(&tmp, body.to_string()).map_err(|e| format!("write discovery: {e}"))?;
    std::fs::rename(&tmp, &discovery).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename discovery: {e}")
    })?;
    if let Some(ready) = ready {
        let _ = ready.send(Endpoint {
            pipe: pipe.clone(),
            token: token.clone(),
            discovery: discovery.clone(),
        });
    }

    let mut server = first;
    let mut backoff = BACKOFF_MIN;
    let result = loop {
        let connected = tokio::select! {
            _ = stop.changed() => break Ok(()),
            res = server.connect() => res,
        };
        // Open the next instance before serving this one, so a reconnecting
        // app never finds the name missing.
        match (connected, create(&pipe, false, &sd)) {
            (Ok(()), Ok(next)) => {
                backoff = BACKOFF_MIN;
                let conn = std::mem::replace(&mut server, next);
                tokio::spawn(serve(host.clone(), token.clone(), conn, stop.clone()));
                continue;
            }
            (Err(e), Ok(next)) => {
                eprintln!("[host] connect: {e}");
                server = next;
            }
            (_, Err(e)) => eprintln!("[host] create pipe: {e}"),
        }
        tokio::select! {
            _ = stop.changed() => break Ok(()),
            _ = tokio::time::sleep(backoff) => {}
        }
        backoff = (backoff * 2).min(BACKOFF_MAX);
    };
    // Only remove the file if it is still ours; a successor host may have
    // replaced it already.
    if std::fs::read_to_string(&discovery).is_ok_and(|s| s.contains(&token)) {
        let _ = std::fs::remove_file(&discovery);
    }
    result
}

async fn serve(
    host: Arc<Host>,
    token: String,
    conn: NamedPipeServer,
    mut stop: watch::Receiver<bool>,
) {
    let (mut rd, mut wr) = tokio::io::split(conn);
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (closed_tx, mut closed) = watch::channel(false);
    tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            match tokio::time::timeout(WRITE_DEADLINE, wr.write_all(&frame)).await {
                Ok(Ok(())) => {}
                _ => break,
            }
        }
        let _ = closed_tx.send(true);
    });

    let mut dec = Decoder::default();
    // Until `hello` succeeds the peer is unauthenticated: one small frame,
    // and one deadline for the whole connection (not per read), so a
    // same-user process without the token cannot trickle bytes to keep a
    // connection open or make us buffer 16 MiB.
    dec.set_limit(HELLO_MAX_FRAME);
    let hello_deadline = tokio::time::Instant::now() + HELLO_TIMEOUT;
    let mut chunk = vec![0u8; 64 * 1024];
    let mut client: Option<u64> = None;
    // Creates of this connection still in flight (see `Op::Create`). Pruned
    // on every dispatch; when the connection drops, this list just goes away
    // with it: each create task holds only its own sender and finishes (and
    // answers into a closed `tx`, which is ignored) on its own, so nothing
    // leaks and the host's orphan rules handle the pane it spawned.
    let mut creates: Vec<PendingCreate> = Vec::new();
    // Resolves when a newer client replaced this one (see `Client::_kick`).
    let mut kicked: Option<tokio::sync::oneshot::Receiver<()>> = None;
    'conn: loop {
        loop {
            let frame = match dec.next_frame() {
                Ok(Some(f)) => f,
                Ok(None) => break,
                Err(e) => {
                    let reason = match e {
                        frame::FrameError::TooLarge => "too-large",
                        _ => "bad-request",
                    };
                    let _ = tx.send(frame::encode_json(&protocol::err(None, reason)));
                    break 'conn;
                }
            };
            let Frame::Json(payload) = frame else {
                let _ = tx.send(frame::encode_json(&protocol::err(None, "bad-request")));
                break 'conn;
            };
            let req = match protocol::parse(&payload) {
                Ok(r) => r,
                Err(e) => {
                    let _ = tx.send(frame::encode_json(&protocol::err(e.id, e.reason)));
                    if client.is_none() {
                        break 'conn;
                    }
                    continue;
                }
            };
            match client {
                None => match hello(&host, &token, &tx, req) {
                    Some((id, kick)) => {
                        client = Some(id);
                        kicked = Some(kick);
                        dec.set_limit(frame::MAX_FRAME);
                    }
                    None => break 'conn,
                },
                Some(cid) => dispatch(&host, cid, &tx, &mut creates, req).await,
            }
        }
        let read = async {
            if client.is_some() {
                rd.read(&mut chunk).await
            } else {
                tokio::time::timeout_at(hello_deadline, rd.read(&mut chunk))
                    .await
                    .unwrap_or(Ok(0))
            }
        };
        let replaced = async {
            match kicked.as_mut() {
                Some(k) => {
                    let _ = k.await;
                }
                None => std::future::pending::<()>().await,
            }
        };
        let n = tokio::select! {
            _ = stop.changed() => break,
            _ = closed.changed() => break,
            _ = replaced => break,
            r = read => match r {
                Ok(n) if n > 0 => n,
                _ => break,
            },
        };
        dec.feed(&chunk[..n]);
    }
    if let Some(cid) = client {
        host.disconnect_client(cid);
    }
}

/// First request of a connection. Returns the client id and its kick
/// receiver on success.
fn hello(
    host: &Host,
    token: &str,
    tx: &mpsc::UnboundedSender<Vec<u8>>,
    req: Request,
) -> Option<(u64, tokio::sync::oneshot::Receiver<()>)> {
    let reply = |b: Vec<u8>| {
        let _ = tx.send(frame::encode_json(&b));
    };
    let Op::Hello {
        token: offered,
        proto,
        capabilities,
    } = req.op
    else {
        reply(protocol::err(Some(req.id), "hello-required"));
        return None;
    };
    if !token_eq(&offered, token) {
        reply(protocol::err(Some(req.id), "unauthorized"));
        return None;
    }
    let Some(proto) = protocol::negotiate(&proto) else {
        reply(protocol::err(Some(req.id), "proto-mismatch"));
        return None;
    };
    // The answer goes out before the client is registered, so no event can
    // precede it on this connection.
    reply(protocol::ok(
        req.id,
        json!({
            "proto": proto,
            "capabilities": protocol::CAPABILITIES,
            "hostVersion": env!("CARGO_PKG_VERSION"),
            "pid": std::process::id(),
            "appState": host.app_state(),
        }),
    ));
    let flow_control = capabilities.iter().any(|c| c == protocol::FLOW_CONTROL);
    Some(host.connect_client_kickable(tx.clone(), flow_control))
}

/// Creates in flight across all connections (see `Op::Create`).
const MAX_CREATES_IN_FLIGHT: usize = 6;

fn create_permits() -> Arc<tokio::sync::Semaphore> {
    static PERMITS: std::sync::OnceLock<Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
    PERMITS
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(MAX_CREATES_IN_FLIGHT)))
        .clone()
}

/// A create still running in its own task. `done` closes (its sender is
/// dropped) when the task ends, however it ends; a receiver is cheap to clone,
/// so a deferred `list` can wait on it without owning the task.
struct PendingCreate {
    terminal_id: String,
    done: watch::Receiver<()>,
}

impl PendingCreate {
    fn finished(&self) -> bool {
        self.done.has_changed().is_err()
    }
}

async fn wait_done(mut done: watch::Receiver<()>) {
    // Never sent on, so this returns only once the sender is dropped.
    while done.changed().await.is_ok() {}
}

/// Requests of one connection run strictly in order (the keystroke FIFO), so
/// this is awaited by the reader. `create` (openpty + process spawn, tens of
/// ms) runs in its own task on the blocking pool, so it never holds back the
/// other panes' requests on this connection.
async fn dispatch(
    host: &Arc<Host>,
    client: u64,
    tx: &mpsc::UnboundedSender<Vec<u8>>,
    creates: &mut Vec<PendingCreate>,
    req: Request,
) {
    // Ops that must observe a pending create wait only for what they need,
    // never inline for unrelated panes (one slow create would otherwise stall
    // every pane's acks, writes and resizes until the flow timeout):
    // `kill`/`attach` wait inline for creates of the SAME id, including their
    // wait for a create permit (the kill must find the pane it names), and `list` (feeds `reap_orphans`, which must see a
    // create whose answer timed out) answers from its own task once every
    // create pending now has finished.
    creates.retain(|c| !c.finished());
    match &req.op {
        Op::Kill { terminal_id } | Op::Attach { terminal_id } => {
            let same: Vec<_> = creates
                .iter()
                .filter(|c| &c.terminal_id == terminal_id)
                .map(|c| c.done.clone())
                .collect();
            for d in same {
                wait_done(d).await;
            }
        }
        Op::List if !creates.is_empty() => {
            let pending: Vec<_> = creates.iter().map(|c| c.done.clone()).collect();
            // The answer may go out after LATER requests ran, so it must not
            // show panes created after this `list` (the app's reap could
            // kill one it has not registered yet): only what exists now plus
            // the creates pending now.
            let mut allowed: std::collections::HashSet<String> =
                creates.iter().map(|c| c.terminal_id.clone()).collect();
            let (h, tx, id) = (host.clone(), tx.clone(), req.id);
            allowed.extend(h.list().into_iter().map(|t| t.terminal_id));
            tokio::spawn(async move {
                for d in pending {
                    wait_done(d).await;
                }
                let terminals: Vec<_> = h
                    .list()
                    .into_iter()
                    .filter(|t| allowed.contains(&t.terminal_id))
                    .collect();
                let body = protocol::ok(id, json!({ "terminals": terminals }));
                let _ = tx.send(frame::encode_json(&body));
            });
            return;
        }
        _ => {}
    }
    let id = req.id;
    let answer = |r: Result<serde_json::Value, String>| {
        let body = match r {
            Ok(v) => protocol::ok(id, v),
            Err(reason) => protocol::err(Some(id), &reason),
        };
        let _ = tx.send(frame::encode_json(&body));
    };
    match req.op {
        Op::Hello { .. } => answer(Err("already-hello".into())),
        Op::Create(spec) => {
            // Answered from its own task: a create (openpty + process spawn,
            // tens of ms) must not hold back the connection's other requests
            // — keystrokes, acks and resizes of every other pane. Requests
            // for the pane being created cannot overtake it: the app only
            // addresses a pane after its `spawned` event, which `create`
            // sends once the entry is in the map. Capped so a workspace
            // restore cannot fork dozens of shells at once.
            let h = host.clone();
            let tx = tx.clone();
            let permits = create_permits();
            let (done_tx, done) = watch::channel(());
            creates.push(PendingCreate {
                terminal_id: spec.terminal_id.clone(),
                done,
            });
            tokio::spawn(async move {
                let _done = done_tx;
                // Never closed, so this cannot fail. The app's create timeout
                // (10 s) also covers the wait here; at tens of ms per create
                // that leaves room for well over a hundred queued panes.
                let _permit = permits.acquire_owned().await.ok();
                let r = tokio::task::spawn_blocking(move || h.create(client, spec))
                    .await
                    .unwrap_or_else(|_| Err("spawn-failed: panic".into()));
                let body = match r {
                    Ok(s) => protocol::ok(id, serde_json::to_value(s).expect("serialises")),
                    Err(reason) => protocol::err(Some(id), &reason),
                };
                let _ = tx.send(frame::encode_json(&body));
            });
        }
        Op::Write { terminal_id, data } => {
            answer(host.write(&terminal_id, data.as_bytes()).map(|_| json!({})))
        }
        Op::WriteChecked {
            terminal_id,
            spawn_id,
            data,
        } => answer(
            host.write_checked(&terminal_id, &spawn_id, data.as_bytes())
                .map(|_| json!({})),
        ),
        Op::Resize {
            terminal_id,
            cols,
            rows,
        } => answer(host.resize(&terminal_id, cols, rows).map(|_| json!({}))),
        Op::Kill { terminal_id } => {
            // The grace thread runs on; the answer only means "id is free".
            drop(host.kill(&terminal_id));
            answer(Ok(json!({})));
        }
        Op::List => answer(Ok(json!({ "terminals": host.list() }))),
        Op::Attach { terminal_id } => {
            let r = host.attach(client, &terminal_id, |facts| {
                frame::encode_json(&protocol::ok(
                    id,
                    serde_json::to_value(facts).expect("serialises"),
                ))
            });
            if let Err(reason) = r {
                answer(Err(reason));
            }
        }
        Op::Ack {
            terminal_id,
            spawn_id,
            bytes,
        } => host.ack(client, &terminal_id, &spawn_id, bytes),
        Op::SetPriority { settings } => {
            host.set_priority(settings);
            answer(Ok(json!({})));
        }
        Op::SetAppState { state } => {
            let size = serde_json::to_vec(&state).map_or(usize::MAX, |b| b.len());
            if size > protocol::MAX_APP_STATE {
                answer(Err("too-large".into()));
            } else {
                host.set_app_state(state);
                answer(Ok(json!({})));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn pending_create_finishes_when_its_task_ends() {
        let (done_tx, done) = watch::channel(());
        let p = PendingCreate {
            terminal_id: "t".into(),
            done,
        };
        assert!(!p.finished());
        let waiter = tokio::spawn(wait_done(p.done.clone()));
        drop(done_tx);
        tokio::time::timeout(std::time::Duration::from_secs(1), waiter)
            .await
            .expect("wait_done returns once the create ends")
            .unwrap();
        assert!(p.finished());
    }

    /// The dropped-connection case: the connection's list goes away, the
    /// create task still runs to its end and its answer into the closed
    /// channel is ignored, without panicking.
    #[tokio::test]
    async fn a_create_outlives_its_dropped_connection() {
        let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let (done_tx, done) = watch::channel(());
        let creates = vec![PendingCreate {
            terminal_id: "t".into(),
            done: done.clone(),
        }];
        drop(creates);
        drop(rx);
        let task = tokio::spawn(async move {
            let _done = done_tx;
            let _ = tx.send(vec![1]);
        });
        task.await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), wait_done(done))
            .await
            .unwrap();
    }

    #[test]
    fn pipe_name_is_stable_and_case_insensitive() {
        let a = pipe_name("S-1-5-21-1", Path::new(r"C:\Users\x\AppData\Local\app"));
        let b = pipe_name("S-1-5-21-1", Path::new(r"c:\users\X\appdata\local\APP"));
        assert_eq!(a, b);
        assert!(a.starts_with(r"\\.\pipe\swarmterm-host-S-1-5-21-1-"));
    }

    #[test]
    fn pipe_name_differs_per_data_dir_and_user() {
        let dev = pipe_name("S-1", Path::new(r"C:\a\com.x.dev"));
        let rel = pipe_name("S-1", Path::new(r"C:\a\com.x"));
        let other = pipe_name("S-2", Path::new(r"C:\a\com.x"));
        assert_ne!(dev, rel);
        assert_ne!(rel, other);
    }

    #[test]
    fn token_compare() {
        assert!(token_eq("abc", "abc"));
        assert!(!token_eq("abc", "abd"));
        assert!(!token_eq("abc", "abcd"));
    }
}
