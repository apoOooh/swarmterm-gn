import { invoke, Channel } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { ShellId } from '@/lib/terminal-pref'

/**
 * Output streamed from a pty: UTF-8 bytes, then a final exit. Arrives as a
 * raw binary IPC body (perf phase 3), decoded by `decodePtyOut`.
 */
export type PtyOut =
  | { type: 'data'; payload: Uint8Array | string }
  | { type: 'replay'; payload: PtyReplay }
  | { type: 'exit'; payload: { exitCode: number } }

/**
 * A pane taken over from the terminal host (SWA-56): its history, rendered
 * at `cols`×`rows`. `truncated` = the host's ring dropped older output.
 */
export interface PtyReplay {
  /** UTF-8 bytes of the history. */
  data: Uint8Array
  cols: number
  rows: number
  truncated: boolean
}

export interface CreateTerminalOptions {
  agentId?: string
  accountId?: string
  cwd?: string
  shellId?: ShellId
  initialCommand?: string
  worktreeMode?: boolean
  repoRoot?: string
  cols: number
  rows: number
}

export interface CreateTerminalResult {
  ok: boolean
  pid?: number
  shell?: string
  error?: string
  /** The pty generation, named by `ackOutput` (flow control). */
  spawnId?: string
}

/** Trailing tags of an encoded `PtyOut` (mirror of `pty.rs` `OUT_*`). */
export const OUT_DATA = 0
export const OUT_REPLAY = 1
export const OUT_EXIT = 2

const headerDecoder = new TextDecoder()

/**
 * Decode one channel message. Wire layout (`PtyOut::encode` in `pty.rs`):
 * `[body][header json][header_len: u16 LE][tag: u8]`. The body is returned
 * as a view, never copied: it is exactly the bytes Rust's flow gate counted,
 * so acking its `byteLength` keeps the gate in step.
 */
export function decodePtyOut(raw: ArrayBuffer | Uint8Array): PtyOut {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw)
  const n = bytes.length
  if (n < 3) throw new Error(`pty output frame too short (${n} bytes)`)
  const tag = bytes[n - 1]
  const headerLen = bytes[n - 3] | (bytes[n - 2] << 8)
  const bodyEnd = n - 3 - headerLen
  if (bodyEnd < 0) throw new Error('pty output header overruns frame')
  const body = bytes.subarray(0, bodyEnd)
  const header = (): Record<string, unknown> =>
    JSON.parse(headerDecoder.decode(bytes.subarray(bodyEnd, n - 3))) as Record<string, unknown>
  switch (tag) {
    case OUT_DATA:
      return { type: 'data', payload: body }
    case OUT_REPLAY: {
      const h = header()
      return {
        type: 'replay',
        payload: {
          data: body,
          cols: Number(h.cols),
          rows: Number(h.rows),
          truncated: h.truncated === true
        }
      }
    }
    case OUT_EXIT:
      return { type: 'exit', payload: { exitCode: Number(header().exitCode) } }
    default:
      throw new Error(`unknown pty output tag ${tag}`)
  }
}

/**
 * Decode one channel message: a small data batch arrives as a JSON string
 * (`DIRECT_JSON_LIMIT` in `pty.rs`: Tauri evaluates it directly, while a
 * raw body of 1 KiB or more costs a fetch per message), everything else as
 * a raw frame for `decodePtyOut`. The string goes to xterm as is: re-encoding
 * it cost an allocation per batch and made xterm decode UTF-8 again; the
 * ack counts its UTF-8 size with `utf8Length` instead.
 */
// Mixing string and byte writes into one xterm is safe: Rust ends every
// batch on a character boundary (`take_valid_utf8`), so xterm's UTF-8
// decoder never holds a partial sequence across a switch.
export function decodeChannelMessage(raw: ArrayBuffer | Uint8Array | string): PtyOut {
  if (typeof raw === 'string') return { type: 'data', payload: raw }
  return decodePtyOut(raw)
}

/** Spawn a pty; `onOutput` receives every data chunk and the final exit. */
export function createTerminal(
  id: string,
  options: CreateTerminalOptions,
  onOutput: (msg: PtyOut) => void
): Promise<CreateTerminalResult> {
  const onData = new Channel<ArrayBuffer | string>()
  onData.onmessage = (raw) => onOutput(decodeChannelMessage(raw))
  return invoke<CreateTerminalResult>('create_terminal', { id, options, onData })
}

let inputDropped: ((id: string) => void) | undefined
let hostDropListener: Promise<() => void> | undefined

/** Register who tells the user that a pane's input was dropped (queue full). */
export function setInputDroppedHandler(handler: ((id: string) => void) | undefined): void {
  inputDropped = handler
  // A pane in the terminal host (SWA-55) cannot reject the write call
  // itself — Rust only enqueues it for the pipe — so its full queue arrives
  // later as an event. One listener for the app's lifetime.
  hostDropListener ??= listen<string>('pty:input-dropped', (e) => inputDropped?.(e.payload))
}

/**
 * Enqueue input for a pty. Never rejects: callers fire and forget. A full
 * input queue (the pane stopped reading) is reported through the registered
 * handler; any other failure (pane already gone) is ignored as before.
 */
export const writeTerminal = (id: string, data: string): Promise<void> =>
  invoke<void>('write_terminal', { id, data }).catch((err: unknown) => {
    if (isInputQueueFull(err)) inputDropped?.(id)
  })

export function isInputQueueFull(err: unknown): boolean {
  return String(err) === 'input-queue-full'
}

export const resizeTerminal = (id: string, cols: number, rows: number): Promise<void> =>
  invoke('resize_terminal', { id, cols, rows })

export const killTerminal = (id: string): Promise<void> => invoke('kill_terminal', { id })

/**
 * xterm parsed `bytes` more of generation `spawnId`'s output (perf phase 2
 * flow control, batched by `lib/output-ack.ts`). Fire and forget: a lost ack
 * only makes Rust's gate time out open.
 */
export const ackOutput = (id: string, spawnId: string, bytes: number): void => {
  invoke('ack_output', { id, spawnId, bytes }).catch(() => undefined)
}

/** The renderer stopped consuming generation `spawnId` (pane disposed). */
export const releaseOutput = (id: string, spawnId: string): void => {
  invoke('release_output', { id, spawnId }).catch(() => undefined)
}

/**
 * Screen-independent liveness proof: true only if a process matching the
 * pane's agent runs below its shell. Any doubt answers false (fail closed).
 */
export const isTerminalAgentAlive = (id: string): Promise<boolean> =>
  invoke<boolean>('terminal_agent_alive', { id })

/**
 * Write that Rust only performs while the pane still runs the PTY generation
 * the caller pinned (voice dictation). Rejects with `target-gone` after a
 * respawn or exit; resolving is the delivery ACK.
 */
export const writeTerminalChecked = (id: string, expectedSpawnId: string, data: string): Promise<void> =>
  invoke('write_terminal_checked', { id, expectedSpawnId, data })
