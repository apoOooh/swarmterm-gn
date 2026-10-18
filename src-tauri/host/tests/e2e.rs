//! End-to-end checks against real ConPTY shells (Windows only, like the fork).
#![cfg(windows)]

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use swarmterm_host::engine::Host;
use swarmterm_host::frame::{self, Decoder, Frame};
use swarmterm_host::protocol::CreateSpec;
use tokio::sync::mpsc::UnboundedReceiver;

const WAIT: Duration = Duration::from_secs(20);

fn spec(id: &str, args: &[&str]) -> CreateSpec {
    CreateSpec {
        terminal_id: id.into(),
        shell: "cmd.exe".into(),
        args: args.iter().map(|s| s.to_string()).collect(),
        env: std::env::vars().collect(),
        cwd: std::env::temp_dir().to_string_lossy().into_owned(),
        cols: 120,
        rows: 30,
        initial_input: None,
        meta: json!({"agent": null}),
    }
}

/// Collects frames from the client channel and decodes them.
struct Inbox {
    rx: UnboundedReceiver<Vec<u8>>,
    dec: Decoder,
    data: String,
    /// (spawn id, text) per data frame, in arrival order.
    chunks: Vec<(String, String)>,
    events: Vec<Value>,
}

impl Inbox {
    fn new(rx: UnboundedReceiver<Vec<u8>>) -> Self {
        Inbox {
            rx,
            dec: Decoder::default(),
            data: String::new(),
            chunks: Vec::new(),
            events: Vec::new(),
        }
    }

    fn pump(&mut self, deadline: Instant) -> bool {
        while let Ok(bytes) = self.rx.try_recv() {
            self.dec.feed(&bytes);
            while let Some(f) = self.dec.next_frame().unwrap() {
                match f {
                    Frame::Json(p) => self.events.push(serde_json::from_slice(&p).unwrap()),
                    Frame::Data {
                        spawn_id, bytes, ..
                    } => {
                        // Every data frame must be whole UTF-8 (flusher rule).
                        let text = std::str::from_utf8(&bytes).unwrap().to_string();
                        self.data.push_str(&text);
                        self.chunks.push((spawn_id, text));
                        self.events.push(json!({"data": true}));
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(10));
        Instant::now() < deadline
    }

    fn wait_for(&mut self, what: &str, pred: impl Fn(&Self) -> bool) {
        let deadline = Instant::now() + WAIT;
        while !pred(self) {
            assert!(
                self.pump(deadline),
                "timed out waiting for {what}: {:?}",
                self.events
            );
        }
    }

    fn has_event(&self, name: &str) -> bool {
        self.events.iter().any(|e| e["event"] == name)
    }
}

fn client(host: &Arc<Host>) -> (u64, Inbox) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    (host.connect_client(tx), Inbox::new(rx))
}

#[test]
fn output_then_removed_then_exit() {
    let host = Host::new(1 << 20);
    let (c, mut inbox) = client(&host);
    let s = host
        .create(c, spec("t-exit", &["/d", "/c", "echo hello-host"]))
        .unwrap();
    inbox.wait_for("exit", |i| i.has_event("exit"));
    assert!(inbox.data.contains("hello-host"));
    let pos = |name: &str| {
        inbox
            .events
            .iter()
            .position(|e| e["event"] == name)
            .unwrap()
    };
    let last_data = inbox
        .events
        .iter()
        .rposition(|e| e["data"] == true)
        .unwrap();
    assert!(pos("spawned") < pos("removed"));
    assert!(pos("removed") < pos("exit"), "id must be free before exit");
    assert!(last_data < pos("exit"), "all data precedes exit");
    let exit = &inbox.events[pos("exit")];
    assert_eq!(exit["spawnId"], s.spawn_id);
    assert_eq!(exit["exitCode"], 0);
    assert!(host.list().is_empty());
}

#[test]
fn kill_frees_the_id_for_an_immediate_respawn() {
    let host = Host::new(1 << 20);
    let (c, mut inbox) = client(&host);
    let first = host.create(c, spec("t-kill", &["/d", "/k"])).unwrap();
    assert_eq!(
        host.create(c, spec("t-kill", &["/d", "/k"])).unwrap_err(),
        "exists"
    );
    let grace = host.kill("t-kill");
    let second = host.create(c, spec("t-kill", &["/d", "/k"])).unwrap();
    assert_ne!(first.spawn_id, second.spawn_id);
    // The old generation's exit must not remove the new one.
    inbox.wait_for("old exit", |i| {
        i.events
            .iter()
            .any(|e| e["event"] == "exit" && e["spawnId"] == first.spawn_id)
    });
    assert_eq!(host.list().len(), 1);
    assert_eq!(host.list()[0].spawn_id, second.spawn_id);
    if let Some(g) = grace {
        g.join().unwrap();
    }
    host.shutdown_all();
    assert!(host.list().is_empty());
}

/// Review blocker (84e5): a killed generation keeps flushing until EOF, after
/// `removed` and after a same-id respawn. Every frame must carry its own
/// generation so the client can drop the stale tail.
#[test]
fn stale_output_after_a_respawn_is_tagged_with_the_old_generation() {
    let host = Host::new(1 << 20);
    let (c, mut inbox) = client(&host);
    let flood = CreateSpec {
        initial_input: Some(format!(
            "for /l %i in (1,1,1000000) do @{} old-%i{}",
            "ec\x68o", '\r'
        )),
        ..spec("t-stale", &["/d", "/q", "/k"])
    };
    let first = host.create(c, flood).unwrap();
    inbox.wait_for("flood", |i| i.data.contains("old-50"));
    let grace = host.kill("t-stale");
    let second = host
        .create(
            c,
            CreateSpec {
                initial_input: Some(format!("{} new-gen{}", "ec\x68o", '\r')),
                ..spec("t-stale", &["/d", "/q", "/k"])
            },
        )
        .unwrap();
    inbox.wait_for("old exit and new output", |i| {
        i.events
            .iter()
            .any(|e| e["event"] == "exit" && e["spawnId"] == first.spawn_id)
            && i.data.contains("new-gen")
    });
    for (g, text) in &inbox.chunks {
        if text.contains("old-") {
            assert_eq!(*g, first.spawn_id, "old output tagged as new: {text:?}");
        }
        if text.contains("new-gen") {
            assert_eq!(*g, second.spawn_id);
        }
    }
    if let Some(g) = grace {
        g.join().unwrap();
    }
    host.shutdown_all();
}

#[test]
fn write_checked_lands_only_in_the_pinned_generation() {
    let host = Host::new(1 << 20);
    let (c, mut inbox) = client(&host);
    let s = host
        .create(c, spec("t-write", &["/d", "/q", "/k"]))
        .unwrap();
    assert_eq!(
        host.write_checked("t-write", "stale", b"echo nope\r"),
        Err("target-gone".into())
    );
    host.write_checked("t-write", &s.spawn_id, b"echo pinned-ok\r")
        .unwrap();
    inbox.wait_for("echo", |i| i.data.matches("pinned-ok").count() >= 2);
    assert!(!inbox.data.contains("nope"));
    assert!(inbox.chunks.iter().all(|(g, _)| *g == s.spawn_id));
    host.shutdown_all();
}

#[test]
fn attach_replays_history_then_streams_live() {
    let host = Host::new(1 << 20);
    let (a, mut first) = client(&host);
    let s = host
        .create(
            a,
            CreateSpec {
                initial_input: Some("echo before-restart\r".into()),
                ..spec("t-attach", &["/d", "/q", "/k"])
            },
        )
        .unwrap();
    first.wait_for("first output", |i| i.data.contains("before-restart"));

    // App restart: a new client replaces the old one and has seen nothing.
    let (b, mut second) = client(&host);
    let listed = host.list();
    assert_eq!(listed[0].terminal_id, "t-attach");
    assert_eq!(listed[0].meta, json!({"agent": null}));
    host.attach(b, "t-attach", |spawn, replay, total| {
        frame::encode_json(
            json!({"answer": true, "spawnId": spawn, "replay": replay, "total": total})
                .to_string()
                .as_bytes(),
        )
    })
    .unwrap();
    second.wait_for("replay", |i| i.data.contains("before-restart"));
    assert_eq!(second.events[0]["answer"], true, "answer precedes replay");
    assert_eq!(second.events[0]["spawnId"], s.spawn_id);

    host.write("t-attach", b"echo after-attach\r").unwrap();
    second.wait_for("live", |i| i.data.contains("after-attach"));
    host.shutdown_all();
}

#[test]
fn ring_is_bounded_per_pane() {
    let host = Host::new(256);
    let (a, mut first) = client(&host);
    host.create(
        a,
        CreateSpec {
            initial_input: Some(format!("for /l %i in (1,1,200) do @{} line-%i\r", "echo")),
            ..spec("t-ring", &["/d", "/q", "/k"])
        },
    )
    .unwrap();
    first.wait_for("loop end", |i| i.data.contains("line-200"));
    std::thread::sleep(Duration::from_millis(200));
    let (b, mut second) = client(&host);
    host.attach(b, "t-ring", |_, replay, total| {
        assert!(replay <= 256, "replay {replay} exceeds the ring");
        assert!(total > 256);
        frame::encode_json(b"{}")
    })
    .unwrap();
    second.wait_for("replay", |i| i.data.contains("line-200"));
    assert!(!second.data.contains("line-1\r"));
    host.shutdown_all();
}

mod pipe {
    use super::*;
    use swarmterm_host::server;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};

    struct Conn {
        pipe: NamedPipeClient,
        dec: Decoder,
        next_id: u64,
        events: Vec<String>,
    }

    impl Conn {
        async fn open(name: &str) -> Self {
            Conn {
                pipe: ClientOptions::new().open(name).unwrap(),
                dec: Decoder::default(),
                next_id: 1,
                events: Vec::new(),
            }
        }

        async fn send(&mut self, mut v: Value) -> u64 {
            let id = self.next_id;
            self.next_id += 1;
            v["v"] = 1.into();
            v["id"] = id.into();
            self.pipe
                .write_all(&frame::encode_json(v.to_string().as_bytes()))
                .await
                .unwrap();
            id
        }

        /// Next frame, or None when the host closed the connection.
        async fn recv(&mut self) -> Option<Frame> {
            let mut buf = vec![0u8; 65536];
            loop {
                if let Some(f) = self.dec.next_frame().unwrap() {
                    return Some(f);
                }
                let n = tokio::time::timeout(WAIT, self.pipe.read(&mut buf))
                    .await
                    .expect("host answered")
                    .ok()?;
                if n == 0 {
                    return None;
                }
                self.dec.feed(&buf[..n]);
            }
        }

        async fn answer(&mut self, id: u64) -> Value {
            loop {
                match self.recv().await.expect("connection open") {
                    Frame::Json(p) => {
                        let v: Value = serde_json::from_slice(&p).unwrap();
                        if let Some(e) = v["event"].as_str() {
                            self.events.push(e.to_string());
                        }
                        if v["id"] == id {
                            return v;
                        }
                    }
                    Frame::Data { .. } => {}
                }
            }
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn hello_auth_and_a_full_session() {
        let dir = tempfile::tempdir().unwrap();
        let name = format!(
            r"\\.\pipe\swarmterm-host-test-{}",
            uuid::Uuid::new_v4().simple()
        );
        let host = Host::new(1 << 20);
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
        let data_dir = dir.path().to_path_buf();
        let server_host = host.clone();
        let srv_name = name.clone();
        let server = tokio::spawn(async move {
            server::run(server_host, &data_dir, srv_name, Some(ready_tx), stop_rx).await
        });
        let ep = ready_rx.await.unwrap();
        let disc: Value =
            serde_json::from_str(&std::fs::read_to_string(&ep.discovery).unwrap()).unwrap();
        assert_eq!(disc["pipe"], name);
        assert_eq!(disc["token"], ep.token);

        // A second host on the same name refuses to start.
        let (_s2, stop2) = tokio::sync::watch::channel(false);
        let dup = server::run(host.clone(), dir.path(), name.clone(), None, stop2).await;
        assert_eq!(dup.unwrap_err(), "already-running");

        // Ops before hello are refused and the connection closes.
        let mut c = Conn::open(&name).await;
        let id = c.send(json!({"op": "list"})).await;
        assert_eq!(c.answer(id).await["reason"], "hello-required");
        assert!(c.recv().await.is_none());

        // Before hello only a small frame is accepted.
        let mut c = Conn::open(&name).await;
        let big = json!({"op": "hello", "token": "x".repeat(5000)});
        c.send(big).await;
        match c.recv().await {
            Some(Frame::Json(p)) => {
                let v: Value = serde_json::from_slice(&p).unwrap();
                assert_eq!(v["reason"], "too-large");
            }
            other => panic!("expected too-large, got {other:?}"),
        }
        assert!(c.recv().await.is_none());

        // Wrong token.
        let mut c = Conn::open(&name).await;
        let id = c
            .send(json!({"op": "hello", "token": "x", "proto": [1]}))
            .await;
        assert_eq!(c.answer(id).await["reason"], "unauthorized");
        assert!(c.recv().await.is_none());

        // Proper session.
        let mut c = Conn::open(&name).await;
        let id = c
            .send(json!({"op": "hello", "token": ep.token, "proto": [1, 2]}))
            .await;
        let hello = c.answer(id).await;
        assert_eq!(hello["ok"], true);
        assert_eq!(hello["proto"], 1);

        let id = c.send(json!({"op": "teleport"})).await;
        assert_eq!(c.answer(id).await["reason"], "unknown-op");

        let env: serde_json::Map<String, Value> =
            std::env::vars().map(|(k, v)| (k, v.into())).collect();
        let id = c
            .send(json!({
                "op": "create", "terminalId": "p1", "shell": "cmd.exe",
                "args": ["/d", "/q", "/k"], "env": env,
                "cwd": std::env::temp_dir(), "cols": 100, "rows": 30
            }))
            .await;
        let created = c.answer(id).await;
        assert_eq!(created["ok"], true, "{created}");
        let spawn_id = created["spawnId"].as_str().unwrap().to_string();

        let id = c
            .send(json!({"op": "write", "terminalId": "p1", "data": "echo over-the-pipe\r"}))
            .await;
        assert_eq!(c.answer(id).await["ok"], true);
        let mut seen = String::new();
        while seen.matches("over-the-pipe").count() < 2 {
            if let Some(Frame::Data {
                terminal_id, bytes, ..
            }) = c.recv().await
            {
                assert_eq!(terminal_id, "p1");
                seen.push_str(&String::from_utf8(bytes).unwrap());
            }
        }

        let id = c.send(json!({"op": "list"})).await;
        let list = c.answer(id).await;
        assert_eq!(list["terminals"][0]["spawnId"], spawn_id);

        let id = c
            .send(json!({"op": "write_checked", "terminalId": "p1", "spawnId": "old", "data": "x"}))
            .await;
        assert_eq!(c.answer(id).await["reason"], "target-gone");

        let id = c
            .send(json!({"op": "resize", "terminalId": "p1", "cols": 90, "rows": 20}))
            .await;
        assert_eq!(c.answer(id).await["ok"], true);

        let id = c.send(json!({"op": "kill", "terminalId": "p1"})).await;
        assert_eq!(c.answer(id).await["ok"], true);
        while !c.events.contains(&"exit".to_string()) {
            if let Some(Frame::Json(p)) = c.recv().await {
                let v: Value = serde_json::from_slice(&p).unwrap();
                if let Some(e) = v["event"].as_str() {
                    c.events.push(e.to_string());
                }
            }
        }
        let pos = |n: &str| c.events.iter().position(|e| e == n).unwrap();
        assert!(pos("removed") < pos("exit"));

        stop_tx.send(true).unwrap();
        server.await.unwrap().unwrap();
        assert!(!ep.discovery.exists(), "discovery removed on stop");
        host.shutdown_all();
    }
}
