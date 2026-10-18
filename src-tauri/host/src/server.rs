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

/// A connection must say `hello` within this time.
const HELLO_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
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
    let mut chunk = vec![0u8; 64 * 1024];
    let mut client: Option<u64> = None;
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
                    Some(id) => client = Some(id),
                    None => break 'conn,
                },
                Some(cid) => dispatch(&host, cid, &tx, req),
            }
        }
        let read = async {
            if client.is_some() {
                rd.read(&mut chunk).await
            } else {
                tokio::time::timeout(HELLO_TIMEOUT, rd.read(&mut chunk))
                    .await
                    .unwrap_or(Ok(0))
            }
        };
        let n = tokio::select! {
            _ = stop.changed() => break,
            _ = closed.changed() => break,
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

/// First request of a connection. Returns the client id on success.
fn hello(
    host: &Host,
    token: &str,
    tx: &mpsc::UnboundedSender<Vec<u8>>,
    req: Request,
) -> Option<u64> {
    let reply = |b: Vec<u8>| {
        let _ = tx.send(frame::encode_json(&b));
    };
    let Op::Hello {
        token: offered,
        proto,
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
        }),
    ));
    Some(host.connect_client(tx.clone()))
}

fn dispatch(host: &Arc<Host>, client: u64, tx: &mpsc::UnboundedSender<Vec<u8>>, req: Request) {
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
        Op::Create(spec) => answer(
            host.create(client, spec)
                .map(|s| serde_json::to_value(s).expect("serialises")),
        ),
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
            let r = host.attach(client, &terminal_id, |spawn_id, replay, total| {
                frame::encode_json(&protocol::ok(
                    id,
                    json!({ "spawnId": spawn_id, "replayBytes": replay, "outputTotal": total }),
                ))
            });
            if let Err(reason) = r {
                answer(Err(reason));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
