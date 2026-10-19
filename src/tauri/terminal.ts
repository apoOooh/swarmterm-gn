import { invoke, Channel } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { ShellId } from '@/lib/terminal-pref'

/** Output streamed from a pty: decoded text, then a final exit. */
export type PtyOut =
  | { type: 'data'; payload: string }
  | { type: 'replay'; payload: PtyReplay }
  | { type: 'exit'; payload: { exitCode: number } }

/**
 * A pane taken over from the terminal host (SWA-56): its history, rendered
 * at `cols`×`rows`. `truncated` = the host's ring dropped older output.
 */
export interface PtyReplay {
  data: string
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

/** Spawn a pty; `onOutput` receives every data chunk and the final exit. */
export function createTerminal(
  id: string,
  options: CreateTerminalOptions,
  onOutput: (msg: PtyOut) => void
): Promise<CreateTerminalResult> {
  const onData = new Channel<PtyOut>()
  onData.onmessage = onOutput
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
