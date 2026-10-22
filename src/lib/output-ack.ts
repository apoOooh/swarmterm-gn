/**
 * Output flow control, renderer half (perf phase 2).
 *
 * `term.write` has no backpressure: under a flood, IPC strings pile up in
 * xterm's write queue and WebView memory. Rust parks a pane's flusher while
 * more than 512 KB are unacknowledged (`host/src/flow.rs`), so the renderer
 * acks bytes once xterm has PARSED them (the `term.write` callback). Acks
 * are batched: one IPC call per `ACK_CHUNK`, never one per write. The
 * remainder below a chunk is never acked, which is harmless: it is far
 * below the watermarks.
 */

/** Bytes per `ack_output` call. */
export const ACK_CHUNK = 64 * 1024

/**
 * Acks for ONE pty generation. Output can arrive before `create_terminal`
 * answers with the generation id, so bytes are held until `setSpawnId`.
 */
export class OutputAcker {
  private pending = 0
  private spawnId: string | null = null

  constructor(
    private readonly send: (spawnId: string, bytes: number) => void,
    private readonly chunk = ACK_CHUNK
  ) {}

  setSpawnId(spawnId: string): void {
    this.spawnId = spawnId
    this.maybeSend()
  }

  /** xterm parsed `bytes` more of this generation's output. */
  parsed(bytes: number): void {
    this.pending += bytes
    this.maybeSend()
  }

  private maybeSend(): void {
    if (this.spawnId === null || this.pending < this.chunk) return
    const bytes = this.pending
    this.pending = 0
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
