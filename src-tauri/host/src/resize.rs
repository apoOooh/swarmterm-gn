//! Coalescing PTY resize off every lock (perf step C).
//!
//! `ResizePseudoConsole` is a round trip to conhost. While a flooding pane's
//! output pipe is full, conhost is parked writing to it and the resize blocks
//! until the reader drains — and the reader drains only when the renderer
//! acks. Resizing under the `terminals` lock therefore made every ack (which
//! needs the same lock) wait behind it: a lock-order cycle broken only by the
//! 2 s flow timeout. Here the caller only stores the size; one short-lived
//! worker per pane applies the LATEST size (a drag sends dozens, only the last
//! matters) without holding anything the ack path needs.
//!
//! `close` takes the master out (dropping it = ClosePseudoConsole). It waits
//! for an in-flight resize, so it must run on a thread that may block (the
//! shutdown's close thread), never under the `terminals` lock.

use std::sync::{Arc, Mutex};

use portable_pty::{MasterPty, PtySize};

/// Anything that can be resized. `MasterPty` in production; tests plug in a
/// fake that blocks to reproduce a full pipe.
pub trait Resize: Send {
    fn resize_to(&self, cols: u16, rows: u16);
}

impl Resize for Box<dyn MasterPty + Send> {
    fn resize_to(&self, cols: u16, rows: u16) {
        let _ = self.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        });
    }
}

#[derive(Default)]
struct Pending {
    size: Option<(u16, u16)>,
    /// A worker is draining `size`; a new request only overwrites it.
    running: bool,
}

pub struct Resizer<M: Resize + 'static = Box<dyn MasterPty + Send>> {
    master: Mutex<Option<M>>,
    pending: Mutex<Pending>,
}

impl<M: Resize + 'static> Resizer<M> {
    pub fn new(master: M) -> Arc<Self> {
        Arc::new(Resizer {
            master: Mutex::new(Some(master)),
            pending: Mutex::default(),
        })
    }

    /// Never blocks on the PTY: stores the size and makes sure a worker runs.
    pub fn request(self: &Arc<Self>, cols: u16, rows: u16) {
        let mut p = lock(&self.pending);
        p.size = Some((cols, rows));
        if p.running {
            return;
        }
        p.running = true;
        drop(p);
        let me = self.clone();
        let spawned = std::thread::Builder::new()
            .name("pty-resize".into())
            .spawn(move || me.drain());
        if spawned.is_err() {
            // No thread (resource exhaustion): drop the size rather than
            // resize inline, which could block the caller on a stuck
            // conhost. The next resize retries.
            let mut p = lock(&self.pending);
            p.size = None;
            p.running = false;
        }
    }

    fn drain(&self) {
        loop {
            let size = {
                let mut p = lock(&self.pending);
                match p.size.take() {
                    Some(s) => s,
                    None => {
                        p.running = false;
                        return;
                    }
                }
            };
            if let Some(m) = lock(&self.master).as_ref() {
                m.resize_to(size.0, size.1);
            }
        }
    }

    /// Take the master out (the caller drops it). Waits for a resize in
    /// flight; later requests become no-ops.
    pub fn close(&self) -> Option<M> {
        lock(&self.master).take()
    }
}

/// Poison-tolerant: a panicking resize must not leave `running` stuck or
/// make `close` panic on the shutdown path (skipping ClosePseudoConsole).
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    /// Records sizes; the first resize blocks until released (a full pipe).
    struct Fake {
        seen: Arc<Mutex<Vec<(u16, u16)>>>,
        gate: Mutex<Option<mpsc::Receiver<()>>>,
    }

    impl Resize for Fake {
        fn resize_to(&self, cols: u16, rows: u16) {
            if let Some(rx) = self.gate.lock().unwrap().take() {
                let _ = rx.recv();
            }
            self.seen.lock().unwrap().push((cols, rows));
        }
    }

    #[test]
    fn blocked_resize_does_not_block_caller_or_other_lock_users_and_latest_wins() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (release, gate) = mpsc::channel();
        let r = Resizer::new(Fake {
            seen: seen.clone(),
            gate: Mutex::new(Some(gate)),
        });
        // Stand-in for the `terminals` lock: the command path holds it only
        // while requesting, and an "ack" must get it while the PTY is stuck.
        let terminals = Arc::new(Mutex::new(()));
        {
            let _g = terminals.lock().unwrap();
            r.request(80, 24); // worker parks inside resize_to
        }
        std::thread::sleep(Duration::from_millis(30));
        let (done_tx, done_rx) = mpsc::channel();
        let t2 = terminals.clone();
        let r2 = r.clone();
        std::thread::spawn(move || {
            let _g = t2.lock().unwrap();
            r2.request(100, 30);
            r2.request(120, 40);
            done_tx.send(()).unwrap();
        });
        // The "ack" side: lock + requests return while the resize is blocked.
        done_rx
            .recv_timeout(Duration::from_millis(500))
            .expect("caller blocked behind a stuck resize");
        release.send(()).unwrap();
        for _ in 0..100 {
            if seen.lock().unwrap().last() == Some(&(120, 40)) {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen.first(), Some(&(80, 24)));
        assert_eq!(seen.last(), Some(&(120, 40)));
        assert!(!seen.contains(&(100, 30)), "intermediate size coalesced");
    }

    #[test]
    fn close_takes_master_and_later_requests_are_noops() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let r = Resizer::new(Fake {
            seen: seen.clone(),
            gate: Mutex::new(None),
        });
        assert!(r.close().is_some());
        r.request(10, 10);
        std::thread::sleep(Duration::from_millis(30));
        assert!(seen.lock().unwrap().is_empty());
    }
}
