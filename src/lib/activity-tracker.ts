/**
 * Debounced active/idle state machine, keyed by an arbitrary target. Marks a
 * target "active" on the first notify and flips it back to idle after `idleMs`
 * of quiet, coalescing repeated notifies. DOM-agnostic and timer-driven so it
 * is unit-testable under the `node` test environment.
 *
 * Two consumers: the minimal-overlay scrollbars (reveal-while-scrolling, see
 * scrollbar-activity.ts) and the per-terminal activity indicator (yellow while
 * a pty streams output, see terminal-registry.ts).
 */
const DEFAULT_IDLE_MS = 900

export class ActivityTracker<T> {
  private readonly setActive: (target: T, active: boolean) => void
  private readonly idleMs: number
  private readonly timers = new Map<T, ReturnType<typeof setTimeout>>()
  /** Time of each active target's latest notify. */
  private readonly last = new Map<T, number>()

  constructor(setActive: (target: T, active: boolean) => void, idleMs: number = DEFAULT_IDLE_MS) {
    this.setActive = setActive
    this.idleMs = idleMs
  }

  /**
   * Record a tick from `target`. Activates it if idle; pushes its idle
   * deadline out. Hot path (every output batch of every pane): only a time
   * stamp, no clearTimeout/setTimeout pair per call. The one pending timer
   * re-arms itself for the remainder when ticks came in meanwhile.
   */
  notify(target: T): void {
    this.last.set(target, Date.now())
    if (this.timers.has(target)) return
    this.setActive(target, true)
    this.arm(target, this.idleMs)
  }

  private arm(target: T, ms: number): void {
    this.timers.set(
      target,
      setTimeout(() => {
        // Clamped: a wall-clock step back must not stretch the re-arm past
        // idleMs (Date.now, not performance.now, so fake timers drive it).
        const quiet = Math.max(0, Date.now() - (this.last.get(target) ?? 0))
        if (quiet < this.idleMs) {
          this.arm(target, this.idleMs - quiet)
          return
        }
        this.timers.delete(target)
        this.last.delete(target)
        this.setActive(target, false)
      }, ms)
    )
  }

  /**
   * Drop a single target's pending idle timer WITHOUT firing its idle callback.
   * Used when the target is being destroyed and its state is cleared elsewhere,
   * so a late timer can't re-introduce a stale entry.
   */
  cancel(target: T): void {
    const timer = this.timers.get(target)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.timers.delete(target)
    }
    this.last.delete(target)
  }

  /** Cancel all pending idle timers (no deactivation callbacks fire). */
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.last.clear()
  }
}
