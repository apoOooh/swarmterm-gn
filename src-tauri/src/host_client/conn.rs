//! One connection to `swarmterm-host` (SWA-55, ADR 0001): hello, requests,
//! events and data frames over the current-user named pipe. Tauri-free so
//! it is tested against an in-process host.
//!
//! Ordering is the whole point of this type. Every call only *enqueues* a
//! frame for the single writer task, so callers can hold the app's
//! `terminals` lock while sending: keystrokes keep the order they were
//! enqueued in (the host reads one request at a time), and a
//! `write_checked` enqueued under that lock cannot be overtaken by a respawn.
//! Incoming frames are handled one by one on the reader task, so the host's
//! guarantees (`spawned` before data, data before `exit`) reach the sink in
//! the same order.
//!
//! Writes are fire-and-forget like `PtyInput::send` in-process: the answer
//! only matters when it reports `input-queue-full`, which goes to the sink
//! (the renderer's bell) instead of the long-gone `write_terminal` caller.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use swarmterm_host::frame::{self, Decoder, Frame};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::windows::named_pipe::ClientOptions;
use tokio::sync::mpsc;

/// Same budget as the host's writer: a peer that stops reading for this long
/// is treated as gone.
const WRITE_DEADLINE: Duration = Duration::from_secs(5);
/// Default wait for a request answer (`create`, `list`).
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const PROTO: &[u32] = &[1];

/// What the app does with host traffic. Called on the reader task, one frame
/// at a time; implementations must not block for long.
pub trait Sink: Send + Sync {
    fn spawned(&self, terminal_id: &str, spawn_id: &str, pid: Option<u32>);
    /// An `attach` was answered (`facts` = the answer: spawnId, pid, cols,
    /// rows, replayBytes, outputTotal, truncated). Called on the reader task
    /// before the replay frame is handled, so routing can be bound for it.
    fn attached(&self, terminal_id: &str, facts: &Value);
    fn data(&self, terminal_id: &str, spawn_id: &str, bytes: &[u8]);
    fn removed(&self, terminal_id: &str, spawn_id: &str);
    fn exit(&self, terminal_id: &str, spawn_id: &str, exit_code: i32);
    fn input_dropped(&self, terminal_id: &str);
    /// The connection ended; called once, after every pending call failed.
    fn lost(&self);
}

enum Waiter {
    Reply(std::sync::mpsc::Sender<Result<Value, String>>),
    /// A keystroke write: only `input-queue-full` is worth reporting.
    Write(String),
    /// `attach`: the sink hears of the answer on the reader task first.
    Attach(String, std::sync::mpsc::Sender<Result<Value, String>>),
    Ignore,
}

pub struct Conn {
    tx: mpsc::UnboundedSender<Vec<u8>>,
    next_id: AtomicU64,
    waiters: Arc<Mutex<HashMap<u64, Waiter>>>,
    alive: Arc<AtomicBool>,
    pub host_version: String,
    /// What an earlier app instance stored with `set_app_state`, as of hello.
    pub app_state: Value,
}

impl Conn {
    /// Open the pipe and say hello. Must run inside a tokio runtime.
    pub async fn connect(
        pipe: &str,
        token: &str,
        sink: Arc<dyn Sink>,
    ) -> Result<Arc<Conn>, String> {
        let pipe_handle = open(pipe).await?;
        let (mut rd, mut wr) = tokio::io::split(pipe_handle);
        let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let alive = Arc::new(AtomicBool::new(true));
        let waiters: Arc<Mutex<HashMap<u64, Waiter>>> = Arc::default();

        let writer_alive = alive.clone();
        tokio::spawn(async move {
            while let Some(frame) = rx.recv().await {
                match tokio::time::timeout(WRITE_DEADLINE, wr.write_all(&frame)).await {
                    Ok(Ok(())) => {}
                    _ => break,
                }
            }
            writer_alive.store(false, Ordering::Release);
        });

        // Hello is the first frame on the wire and its answer the first
        // frame back (the host registers the client only after answering),
        // so it is read inline before the reader task takes over.
        let hello = request_frame(0, json!({"op": "hello", "token": token, "proto": PROTO}));
        tx.send(hello).map_err(|_| "host-lost".to_string())?;
        let mut dec = Decoder::default();
        let mut chunk = vec![0u8; 64 * 1024];
        let answer = loop {
            if let Some(f) = dec.next_frame().map_err(|e| format!("bad frame: {e:?}"))? {
                break f;
            }
            let n = tokio::time::timeout(REQUEST_TIMEOUT, rd.read(&mut chunk))
                .await
                .map_err(|_| "hello timed out".to_string())?
                .map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("host closed the connection".into());
            }
            dec.feed(&chunk[..n]);
        };
        let Frame::Json(payload) = answer else {
            return Err("unexpected data before hello".into());
        };
        let v: Value = serde_json::from_slice(&payload).map_err(|e| e.to_string())?;
        if v.get("ok") != Some(&Value::Bool(true)) {
            return Err(reason(&v));
        }
        let host_version = v
            .get("hostVersion")
            .and_then(Value::as_str)
            .unwrap_or("?")
            .to_string();
        let app_state = v.get("appState").cloned().unwrap_or(Value::Null);

        let conn = Arc::new(Conn {
            tx,
            next_id: AtomicU64::new(1),
            waiters: waiters.clone(),
            alive: alive.clone(),
            host_version,
            app_state,
        });
        tokio::spawn(async move {
            'read: loop {
                loop {
                    match dec.next_frame() {
                        Ok(Some(f)) => handle(&waiters, sink.as_ref(), f),
                        Ok(None) => break,
                        Err(_) => break 'read,
                    }
                }
                match rd.read(&mut chunk).await {
                    Ok(n) if n > 0 => dec.feed(&chunk[..n]),
                    _ => break,
                }
            }
            alive.store(false, Ordering::Release);
            // Fail every caller still waiting, then let the app end the panes.
            let pending: Vec<Waiter> = waiters.lock().unwrap().drain().map(|(_, w)| w).collect();
            for w in pending {
                if let Waiter::Reply(tx) | Waiter::Attach(_, tx) = w {
                    let _ = tx.send(Err("host-lost".into()));
                }
            }
            sink.lost();
        });
        Ok(conn)
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    fn enqueue(&self, op: Value, waiter: Waiter) -> Result<u64, String> {
        if !self.is_alive() {
            return Err("target-gone".into());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.waiters.lock().unwrap().insert(id, waiter);
        if self.tx.send(request_frame(id, op)).is_err() {
            self.waiters.lock().unwrap().remove(&id);
            return Err("target-gone".into());
        }
        Ok(id)
    }

    /// Send and wait for the answer. Blocking: never call it on an async
    /// task (the answer arrives on one).
    pub fn request(&self, op: Value, timeout: Duration) -> Result<Value, String> {
        let (tx, rx) = std::sync::mpsc::channel();
        let id = self.enqueue(op, Waiter::Reply(tx))?;
        match rx.recv_timeout(timeout) {
            Ok(r) => r,
            Err(_) => {
                self.waiters.lock().unwrap().remove(&id);
                Err("host-timeout".into())
            }
        }
    }

    /// Take over a pane an earlier connection created. Blocking like
    /// `request`; on success the sink's `attached` already ran.
    pub fn attach(&self, terminal_id: &str, timeout: Duration) -> Result<Value, String> {
        let (tx, rx) = std::sync::mpsc::channel();
        let op = json!({"op": "attach", "terminalId": terminal_id});
        let id = self.enqueue(op, Waiter::Attach(terminal_id.to_string(), tx))?;
        match rx.recv_timeout(timeout) {
            Ok(r) => r,
            Err(_) => {
                self.waiters.lock().unwrap().remove(&id);
                Err("host-timeout".into())
            }
        }
    }

    /// The host's panes (`TerminalInfo` objects).
    pub fn list(&self, timeout: Duration) -> Result<Vec<Value>, String> {
        let listed = self.request(json!({"op": "list"}), timeout)?;
        Ok(listed["terminals"].as_array().cloned().unwrap_or_default())
    }

    /// Fire and forget: a host without `app-state` answers `unknown-op`.
    pub fn set_app_state(&self, state: Value) {
        let _ = self.enqueue(
            json!({"op": "set_app_state", "state": state}),
            Waiter::Ignore,
        );
    }

    pub fn write(&self, terminal_id: &str, data: &[u8]) -> Result<(), String> {
        let op = json!({"op": "write", "terminalId": terminal_id, "data": lossy(data)});
        self.enqueue(op, Waiter::Write(terminal_id.to_string()))
            .map(|_| ())
    }

    /// The host re-checks the generation when it dequeues; the app checked
    /// it under its own lock already (see `commands::write_terminal_checked`).
    pub fn write_checked(
        &self,
        terminal_id: &str,
        spawn_id: &str,
        data: &[u8],
    ) -> Result<(), String> {
        let op = json!({
            "op": "write_checked", "terminalId": terminal_id,
            "spawnId": spawn_id, "data": lossy(data),
        });
        self.enqueue(op, Waiter::Write(terminal_id.to_string()))
            .map(|_| ())
    }

    pub fn resize(&self, terminal_id: &str, cols: u16, rows: u16) {
        let op = json!({"op": "resize", "terminalId": terminal_id, "cols": cols, "rows": rows});
        let _ = self.enqueue(op, Waiter::Ignore);
    }

    pub fn kill(&self, terminal_id: &str) {
        let _ = self.enqueue(
            json!({"op": "kill", "terminalId": terminal_id}),
            Waiter::Ignore,
        );
    }

    /// Wait until the host processed everything enqueued so far (requests
    /// are handled in order, so the answer to `list` comes after them).
    /// Quit uses it so its `kill`s are not lost when the app exits.
    pub fn flush(&self, timeout: Duration) -> Result<(), String> {
        self.request(json!({"op": "list"}), timeout).map(|_| ())
    }

    /// Close every host pane the app does not track (`keep` = false). Until
    /// phase 3 can reattach, such a pane runs invisibly: a `create` whose
    /// answer timed out, or the panes of a connection the app lost while
    /// the host lived on. Left alone they would also keep the host from
    /// ever idling out. Returns how many were closed.
    pub fn reap_orphans(
        &self,
        keep: impl Fn(&str) -> bool,
        timeout: Duration,
    ) -> Result<usize, String> {
        let listed = self.request(json!({"op": "list"}), timeout)?;
        let orphans: Vec<String> = listed["terminals"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|t| t["terminalId"].as_str())
            .filter(|id| !keep(id))
            .map(str::to_string)
            .collect();
        for id in &orphans {
            self.kill(id);
        }
        Ok(orphans.len())
    }
}

/// Input arrives from the renderer as a `String` and only becomes bytes for
/// the shared `ManagedTerminal` API, so this never actually replaces anything.
fn lossy(data: &[u8]) -> String {
    String::from_utf8_lossy(data).into_owned()
}

fn request_frame(id: u64, op: Value) -> Vec<u8> {
    let mut v = op;
    if let Some(obj) = v.as_object_mut() {
        obj.insert("v".into(), 1.into());
        obj.insert("id".into(), id.into());
    }
    frame::encode_json(v.to_string().as_bytes())
}

fn reason(v: &Value) -> String {
    v.get("reason")
        .and_then(Value::as_str)
        .unwrap_or("host-error")
        .to_string()
}

async fn open(pipe: &str) -> Result<tokio::net::windows::named_pipe::NamedPipeClient, String> {
    // ERROR_PIPE_BUSY: every instance is taken for a moment (the host opens
    // the next one right after a connect); retry briefly.
    for _ in 0..50 {
        match ClientOptions::new().open(pipe) {
            Ok(c) => return Ok(c),
            Err(e) if e.raw_os_error() == Some(231) => {
                tokio::time::sleep(Duration::from_millis(20)).await
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("host pipe busy".into())
}

fn handle(waiters: &Mutex<HashMap<u64, Waiter>>, sink: &dyn Sink, f: Frame) {
    let payload = match f {
        Frame::Data {
            terminal_id,
            spawn_id,
            bytes,
        } => return sink.data(&terminal_id, &spawn_id, &bytes),
        Frame::Json(p) => p,
    };
    let Ok(v) = serde_json::from_slice::<Value>(&payload) else {
        return;
    };
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("");
    if let Some(event) = v.get("event").and_then(Value::as_str) {
        match event {
            "spawned" => sink.spawned(
                s("terminalId"),
                s("spawnId"),
                v.get("pid").and_then(Value::as_u64).map(|p| p as u32),
            ),
            "removed" => sink.removed(s("terminalId"), s("spawnId")),
            "exit" => sink.exit(
                s("terminalId"),
                s("spawnId"),
                v.get("exitCode").and_then(Value::as_i64).unwrap_or(-1) as i32,
            ),
            _ => {}
        }
        return;
    }
    let Some(id) = v.get("id").and_then(Value::as_u64) else {
        return;
    };
    let Some(waiter) = waiters.lock().unwrap().remove(&id) else {
        return;
    };
    let ok = v.get("ok") == Some(&Value::Bool(true));
    match waiter {
        Waiter::Reply(tx) => {
            let _ = tx.send(if ok { Ok(v) } else { Err(reason(&v)) });
        }
        Waiter::Attach(terminal_id, tx) => {
            if ok {
                sink.attached(&terminal_id, &v);
            }
            let _ = tx.send(if ok { Ok(v) } else { Err(reason(&v)) });
        }
        Waiter::Write(terminal_id) if !ok && reason(&v) == "input-queue-full" => {
            sink.input_dropped(&terminal_id)
        }
        Waiter::Write(_) | Waiter::Ignore => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Recorder {
        events: Mutex<Vec<String>>,
        lost: AtomicBool,
    }

    impl Sink for Recorder {
        fn spawned(&self, id: &str, spawn: &str, _pid: Option<u32>) {
            self.events
                .lock()
                .unwrap()
                .push(format!("spawned {id} {spawn}"));
        }
        fn attached(&self, id: &str, facts: &Value) {
            self.events.lock().unwrap().push(format!(
                "attached {id} {}",
                facts["spawnId"].as_str().unwrap_or("")
            ));
        }
        fn data(&self, id: &str, spawn: &str, bytes: &[u8]) {
            self.events.lock().unwrap().push(format!(
                "data {id} {spawn} {}",
                String::from_utf8_lossy(bytes)
            ));
        }
        fn removed(&self, id: &str, spawn: &str) {
            self.events
                .lock()
                .unwrap()
                .push(format!("removed {id} {spawn}"));
        }
        fn exit(&self, id: &str, spawn: &str, code: i32) {
            self.events
                .lock()
                .unwrap()
                .push(format!("exit {id} {spawn} {code}"));
        }
        fn input_dropped(&self, id: &str) {
            self.events.lock().unwrap().push(format!("dropped {id}"));
        }
        fn lost(&self) {
            self.lost.store(true, Ordering::Release);
        }
    }

    struct TestHost {
        rt: tokio::runtime::Runtime,
        pipe: String,
        token: String,
        stop: tokio::sync::watch::Sender<bool>,
        _dir: tempfile::TempDir,
    }

    fn start_host() -> TestHost {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let pipe = format!(
            r"\\.\pipe\swarmterm-host-test-{}",
            uuid::Uuid::new_v4().simple()
        );
        let host = swarmterm_host::engine::Host::new(64 * 1024);
        let (stop, stop_rx) = tokio::sync::watch::channel(false);
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let data_dir = dir.path().to_path_buf();
        let p = pipe.clone();
        rt.spawn(async move {
            let _ = swarmterm_host::server::run(host, &data_dir, p, Some(ready_tx), stop_rx).await;
        });
        let ep = rt.block_on(ready_rx).unwrap();
        TestHost {
            rt,
            pipe,
            token: ep.token,
            stop,
            _dir: dir,
        }
    }

    fn connect(h: &TestHost, sink: Arc<Recorder>) -> Arc<Conn> {
        h.rt.block_on(Conn::connect(&h.pipe, &h.token, sink))
            .unwrap()
    }

    fn cmd_spec(id: &str) -> Value {
        let env: serde_json::Map<String, Value> = crate::terminal_env::EnvPlan::inherited()
            .into_map()
            .into_iter()
            .map(|(k, v)| (k, Value::String(v)))
            .collect();
        json!({
            "op": "create", "terminalId": id, "shell": "cmd.exe", "args": ["/d", "/q"],
            "env": env, "cwd": std::env::temp_dir().to_string_lossy(), "cols": 80, "rows": 24,
        })
    }

    fn wait_for(rec: &Recorder, what: impl Fn(&[String]) -> bool) {
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while std::time::Instant::now() < deadline {
            if what(&rec.events.lock().unwrap()) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("timed out; events: {:?}", rec.events.lock().unwrap());
    }

    #[test]
    fn wrong_token_is_refused() {
        let h = start_host();
        let r = h.rt.block_on(Conn::connect(
            &h.pipe,
            "nope",
            Arc::new(Recorder::default()),
        ));
        assert_eq!(r.err().as_deref(), Some("unauthorized"));
        let _ = h.stop.send(true);
    }

    #[test]
    fn create_write_kill_reaches_the_sink_in_order() {
        let h = start_host();
        let rec = Arc::new(Recorder::default());
        let conn = connect(&h, rec.clone());
        let answer = conn.request(cmd_spec("t1"), REQUEST_TIMEOUT).unwrap();
        let spawn = answer["spawnId"].as_str().unwrap().to_string();
        assert_eq!(rec.events.lock().unwrap()[0], format!("spawned t1 {spawn}"));
        conn.write("t1", b"echo marker-55\r").unwrap();
        wait_for(&rec, |ev| {
            ev.iter()
                .any(|e| e.starts_with("data") && e.contains("marker-55"))
        });
        conn.kill("t1");
        wait_for(&rec, |ev| ev.iter().any(|e| e.starts_with("exit t1")));
        let ev = rec.events.lock().unwrap().clone();
        let removed = ev.iter().position(|e| e.starts_with("removed t1")).unwrap();
        let exit = ev.iter().position(|e| e.starts_with("exit t1")).unwrap();
        assert!(removed < exit, "{ev:?}");
        assert!(
            ev[exit + 1..].iter().all(|e| !e.starts_with("data t1")),
            "no data after exit: {ev:?}"
        );
        let _ = h.stop.send(true);
    }

    #[test]
    fn duplicate_create_is_refused_by_the_host() {
        let h = start_host();
        let conn = connect(&h, Arc::new(Recorder::default()));
        conn.request(cmd_spec("dup"), REQUEST_TIMEOUT).unwrap();
        assert_eq!(
            conn.request(cmd_spec("dup"), REQUEST_TIMEOUT)
                .err()
                .as_deref(),
            Some("exists")
        );
        conn.kill("dup");
        conn.flush(REQUEST_TIMEOUT).unwrap();
        let _ = h.stop.send(true);
    }

    fn listed(conn: &Conn) -> usize {
        conn.request(json!({"op": "list"}), REQUEST_TIMEOUT)
            .unwrap()["terminals"]
            .as_array()
            .map_or(0, Vec::len)
    }

    #[test]
    fn a_timed_out_create_is_reaped() {
        let h = start_host();
        let conn = connect(&h, Arc::new(Recorder::default()));
        // The answer comes too late for us, but the host spawns anyway.
        assert_eq!(
            conn.request(cmd_spec("late"), Duration::ZERO)
                .err()
                .as_deref(),
            Some("host-timeout")
        );
        assert_eq!(conn.reap_orphans(|_| false, REQUEST_TIMEOUT), Ok(1));
        assert_eq!(listed(&conn), 0);
        let _ = h.stop.send(true);
    }

    #[test]
    fn panes_of_a_lost_connection_are_reaped_by_the_next_one() {
        let h = start_host();
        let first = connect(&h, Arc::new(Recorder::default()));
        first.request(cmd_spec("kept"), REQUEST_TIMEOUT).unwrap();
        first.request(cmd_spec("gone"), REQUEST_TIMEOUT).unwrap();
        let second = connect(&h, Arc::new(Recorder::default()));
        assert_eq!(
            second.reap_orphans(|id| id == "kept", REQUEST_TIMEOUT),
            Ok(1)
        );
        assert_eq!(listed(&second), 1);
        assert_eq!(second.reap_orphans(|_| false, REQUEST_TIMEOUT), Ok(1));
        assert_eq!(listed(&second), 0);
        let _ = h.stop.send(true);
    }

    #[test]
    fn attach_binds_routing_before_the_replay_arrives() {
        let h = start_host();
        let first = connect(&h, Arc::new(Recorder::default()));
        let mut spec = cmd_spec("re");
        spec["initialInput"] = json!("echo before-56\r");
        let spawn = first.request(spec, REQUEST_TIMEOUT).unwrap()["spawnId"]
            .as_str()
            .unwrap()
            .to_string();
        first.set_app_state(json!({"mcpPort": 4711}));
        // Give the shell time to print, so the replay has the marker.
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while first.list(REQUEST_TIMEOUT).unwrap()[0]["outputTotal"].as_u64() < Some(40)
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(50));
        }

        let rec = Arc::new(Recorder::default());
        let second = connect(&h, rec.clone());
        assert_eq!(second.app_state, json!({"mcpPort": 4711}));
        let listed = second.list(REQUEST_TIMEOUT).unwrap();
        assert_eq!(listed[0]["terminalId"], "re");
        assert_eq!(
            (listed[0]["cols"].as_u64(), listed[0]["rows"].as_u64()),
            (Some(80), Some(24))
        );
        let facts = second.attach("re", REQUEST_TIMEOUT).unwrap();
        assert_eq!(facts["spawnId"], spawn.as_str());
        wait_for(&rec, |ev| ev.iter().any(|e| e.contains("before-56")));
        let ev = rec.events.lock().unwrap().clone();
        assert_eq!(ev[0], format!("attached re {spawn}"), "{ev:?}");
        assert!(ev[1].starts_with(&format!("data re {spawn}")), "{ev:?}");
        assert_eq!(
            second.attach("none", REQUEST_TIMEOUT).err().as_deref(),
            Some("target-gone")
        );
        second.kill("re");
        second.flush(REQUEST_TIMEOUT).unwrap();
        let _ = h.stop.send(true);
    }

    #[test]
    fn a_host_that_goes_away_is_reported_once() {
        let h = start_host();
        let rec = Arc::new(Recorder::default());
        let conn = connect(&h, rec.clone());
        // A second client replaces us (the host keeps one client at a time).
        let _other = connect(&h, Arc::new(Recorder::default()));
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !rec.lost.load(Ordering::Acquire) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(rec.lost.load(Ordering::Acquire));
        assert!(!conn.is_alive());
        assert_eq!(conn.write("x", b"y").err().as_deref(), Some("target-gone"));
        assert_eq!(
            conn.request(json!({"op": "list"}), REQUEST_TIMEOUT)
                .err()
                .as_deref(),
            Some("target-gone")
        );
        let _ = h.stop.send(true);
    }

    /// ADR 0001 budget: the extra pipe hop for a keystroke stays under 1 ms
    /// at p99. Measured as request → answer round trip on a `write` (to an
    /// unknown pane, so the host's PTY write is not part of it: that cost is
    /// the same in-process). Run with `--ignored --nocapture` for numbers;
    /// the assert is a loose bound so a loaded CI runner cannot flake it.
    #[test]
    #[ignore]
    fn keystroke_hop_latency() {
        let h = start_host();
        let conn = connect(&h, Arc::new(Recorder::default()));
        let op = json!({"op": "write", "terminalId": "none", "data": "x"});
        for _ in 0..200 {
            let _ = conn.request(op.clone(), REQUEST_TIMEOUT);
        }
        let mut samples: Vec<Duration> = (0..5000)
            .map(|_| {
                let t = std::time::Instant::now();
                let _ = conn.request(op.clone(), REQUEST_TIMEOUT);
                t.elapsed()
            })
            .collect();
        samples.sort();
        let pct = |p: f64| samples[((samples.len() as f64 * p) as usize).min(samples.len() - 1)];
        println!(
            "host hop round trip: p50 {:?}, p99 {:?}, max {:?}",
            pct(0.50),
            pct(0.99),
            samples.last().unwrap()
        );
        assert!(pct(0.99) < Duration::from_millis(20));
        let _ = h.stop.send(true);
    }
}
