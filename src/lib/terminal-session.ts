import type {
  CreateTerminalOptions,
  CreateTerminalResult,
  PtyOut,
  PtyReplay
} from '@/tauri/terminal'
import { OutputAcker, utf8Length } from '@/lib/output-ack'

export type TerminalStatus =
  | { kind: 'connecting' }
  | { kind: 'running' }
  | { kind: 'error'; message: string }
  | { kind: 'exited'; exitCode: number }

/** Where decoded pty output is pumped (the xterm instance, in production). */
export interface SessionSink {
  /** `onParsed` must run once xterm parsed `data` (flow-control acks). */
  write: (data: Uint8Array | string, onParsed?: () => void) => void
  /**
   * History of a pane taken over from the terminal host (SWA-56), first
   * message of that generation. Not new output: no activity tick, and
   * terminal queries inside it must not be answered toward the pty.
   */
  replay?: (replay: PtyReplay, onParsed?: () => void) => void
}

/** Tauri bridge functions, injected so the session is testable without Tauri. */
export interface SessionDeps {
  createTerminal: (
    id: string,
    options: CreateTerminalOptions,
    onOutput: (msg: PtyOut) => void
  ) => Promise<CreateTerminalResult>
  killTerminal: (id: string) => Promise<void>
  /** Flow-control ack (`ack_output`); absent = no acks (tests). */
  ackOutput?: (id: string, spawnId: string, bytes: number) => void
  /** Nobody will ack this generation any more (`release_output`). */
  releaseOutput?: (id: string, spawnId: string) => void
}

/**
 * The pty half of one terminal, decoupled from xterm and React. It spawns the
 * backend pty exactly once and lives until explicitly disposed — so a pane that
 * unmounts/remounts (e.g. when a sibling closes and the split tree collapses)
 * keeps the same running shell instead of killing and re-spawning it.
 */
export class TerminalSession {
  private status: TerminalStatus = { kind: 'connecting' }
  private readonly listeners = new Set<() => void>()
  private started = false
  private disposed = false
  /** Bumped on retry/dispose to drop callbacks from a superseded pty channel. */
  private generation = 0
  /** Options to spawn with once the current (being-killed) pty reports exit. */
  private pendingRespawn: CreateTerminalOptions | null = null
  /** Live generation's id, for `releaseOutput` on dispose. */
  private spawnId: string | null = null

  constructor(
    readonly id: string,
    private readonly sink: SessionSink,
    private readonly deps: SessionDeps
  ) {}

  getStatus(): TerminalStatus {
    return this.status
  }

  /** Current pty generation; changes on every retry/respawn/dispose. */
  getGeneration(): number {
    return this.generation
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(status: TerminalStatus): void {
    this.status = status
    for (const listener of this.listeners) listener()
  }

  /** Spawn the pty. No-op once started, so repeated mounts never re-spawn. */
  start(options: CreateTerminalOptions): void {
    if (this.started || this.disposed) return
    this.started = true
    this.spawn(options)
  }

  /** Re-spawn after an exit or error. Caller should reset the sink first. */
  retry(options: CreateTerminalOptions): void {
    if (this.disposed) return
    this.generation += 1
    this.started = true
    this.spawn(options)
  }

  /**
   * Restart a running pty with new options (agent / cwd / shell switch). The
   * backend frees a terminal id only once its process exits, and rejects a
   * duplicate live id — so kill the current pty and defer the fresh spawn until
   * its exit is observed (the backend frees the id just before sending it). If
   * the pty isn't currently live, spawn immediately, like retry.
   */
  respawn(options: CreateTerminalOptions): void {
    if (this.disposed) return
    const live =
      this.started && this.status.kind !== 'exited' && this.status.kind !== 'error'
    if (!live) {
      this.retry(options)
      return
    }
    this.pendingRespawn = options
    this.emit({ kind: 'connecting' })
    void this.deps.killTerminal(this.id)
  }

  /** Kill the pty and tear down. Idempotent. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    // The xterm goes away with us: open Rust's flow gate now instead of
    // letting the flusher sit out the no-ack timeout.
    if (this.spawnId !== null) this.deps.releaseOutput?.(this.id, this.spawnId)
    this.spawnId = null
    if (this.started) void this.deps.killTerminal(this.id)
  }

  private spawn(options: CreateTerminalOptions): void {
    const generation = this.generation
    const fresh = (): boolean => generation === this.generation && !this.disposed
    let exited = false
    // The previous generation is gone; a dispose before this create
    // resolves is handled in `.then` below.
    this.spawnId = null
    // Per generation: acks name the generation, and a respawn starts a new
    // account in Rust.
    const ackOutput = this.deps.ackOutput
    const acker = ackOutput
      ? new OutputAcker((spawnId, bytes) => ackOutput(this.id, spawnId, bytes))
      : null
    const parsed = (data: Uint8Array | string): (() => void) | undefined => {
      if (!acker) return undefined
      // The exact bytes Rust's gate counted for this message.
      const bytes = typeof data === 'string' ? utf8Length(data) : data.byteLength
      return () => acker.parsed(bytes)
    }

    this.emit({ kind: 'connecting' })

    this.deps
      .createTerminal(this.id, options, (msg) => {
        // Track this generation's death even after disposal, so a delayed
        // create acknowledgement cannot kill a later PTY using the same id.
        if (msg.type === 'exit') exited = true
        if (!fresh()) return
        if (msg.type === 'data') {
          this.sink.write(msg.payload, parsed(msg.payload))
        } else if (msg.type === 'replay') {
          // The host counts the replay against the gate like live output.
          const done = parsed(msg.payload.data)
          if (this.sink.replay) this.sink.replay(msg.payload, done)
          else this.sink.write(msg.payload.data, done)
        } else {
          if (this.pendingRespawn) {
            const next = this.pendingRespawn
            this.pendingRespawn = null
            this.retry(next)
          } else {
            this.emit({ kind: 'exited', exitCode: msg.payload.exitCode })
          }
        }
      })
      .then((result) => {
        if (result.ok && result.spawnId) {
          acker?.setSpawnId(result.spawnId)
          if (fresh()) this.spawnId = result.spawnId
        }
        if (!fresh()) {
          // dispose may have killed before the asynchronous spawn inserted a
          // PTY. Only a disposed session owns this cleanup: a superseded live
          // generation may already have a replacement using the same id.
          if (this.disposed && result.ok && !exited) {
            if (result.spawnId) this.deps.releaseOutput?.(this.id, result.spawnId)
            void this.deps.killTerminal(this.id)
          }
          return
        }
        if (!result.ok) {
          // A newer profile/configuration selected during a failed start can
          // proceed immediately: the failed creation owns no native PTY.
          if (this.pendingRespawn) {
            const next = this.pendingRespawn
            this.pendingRespawn = null
            this.retry(next)
          } else this.emit({ kind: 'error', message: result.error ?? 'Unknown error' })
        }
        else if (!exited) {
          // An agent/profile switch can request a kill while creation is still
          // pending. Repeat it now that the native PTY actually exists.
          if (this.pendingRespawn) void this.deps.killTerminal(this.id)
          else this.emit({ kind: 'running' })
        }
      })
      .catch((err: unknown) => {
        if (!fresh()) return
        this.emit({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      })
  }
}
