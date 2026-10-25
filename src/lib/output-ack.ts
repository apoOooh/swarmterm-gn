/**
 * Output flow control, renderer half (perf phase 2).
 *
 * `term.write` has no backpressure: under a flood, IPC strings pile up in
 * xterm's write queue and WebView memory. Rust parks a pane's flusher while
 * more than 2 MB are unacknowledged (`host/src/flow.rs`), so the renderer
 * acks bytes once xterm has PARSED them (the `term.write` callback). Acks
 * are batched: one IPC call and one parse callback per `ACK_CHUNK`, never
 * one per write. The
 * remainder below a chunk is never acked, which is harmless: it is far
 * below the watermarks.
 */

/**
 * Bytes per `ack_output` call. Must stay at most half of Rust's `FLOW_LOW`
 * (`host/src/flow.rs`, 512 KB): the unacked remainder below one chunk must
 * not keep a parked gate above its resume mark (it would only reopen on the
 * 2 s no-ack timeout).
 */
export const ACK_CHUNK = 256 * 1024

/**
 * Acks for ONE pty generation. Output can arrive before `create_terminal`
 * answers with the generation id, so bytes are held until `setSpawnId`.
 *
 * xterm parses writes in order, so one parse callback covers every write
 * before it: `write` hands out a callback only for the write that crosses
 * the next `chunk` boundary (one per ACK_CHUNK instead of one closure and one
 * xterm callback per write), and that callback acks everything up to it.
 */
export class OutputAcker {
  /** Bytes handed to xterm so far. */
  private written = 0
  /** `written` at the last write that got a callback. */
  private marked = 0
  /** Bytes known parsed (highest mark whose callback ran). */
  private parsedTo = 0
  private acked = 0
  private spawnId: string | null = null

  constructor(
    private readonly send: (spawnId: string, bytes: number) => void,
    private readonly chunk = ACK_CHUNK
  ) {}

  setSpawnId(spawnId: string): void {
    this.spawnId = spawnId
    this.maybeSend()
  }

  /**
   * `bytes` more go to xterm; returns the parse callback to pass with this
   * write, or undefined when a later write's callback will cover it.
   */
  write(bytes: number): (() => void) | undefined {
    this.written += bytes
    if (this.written - this.marked < this.chunk) return undefined
    const mark = this.written
    this.marked = mark
    return () => {
      if (mark > this.parsedTo) this.parsedTo = mark
      this.maybeSend()
    }
  }

  private maybeSend(): void {
    if (this.spawnId === null || this.parsedTo - this.acked < this.chunk) return
    const bytes = this.parsedTo - this.acked
    this.acked = this.parsedTo
    this.send(this.spawnId, bytes)
  }
}

/**
 * UTF-8 size of a string from Rust (always valid UTF-8, so surrogates come
 * in pairs). Counting beats `TextEncoder.encode`: no allocation per batch.
 */
export function utf8Length(s: string): number {
  let n = s.length
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) continue
    if (c < 0x800) n += 1
    else if (c >= 0xd800 && c <= 0xdbff) { n += 2; i++ } // pair: 2 units -> 4 bytes
    else n += 2
  }
  return n
}
