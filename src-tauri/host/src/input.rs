//! Per-generation PTY input queue, moved from the app's `pty.rs` unchanged
//! in behaviour (ADR 0001). Phase 2 deletes the app-side copy.

use std::io::Write;
use std::sync::Arc;

/// Input for one pty generation. The blocking `write_all` runs on that
/// generation's own writer thread: a full ConPTY input pipe (big paste into a
/// busy agent) used to stall the main thread AND every other `terminals` lock
/// user. Commands only enqueue, under the lock, so ordering is the enqueue
/// order and a respawn (new generation, new queue) can never receive bytes
/// meant for the old one. A writer parked in `write_all` is not interruptible;
/// it ends when the master closes the pipe (shutdown drops it), and queued
/// bytes are then discarded with the dropped receiver.
///
/// Queued-but-unwritten bytes are capped (INPUT_QUEUE_MAX_BYTES): a hung agent
/// whose input pipe is full would otherwise grow the queue without limit.
pub struct PtyInput {
    tx: std::sync::mpsc::Sender<Vec<u8>>,
    queued: Arc<std::sync::atomic::AtomicUsize>,
    cap: usize,
}

/// Upper bound on bytes waiting for one pty's writer thread.
const INPUT_QUEUE_MAX_BYTES: usize = 8 * 1024 * 1024;

/// Slice size for the writer thread's pty writes.
const WRITE_CHUNK: usize = 64 * 1024;

impl PtyInput {
    pub fn spawn(writer: Box<dyn Write + Send>) -> Self {
        Self::with_cap(writer, INPUT_QUEUE_MAX_BYTES)
    }

    fn with_cap(mut writer: Box<dyn Write + Send>, cap: usize) -> Self {
        use std::sync::atomic::Ordering;
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let queued = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let drained = queued.clone();
        std::thread::spawn(move || {
            while let Ok(mut bytes) = rx.recv() {
                // Coalesce whatever queued behind a slow write into one write.
                while let Ok(more) = rx.try_recv() {
                    bytes.extend_from_slice(&more);
                }
                // Written in slices so a big paste frees its queue budget as
                // it drains, not only after the very last byte. Budget is
                // released only once written, so a stuck write still counts.
                let mut written = Ok(());
                for chunk in bytes.chunks(WRITE_CHUNK) {
                    written = writer.write_all(chunk);
                    if written.is_err() {
                        break;
                    }
                    drained.fetch_sub(chunk.len(), Ordering::AcqRel);
                }
                if written.and_then(|_| writer.flush()).is_err() {
                    // The pipe is gone: later sends fail with "target-gone".
                    break;
                }
            }
        });
        PtyInput { tx, queued, cap }
    }

    /// Queue bytes for the pty. Err "target-gone" when the writer thread is
    /// gone (pipe closed), "input-queue-full" when the pty is not draining.
    /// An empty queue always accepts one write, however big: the cap guards
    /// against a pty that stopped reading, not against one large paste into
    /// an idle pane (the writer thread drains it in `WRITE_CHUNK` slices).
    pub fn send(&self, data: &[u8]) -> Result<(), String> {
        use std::sync::atomic::Ordering;
        let len = data.len();
        self.queued
            .try_update(Ordering::AcqRel, Ordering::Acquire, |q| {
                (q == 0 || q + len <= self.cap).then_some(q + len)
            })
            .map_err(|_| "input-queue-full".to_string())?;
        self.tx.send(data.to_vec()).map_err(|_| {
            self.queued.fetch_sub(len, Ordering::AcqRel);
            "target-gone".to_string()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct SharedSink(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
    impl Write for SharedSink {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    struct BrokenSink;
    impl Write for BrokenSink {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::ErrorKind::BrokenPipe.into())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn pty_input_writes_in_enqueue_order() {
        let buf = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let input = PtyInput::spawn(Box::new(SharedSink(buf.clone())));
        for s in ["a", "b", "c", "d"] {
            input.send(s.as_bytes()).unwrap();
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while buf.lock().unwrap().len() < 4 && std::time::Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert_eq!(&*buf.lock().unwrap(), b"abcd");
    }

    /// Blocks every write until the test releases it: a pty that stopped reading.
    struct StuckSink(std::sync::mpsc::Receiver<()>);
    impl Write for StuckSink {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            let _ = self.0.recv();
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn pty_input_rejects_input_past_the_queue_cap() {
        let (release, gate) = std::sync::mpsc::channel();
        let input = PtyInput::with_cap(Box::new(StuckSink(gate)), 4);
        assert_eq!(input.send(b"abcd"), Ok(()));
        assert_eq!(input.send(b"e"), Err("input-queue-full".to_string()));
        drop(release); // writer drains, budget is freed
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let mut res = Err(String::new());
        while std::time::Instant::now() < deadline {
            res = input.send(b"e");
            if res.is_ok() {
                break;
            }
            std::thread::yield_now();
        }
        assert_eq!(res, Ok(()));
    }

    #[test]
    fn pty_input_accepts_one_oversized_write_on_an_idle_queue() {
        let buf = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let input = PtyInput::with_cap(Box::new(SharedSink(buf.clone())), 4);
        let big = vec![b'x'; WRITE_CHUNK * 3 + 7];
        assert_eq!(input.send(&big), Ok(()));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while buf.lock().unwrap().len() < big.len() && std::time::Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert_eq!(buf.lock().unwrap().len(), big.len());
    }

    #[test]
    fn pty_input_oversized_write_still_blocks_followups_while_stuck() {
        let (_release, gate) = std::sync::mpsc::channel::<()>();
        let input = PtyInput::with_cap(Box::new(StuckSink(gate)), 4);
        assert_eq!(input.send(b"0123456789"), Ok(()));
        assert_eq!(input.send(b"e"), Err("input-queue-full".to_string()));
    }

    #[test]
    fn pty_input_reports_target_gone_after_writer_dies() {
        let input = PtyInput::spawn(Box::new(BrokenSink));
        let _ = input.send(b"x");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let mut res = Ok(());
        while std::time::Instant::now() < deadline {
            res = input.send(b"y");
            if res.is_err() {
                break;
            }
            std::thread::yield_now();
        }
        assert_eq!(res, Err("target-gone".to_string()));
    }
}
