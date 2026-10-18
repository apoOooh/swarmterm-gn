//! PTY ownership inside the host (ADR 0001): spawn, input, resize, kill,
//! output fan-out with a replay ring, and the generation rules the app's
//! `pty.rs` established.
//!
//! One client at a time. A new `hello`'d connection replaces the previous
//! one (an app restart reconnects before the old pipe has noticed EOF), and
//! output is routed to the current client only for panes it created or
//! attached. Without a client every pane keeps running and fills its ring.
//!
//! Lock order: `terminals` → `Output` → `client`. The flusher and exit paths
//! never take `terminals` while holding an `Output` lock.
//!
//! Ordering guarantees carried over from the in-process design:
//! - keystroke FIFO per generation: `write`/`write_checked` enqueue under the
//!   `terminals` lock into that generation's own queue;
//! - `data` before `exit`: both are sent under the pane's `Output` lock, exit
//!   only after the flusher's channel closed;
//! - kill frees the id before a respawn: the entry leaves the map (and
//!   `removed` is sent) before the shutdown starts, so a `create` with the
//!   same id right after `kill` succeeds.

use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde_json::Value;
use tokio::sync::mpsc::UnboundedSender;

use crate::frame;
use crate::input::PtyInput;
use crate::modes::ModeTracker;
use crate::output::{next_batch, take_valid_utf8, OUTPUT_IDLE, READ_BUF_BYTES};
use crate::protocol::{Attached, CreateSpec, Event, TerminalInfo};
use crate::ring::Ring;

/// How long a closed pane's process tree may take to exit on its own before
/// it is terminated. Windows gives CTRL_CLOSE_EVENT handlers 5 s; most agents
/// need well under one.
#[cfg(windows)]
const KILL_GRACE: std::time::Duration = std::time::Duration::from_secs(3);

/// Frames for the connected client; the server's writer task drains it.
pub type FrameTx = UnboundedSender<Vec<u8>>;

struct Client {
    id: u64,
    tx: FrameTx,
    /// Dropped when a newer client replaces this one. The server's
    /// connection task holds its own frame sender (for answers), so dropping
    /// `tx` alone would leave the replaced pipe open and silent; the kick
    /// tells that task to close it.
    _kick: Option<tokio::sync::oneshot::Sender<()>>,
}

/// Output side of one generation, shared by the flusher, `attach` and exit.
struct Output {
    ring: Ring,
    /// Fed with the ring, so `attach` can restore what the cut dropped.
    modes: ModeTracker,
    /// Client that receives live `data` for this pane.
    attached: Option<u64>,
}

impl Output {
    fn new(cap: usize, attached: Option<u64>) -> Self {
        Output {
            ring: Ring::new(cap),
            modes: ModeTracker::default(),
            attached,
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        let at = self.ring.total();
        self.ring.push(bytes);
        self.modes.feed(at, bytes);
        self.modes.prune(self.ring.start());
    }

    /// What `attach` sends, and whether older output is missing from it.
    fn replay(&self) -> (Vec<u8>, bool) {
        let plan = self.modes.plan(self.ring.start());
        let mut replay = plan.prefix;
        replay.extend(self.ring.snapshot_from(plan.start));
        (replay, plan.start > 0)
    }
}

struct Entry {
    spawn_id: String,
    pid: Option<u32>,
    cwd: String,
    meta: Value,
    /// Last size from create/resize: the replay was rendered at it, so a
    /// reattaching client sizes its terminal to it before writing.
    cols: u16,
    rows: u16,
    input: PtyInput,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    #[cfg(windows)]
    job: Option<crate::job::JobHandle>,
    output: Arc<Mutex<Output>>,
}

impl Entry {
    /// Close the pane the way a regular terminal window does, then make sure
    /// nothing survives (moved from `ManagedTerminal::shutdown`).
    ///
    /// Why not just `kill()`: `TerminateJobObject` is a hard kill, so programs
    /// never run their exit handlers. Claude Code records every fullscreen
    /// launch on disk and clears the record on a clean exit; a process that
    /// vanishes before startup finished counts as a fullscreen crash, and
    /// after two strikes it turns fullscreen off machine-wide. Closing the
    /// pseudo console sends CTRL_CLOSE_EVENT to every attached process; the
    /// job is terminated only after `KILL_GRACE`.
    fn shutdown(self) -> Option<std::thread::JoinHandle<()>> {
        #[cfg(windows)]
        {
            let Entry {
                input,
                master,
                killer,
                job,
                ..
            } = self;
            let Some(job) = job else {
                let mut killer = killer;
                let _ = killer.kill();
                return None;
            };
            // On pre-24H2 conhost ClosePseudoConsole can block until the
            // clients detach, so the close runs on its own thread and can
            // never delay the hard kill past KILL_GRACE.
            let deadline = std::time::Instant::now() + KILL_GRACE;
            std::thread::spawn(move || {
                drop(input);
                drop(master);
            });
            Some(std::thread::spawn(move || {
                while std::time::Instant::now() < deadline
                    && job.active_processes().is_some_and(|n| n > 0)
                {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                job.terminate();
                let mut killer = killer;
                let _ = killer.kill();
            }))
        }
        #[cfg(not(windows))]
        {
            let mut killer = self.killer;
            let _ = killer.kill();
            None
        }
    }
}

pub struct Host {
    terminals: Mutex<HashMap<String, Entry>>,
    /// Opaque facts the app wants back after a restart (`set_app_state`).
    app_state: Mutex<serde_json::Map<String, Value>>,
    client: Mutex<Option<Client>>,
    next_client: std::sync::atomic::AtomicU64,
    ring_cap: usize,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Spawned {
    pub spawn_id: String,
    pub pid: Option<u32>,
}

impl Host {
    pub fn new(ring_cap: usize) -> Arc<Self> {
        Arc::new(Host {
            terminals: Mutex::new(HashMap::new()),
            app_state: Mutex::default(),
            client: Mutex::new(None),
            next_client: std::sync::atomic::AtomicU64::new(1),
            ring_cap,
        })
    }

    /// Make `tx` the current client. The previous client's sender is dropped,
    /// which ends its writer and closes that connection.
    pub fn connect_client(&self, tx: FrameTx) -> u64 {
        self.register(tx, None)
    }

    /// `connect_client` for a pipe connection: the receiver resolves (with
    /// an error) once a newer client took over, so the connection can close.
    pub fn connect_client_kickable(
        &self,
        tx: FrameTx,
    ) -> (u64, tokio::sync::oneshot::Receiver<()>) {
        let (kick, kicked) = tokio::sync::oneshot::channel();
        (self.register(tx, Some(kick)), kicked)
    }

    fn register(&self, tx: FrameTx, kick: Option<tokio::sync::oneshot::Sender<()>>) -> u64 {
        let id = self
            .next_client
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        *self.client.lock().unwrap() = Some(Client {
            id,
            tx,
            _kick: kick,
        });
        id
    }

    /// Forget `client` if it is still the current one; panes keep running.
    pub fn disconnect_client(&self, client: u64) {
        let mut c = self.client.lock().unwrap();
        if c.as_ref().is_some_and(|c| c.id == client) {
            *c = None;
        }
    }

    pub fn has_client(&self) -> bool {
        self.client.lock().unwrap().is_some()
    }

    /// Merge `state` into the app state (keys set to `null` are removed).
    pub fn set_app_state(&self, state: serde_json::Map<String, Value>) {
        let mut s = self.app_state.lock().unwrap();
        for (k, v) in state {
            if v.is_null() {
                s.remove(&k);
            } else {
                s.insert(k, v);
            }
        }
    }

    pub fn app_state(&self) -> Value {
        Value::Object(self.app_state.lock().unwrap().clone())
    }

    pub fn terminal_count(&self) -> usize {
        self.terminals.lock().unwrap().len()
    }

    /// Send to the current client; `only` restricts it to that client id.
    fn send(&self, frame: Vec<u8>, only: Option<u64>) {
        if let Some(c) = self.client.lock().unwrap().as_ref() {
            if only.is_none_or(|id| id == c.id) {
                let _ = c.tx.send(frame);
            }
        }
    }

    fn announce(&self, event: Event) {
        self.send(frame::encode_json(&event.to_json()), None);
    }

    pub fn create(self: &Arc<Self>, client: u64, spec: CreateSpec) -> Result<Spawned, String> {
        if spec.terminal_id.is_empty() || spec.terminal_id.len() > u8::MAX as usize {
            return Err("bad-request".into());
        }
        if self
            .terminals
            .lock()
            .unwrap()
            .contains_key(&spec.terminal_id)
        {
            return Err("exists".into());
        }
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: spec.rows,
                cols: spec.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("spawn-failed: {e}"))?;

        let spawn_id = uuid::Uuid::new_v4().to_string();
        let mut cmd = CommandBuilder::new(&spec.shell);
        cmd.args(&spec.args);
        // The app sends the whole environment; the host's own (inherited from
        // whichever app instance started it, possibly an older version) must
        // not leak into a pane spawned for a later one.
        cmd.env_clear();
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        // The host owns generation identity (ADR 0001), so it, not the app,
        // stamps the variable the hook CLI reports back.
        cmd.env("SWARMTERM_PTY_GENERATION", &spawn_id);
        cmd.cwd(&spec.cwd);

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn-failed: {e}"))?;
        let pid = child.process_id();
        let killer = child.clone_killer();
        let writer = pair.master.take_writer();
        let reader = pair.master.try_clone_reader();
        let (writer, reader) = match (writer, reader) {
            (Ok(w), Ok(r)) => (w, r),
            (Err(e), _) | (_, Err(e)) => {
                // The child already spawned; don't leave it orphaned.
                let _ = child.clone_killer().kill();
                return Err(format!("spawn-failed: {e}"));
            }
        };
        // Capture the shell in a job BEFORE it runs any command, so every
        // process the command tree spawns is born inside the job.
        #[cfg(windows)]
        let job = pid.and_then(crate::job::JobHandle::capturing);

        let output = Arc::new(Mutex::new(Output::new(self.ring_cap, Some(client))));
        let id = spec.terminal_id.clone();
        {
            let mut map = self.terminals.lock().unwrap();
            // Re-checked under the lock: two creates for one id may race
            // past the early check, and the loser must not replace a live
            // generation (its child is torn down instead).
            if map.contains_key(&id) {
                drop(map);
                let mut killer = killer;
                let _ = killer.kill();
                return Err("exists".into());
            }
            map.insert(
                id.clone(),
                Entry {
                    spawn_id: spawn_id.clone(),
                    pid,
                    cwd: spec.cwd.clone(),
                    meta: spec.meta.clone(),
                    cols: spec.cols,
                    rows: spec.rows,
                    input: PtyInput::spawn(writer),
                    master: pair.master,
                    killer,
                    #[cfg(windows)]
                    job,
                    output: output.clone(),
                },
            );
            if let Some(line) = &spec.initial_input {
                if let Err(e) = map[&id].input.send(line.as_bytes()) {
                    eprintln!("[host] initial input for {id} dropped: {e}");
                }
            }
        }
        self.announce(Event::Spawned {
            terminal_id: id.clone(),
            spawn_id: spawn_id.clone(),
            pid,
        });

        // A shell that exits on its own never closes the ConPTY output pipe
        // while the master lives, so the reader alone would park forever. The
        // waiter owns the child: once it dies it removes THIS generation's
        // entry (dropping the master forces the reader's EOF), then hands the
        // exit code to the read loop.
        let (exit_tx, exit_rx) = std::sync::mpsc::channel::<i32>();
        let host = self.clone();
        let waiter_id = id.clone();
        let waiter_spawn = spawn_id.clone();
        std::thread::spawn(move || {
            let mut child = child;
            let code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(-1);
            drop(host.remove_generation(&waiter_id, &waiter_spawn));
            let _ = exit_tx.send(code);
        });

        let host = self.clone();
        let reader_spawn = spawn_id.clone();
        std::thread::spawn(move || host.read_loop(id, reader_spawn, reader, exit_rx, output));

        Ok(Spawned { spawn_id, pid })
    }

    /// Remove `id` only if it still belongs to `spawn_id`, announcing it.
    /// The entry is returned so the caller drops (or shuts down) the master
    /// outside the lock.
    fn remove_generation(&self, id: &str, spawn_id: &str) -> Option<Entry> {
        let removed = {
            let mut map = self.terminals.lock().unwrap();
            match map.get(id) {
                Some(t) if t.spawn_id == spawn_id => map.remove(id),
                _ => None,
            }
        };
        if removed.is_some() {
            self.announce(Event::Removed {
                terminal_id: id.to_string(),
                spawn_id: spawn_id.to_string(),
            });
        }
        removed
    }

    fn read_loop(
        self: Arc<Self>,
        id: String,
        spawn_id: String,
        mut reader: Box<dyn Read + Send>,
        exit_rx: std::sync::mpsc::Receiver<i32>,
        output: Arc<Mutex<Output>>,
    ) {
        // Reader → flusher split as in the app: ConPTY reads block, so the
        // coalescing needs its own thread. UTF-8 boundary handling stays in
        // the reader, so the flusher (and the ring) only see whole strings.
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        std::thread::spawn(move || {
            let mut pending: Vec<u8> = Vec::new();
            let mut chunk = vec![0u8; READ_BUF_BYTES];
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) => break,
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                    Ok(n) => {
                        pending.extend_from_slice(&chunk[..n]);
                        if let Some(text) = take_valid_utf8(&mut pending) {
                            if tx.send(text).is_err() {
                                return;
                            }
                        }
                    }
                }
            }
            if !pending.is_empty() {
                let _ = tx.send(String::from_utf8_lossy(&pending).into_owned());
            }
        });

        let mut last_flush = std::time::Instant::now() - OUTPUT_IDLE;
        while let Ok(first) = rx.recv() {
            let text = next_batch(&rx, first, last_flush.elapsed() >= OUTPUT_IDLE);
            // Ring and live send under one lock: `attach` snapshots under the
            // same lock, so a batch lands either in the replay or in the live
            // stream, never in both and never in neither.
            let mut out = output.lock().unwrap();
            out.push(text.as_bytes());
            if let Some(client) = out.attached {
                self.send(
                    frame::encode_data(&id, &spawn_id, text.as_bytes()),
                    Some(client),
                );
            }
            drop(out);
            last_flush = std::time::Instant::now();
        }
        let exit_code = exit_rx.recv().unwrap_or(-1);
        // Free the id BEFORE `exit`: a client respawning on exit must find it
        // free. A same-id respawn that already owns the slot is left alone.
        drop(self.remove_generation(&id, &spawn_id));
        let _out = output.lock().unwrap();
        self.announce(Event::Exit {
            terminal_id: id,
            spawn_id,
            exit_code,
        });
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let map = self.terminals.lock().unwrap();
        map.get(id).ok_or("target-gone")?.input.send(data)
    }

    /// Write that only lands in the generation the caller pinned (voice).
    /// The check and the enqueue run under the `terminals` lock, so no
    /// respawn can slip between them.
    pub fn write_checked(&self, id: &str, spawn_id: &str, data: &[u8]) -> Result<(), String> {
        let map = self.terminals.lock().unwrap();
        let t = map.get(id).ok_or("target-gone")?;
        check_generation(&t.spawn_id, spawn_id)?;
        t.input.send(data)
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let mut map = self.terminals.lock().unwrap();
        let t = map.get_mut(id).ok_or("target-gone")?;
        t.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
        t.cols = cols;
        t.rows = rows;
        Ok(())
    }

    /// Take the pane out of the registry (id free at once), then close it
    /// gracefully. Unknown ids are not an error: the pane may have exited.
    pub fn kill(&self, id: &str) -> Option<std::thread::JoinHandle<()>> {
        let spawn_id = self.terminals.lock().unwrap().get(id)?.spawn_id.clone();
        self.remove_generation(id, &spawn_id)?.shutdown()
    }

    pub fn list(&self) -> Vec<TerminalInfo> {
        let map = self.terminals.lock().unwrap();
        let mut out: Vec<TerminalInfo> = map
            .iter()
            .map(|(id, t)| TerminalInfo {
                terminal_id: id.clone(),
                spawn_id: t.spawn_id.clone(),
                pid: t.pid,
                cwd: t.cwd.clone(),
                meta: t.meta.clone(),
                cols: t.cols,
                rows: t.rows,
                output_total: t.output.lock().unwrap().ring.total(),
            })
            .collect();
        out.sort_by(|a, b| a.terminal_id.cmp(&b.terminal_id));
        out
    }

    /// Route `id`'s output to `client`: `answer` (built from the replay
    /// facts), then the replay as one data frame, then live output. All under
    /// the pane's output lock, so nothing is lost or doubled at the seam. The
    /// replay is the ring as `ModeTracker::plan` says: modes the cut dropped
    /// in front, an alternate screen whose switch was cut off skipped.
    pub fn attach(
        &self,
        client: u64,
        id: &str,
        answer: impl FnOnce(&Attached) -> Vec<u8>,
    ) -> Result<(), String> {
        let (output, spawn_id, pid, cols, rows) = {
            let map = self.terminals.lock().unwrap();
            let t = map.get(id).ok_or("target-gone")?;
            (t.output.clone(), t.spawn_id.clone(), t.pid, t.cols, t.rows)
        };
        let mut out = output.lock().unwrap();
        let (replay, truncated) = out.replay();
        out.attached = Some(client);
        let facts = Attached {
            spawn_id: spawn_id.clone(),
            pid,
            cols,
            rows,
            replay_bytes: replay.len(),
            output_total: out.ring.total(),
            truncated,
        };
        self.send(answer(&facts), Some(client));
        if !replay.is_empty() {
            self.send(frame::encode_data(id, &spawn_id, &replay), Some(client));
        }
        Ok(())
    }

    /// Close every pane (host exit). Joins the grace threads so the trees are
    /// gone when this returns.
    pub fn shutdown_all(&self) {
        let ids: Vec<String> = self.terminals.lock().unwrap().keys().cloned().collect();
        let handles: Vec<_> = ids.iter().filter_map(|id| self.kill(id)).collect();
        for h in handles {
            let _ = h.join();
        }
    }
}

pub fn check_generation(actual: &str, expected: &str) -> Result<(), String> {
    if actual == expected {
        Ok(())
    } else {
        Err("target-gone".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Push `chunks` through a ring of `cap` bytes, as the flusher does.
    fn replay(cap: usize, chunks: &[&[u8]]) -> (String, bool) {
        let mut out = Output::new(cap, None);
        for c in chunks {
            out.push(c);
        }
        let (bytes, truncated) = out.replay();
        (String::from_utf8(bytes).unwrap(), truncated)
    }

    #[test]
    fn replay_from_offset_zero_is_the_whole_ring() {
        // (a) a complete alternate segment, nothing cut.
        let (r, cut) = replay(
            64,
            &[b"$ a
\x1b[?1049hUI\x1b[?1049l$ "],
        );
        assert_eq!(
            r,
            "$ a
\x1b[?1049hUI\x1b[?1049l$ "
        );
        assert!(!cut);
    }

    #[test]
    fn a_wrapped_ring_skips_an_ended_alternate_segment() {
        // (b) the switch on is pushed out, its end is retained.
        let (r, cut) = replay(24, &[b"\x1b[?1049h", b"frame-1 frame-2 ", b"\x1b[?1049l$ ok"]);
        assert_eq!(r, "$ ok");
        assert!(cut);
    }

    #[test]
    fn a_wrapped_ring_inside_an_active_alternate_segment_switches_first() {
        // (c) and (d): the switch was split across two batches and then cut.
        let (r, cut) = replay(
            16,
            &[b"$ \x1b[?10", b"49h\x1b[?2004h", b"frame-1 frame-2 frame-3"],
        );
        assert_eq!(r, "\x1b[?1049h\x1b[?2004h frame-2 frame-3");
        assert!(cut);
    }

    #[test]
    fn a_wrapped_ring_keeps_modes_of_the_older_variants() {
        // (e) 47 behaves like 1049.
        let (r, _) = replay(8, &[b"\x1b[?47h", b"0123456789"]);
        assert_eq!(r, "\x1b[?1049h23456789");
    }

    #[test]
    fn generation_check_rejects_a_respawn() {
        assert_eq!(check_generation("g1", "g1"), Ok(()));
        assert_eq!(check_generation("g2", "g1"), Err("target-gone".into()));
    }

    #[test]
    fn a_new_client_replaces_the_old_one() {
        let host = Host::new(1024);
        let (tx1, mut rx1) = tokio::sync::mpsc::unbounded_channel();
        let (tx2, _rx2) = tokio::sync::mpsc::unbounded_channel();
        let c1 = host.connect_client(tx1);
        let c2 = host.connect_client(tx2);
        assert_ne!(c1, c2);
        // The old sender is gone, so the old connection's writer ends.
        assert!(rx1.blocking_recv().is_none());
        // A late disconnect of the old client must not unseat the new one.
        host.disconnect_client(c1);
        assert!(host.has_client());
        host.disconnect_client(c2);
        assert!(!host.has_client());
    }

    #[test]
    fn a_replaced_pipe_client_is_kicked() {
        use tokio::sync::oneshot::error::TryRecvError;
        let host = Host::new(1024);
        let (tx1, _rx1) = tokio::sync::mpsc::unbounded_channel();
        let (_c1, mut kicked) = host.connect_client_kickable(tx1);
        assert_eq!(kicked.try_recv(), Err(TryRecvError::Empty));
        let (tx2, _rx2) = tokio::sync::mpsc::unbounded_channel();
        host.connect_client(tx2);
        assert_eq!(kicked.try_recv(), Err(TryRecvError::Closed));
    }

    #[test]
    fn unknown_terminals_are_target_gone() {
        let host = Host::new(1024);
        assert_eq!(host.write("nope", b"x"), Err("target-gone".into()));
        assert_eq!(
            host.write_checked("nope", "g", b"x"),
            Err("target-gone".into())
        );
        assert_eq!(host.resize("nope", 80, 24), Err("target-gone".into()));
        assert!(host.kill("nope").is_none());
        assert_eq!(
            host.attach(1, "nope", |_| Vec::new()),
            Err("target-gone".into())
        );
    }
}
