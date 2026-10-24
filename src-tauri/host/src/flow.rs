//! Output flow control (perf phase 2): one `FlowGate` per pane generation.
//!
//! `term.write` has no backpressure, so without this a flooding pane piles
//! IPC strings into xterm's write queue and WebView memory (GBs that are
//! never returned; xterm even discards data past ~50 MB pending). The
//! renderer acks bytes once xterm parsed them; the flusher counts what it
//! sent and parks while more than `FLOW_HIGH` is unacked, resuming below
//! `FLOW_LOW`. A parked flusher stops draining the bounded reader queue, the
//! reader stops reading, and ConPTY backpressures the child.
//!
//! Liveness beats throughput: a gate never wedges a shell. It opens for good
//! on `close` (generation over), and opens until the next ack when no ack
//! arrived for `FLOW_ACK_TIMEOUT` (pane unmounted, renderer stalled) or on
//! `release` (client detached; the ring is the sink then). Bytes sent while
//! open are counted in `bypassed` (diagnostics only: nothing is lost).
//!
//! Used by the in-process flusher (`src/pty.rs`) and the host flusher
//! (`engine.rs`), so the rule is written once.

use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

/// Park the flusher above this many unacked bytes.
pub const FLOW_HIGH: u64 = 2048 * 1024;
/// Resume once the renderer acked down to this. The renderer acks in
/// `ACK_CHUNK` steps (`src/lib/output-ack.ts`, 256 KB) and keeps less than one
/// chunk unacked, so this must stay at least twice that chunk.
pub const FLOW_LOW: u64 = 512 * 1024;
/// No ack for this long while parked = the renderer is gone or stuck.
pub const FLOW_ACK_TIMEOUT: Duration = Duration::from_secs(2);
/// Reader → flusher queue depth, in reads (each up to `READ_BUF_BYTES`).
/// Small on purpose: while the gate holds, this is all that sits in memory
/// before ConPTY pushes back on the child.
pub const READ_QUEUE_DEPTH: usize = 4;

#[derive(Debug)]
struct State {
    unacked: u64,
    /// Opened by a timeout or `release`; the next ack closes it again.
    open: bool,
    /// Generation over: never park again.
    closed: bool,
    last_ack: Instant,
    bypassed: u64,
}

#[derive(Debug)]
pub struct FlowGate {
    st: Mutex<State>,
    cv: Condvar,
    timeout: Duration,
}

impl Default for FlowGate {
    fn default() -> Self {
        Self::with_timeout(FLOW_ACK_TIMEOUT)
    }
}

impl FlowGate {
    pub fn with_timeout(timeout: Duration) -> Self {
        FlowGate {
            st: Mutex::new(State {
                unacked: 0,
                open: false,
                closed: false,
                last_ack: Instant::now(),
                bypassed: 0,
            }),
            cv: Condvar::new(),
            timeout,
        }
    }

    /// `n` bytes went to a renderer that acks.
    pub fn sent(&self, n: usize) {
        let mut s = self.st.lock().unwrap();
        s.unacked += n as u64;
        if s.open || s.closed {
            s.bypassed += n as u64;
        }
    }

    /// The renderer parsed `n` more bytes.
    pub fn ack(&self, n: u64) {
        let mut s = self.st.lock().unwrap();
        s.unacked = s.unacked.saturating_sub(n);
        s.last_ack = Instant::now();
        s.open = false;
        drop(s);
        self.cv.notify_all();
    }

    /// Block while the renderer is too far behind. Returns at once when at
    /// most `FLOW_HIGH` is unacked; once parked, waits for `FLOW_LOW`, a
    /// `release`/`close`, or `timeout` without an ack (then opens the gate).
    pub fn wait(&self) {
        let mut s = self.st.lock().unwrap();
        if s.open || s.closed || s.unacked <= FLOW_HIGH {
            return;
        }
        let start = Instant::now();
        while !s.open && !s.closed && s.unacked > FLOW_LOW {
            // An ack while parked restarts the clock: a slow renderer is
            // not a dead one.
            let deadline = start.max(s.last_ack) + self.timeout;
            let now = Instant::now();
            if now >= deadline {
                s.open = true;
                break;
            }
            s = self.cv.wait_timeout(s, deadline - now).unwrap().0;
        }
    }

    /// A new acking client took over: start counting from zero.
    pub fn reset(&self) {
        let mut s = self.st.lock().unwrap();
        s.unacked = 0;
        s.open = false;
        s.last_ack = Instant::now();
        drop(s);
        self.cv.notify_all();
    }

    /// Nobody acks any more (client detached): forget the debt and let a
    /// parked flusher go.
    pub fn release(&self) {
        let mut s = self.st.lock().unwrap();
        s.unacked = 0;
        s.open = true;
        drop(s);
        self.cv.notify_all();
    }

    /// Generation over (exit or kill): the rest flows ungated, so `exit`
    /// is never held back behind a renderer that stopped acking.
    pub fn close(&self) {
        self.st.lock().unwrap().closed = true;
        self.cv.notify_all();
    }

    pub fn unacked(&self) -> u64 {
        self.st.lock().unwrap().unacked
    }

    /// Bytes that went past an open gate.
    pub fn bypassed(&self) -> u64 {
        self.st.lock().unwrap().bypassed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    const KB: usize = 1024;

    #[test]
    fn below_high_never_parks() {
        let g = FlowGate::with_timeout(Duration::from_secs(60));
        g.sent(FLOW_HIGH as usize);
        let t = Instant::now();
        g.wait();
        assert!(t.elapsed() < Duration::from_millis(500));
    }

    /// The renderer's `ACK_CHUNK` (src/lib/output-ack.ts, 256 KB; its test
    /// pins that value) leaves less than one chunk unacked, so LOW must be at
    /// least two chunks or a parked gate waits for the no-ack timeout.
    const _: () = {
        const RENDERER_ACK_CHUNK: u64 = 256 * 1024;
        assert!(FLOW_LOW >= 2 * RENDERER_ACK_CHUNK);
        assert!(FLOW_HIGH > FLOW_LOW);
    };

    #[test]
    fn parks_above_high_and_resumes_only_below_low() {
        let g = Arc::new(FlowGate::with_timeout(Duration::from_secs(60)));
        // Parked above HIGH; one ack lands between LOW and HIGH, the next below LOW.
        let above_high = FLOW_HIGH as usize + 88 * KB;
        let between = FLOW_LOW + 104 * KB as u64;
        let below_low = FLOW_LOW - 24 * KB as u64;
        g.sent(above_high);
        let (done_tx, done) = std::sync::mpsc::channel();
        let g2 = g.clone();
        std::thread::spawn(move || {
            g2.wait();
            done_tx.send(()).unwrap();
        });
        // Let it park first (an ack before `wait` would skip the gate).
        assert!(done.recv_timeout(Duration::from_millis(150)).is_err());
        // Down to `between`: under HIGH but above LOW, still parked (hysteresis).
        g.ack(above_high as u64 - between);
        assert!(done.recv_timeout(Duration::from_millis(150)).is_err());
        g.ack(between - below_low);
        done.recv_timeout(Duration::from_secs(5)).expect("resumed");
        assert_eq!(g.unacked(), below_low);
    }

    #[test]
    fn no_ack_opens_the_gate_after_the_timeout() {
        let g = FlowGate::with_timeout(Duration::from_millis(100));
        g.sent(2 * FLOW_HIGH as usize);
        let t = Instant::now();
        g.wait();
        assert!(t.elapsed() >= Duration::from_millis(100));
        // Open: no more parking, and what passes is counted.
        g.sent(1024 * KB);
        let t = Instant::now();
        g.wait();
        assert!(t.elapsed() < Duration::from_millis(500));
        assert_eq!(g.bypassed(), 1024 * KB as u64);
        // An ack shuts it again.
        g.ack(0);
        let t = Instant::now();
        g.wait();
        assert!(t.elapsed() >= Duration::from_millis(100));
    }

    #[test]
    fn acks_while_parked_restart_the_timeout() {
        let g = Arc::new(FlowGate::with_timeout(Duration::from_secs(1)));
        g.sent(4096 * KB);
        let g2 = g.clone();
        let acker = std::thread::spawn(move || {
            for _ in 0..4 {
                std::thread::sleep(Duration::from_millis(100));
                g2.ack(KB as u64);
            }
        });
        let t = Instant::now();
        g.wait();
        // 4 acks 100 ms apart restart the 1 s clock: parked past 1.3 s.
        assert!(t.elapsed() >= Duration::from_millis(1300));
        acker.join().unwrap();
    }

    #[test]
    fn release_and_close_free_a_parked_flusher() {
        for close in [false, true] {
            let g = Arc::new(FlowGate::with_timeout(Duration::from_secs(60)));
            g.sent(1024 * KB);
            let g2 = g.clone();
            let h = std::thread::spawn(move || g2.wait());
            std::thread::sleep(Duration::from_millis(50));
            if close {
                g.close();
            } else {
                g.release();
            }
            h.join().unwrap();
        }
    }

    #[test]
    fn reset_forgets_the_debt() {
        let g = FlowGate::with_timeout(Duration::from_secs(60));
        g.sent(1024 * KB);
        g.reset();
        assert_eq!(g.unacked(), 0);
        let t = Instant::now();
        g.wait();
        assert!(t.elapsed() < Duration::from_millis(500));
    }
}
