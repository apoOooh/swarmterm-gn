import { evaluateManifest } from '@/lib/agent-state/engine'
import { inSpawnGrace, shouldSkipScreenScan, TICK_MS } from '@/lib/agent-state/detect-schedule'
import {
  isHookLive,
  resolveHookState,
  type HookMark,
  type HookSignal
} from '@/lib/agent-state/hook-signal'
import { decideIdleHold, PENDING_IDLE_RECHECK_MS, type PendingIdle } from '@/lib/agent-state/pending-idle'
import { buildSnapshot, type BufferView } from '@/lib/agent-state/snapshot'
import type { AgentEngineState, Manifest } from '@/lib/agent-state/types'

/** OSC titles arrive raw from the program; herdr strips control chars and
 *  caps length (src/pane/osc.rs:448-527). No whitespace collapse — the
 *  spinner rules anchor on `<spinner><space>` prefixes. */
const OSC_MAX_CHARS = 256
const sanitizeOsc = (raw: string): string =>
  // eslint-disable-next-line no-control-regex
  raw.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').slice(0, OSC_MAX_CHARS)

export interface DetectorDeps {
  getView(): BufferView | null
  isPaneWatched(): boolean
  publish(state: AgentEngineState, opts: { paneWatched: boolean; nowMs: number }): void
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

/**
 * Per-terminal detection loop. Timer-driven rather than per-output-chunk
 * (herdr's design): a busy agent redraws its spinner dozens of times per
 * second, and scraping on every chunk would burn CPU for identical
 * verdicts. Output only bumps a sequence counter; the 300ms tick skips the
 * screen read entirely while idle with an unchanged counter, so a quiet
 * pane costs nothing. All side effects (clock, timers, store publish, xterm
 * buffer) are injected so the loop is testable with a manual clock.
 */
export class AgentStateDetector {
  private readonly manifest: Manifest
  private readonly deps: DetectorDeps
  private oscTitle = ''
  private oscProgress = ''
  private contentSeq = 0
  private lastScannedSeq = -1
  /** Clock of the last completed scan. A hook mark that was live then but has
   *  expired since must force one more scan: its TTL expiry changes the
   *  verdict on a pane that prints nothing (see `hookUnobserved`). */
  private lastScanAt = Number.NEGATIVE_INFINITY
  private spawnedAt: number
  private state: AgentEngineState = 'unknown'
  private pending: PendingIdle | null = null
  /** Latest Claude Code hook edge (`agent:hook`). Hooks are exact — Claude
   *  itself reported the turn ending or a permission prompt — whereas the
   *  scrape is a guess over a redraw, so a live mark overrules the scrape
   *  (`resolveHookState`). Only its TTL retires it: Claude fires no Stop on
   *  an Esc interrupt, so nothing else ever would. */
  private hook: HookMark | null = null
  private timer: unknown = null
  private exited = false
  private disposed = false

  constructor(manifest: Manifest, deps: DetectorDeps) {
    this.manifest = manifest
    this.deps = deps
    this.spawnedAt = deps.now()
  }

  start(): void {
    this.schedule(TICK_MS)
  }

  noteOutput(): void {
    this.contentSeq++
  }

  // OSC title/progress are verdict inputs too, so they bump the seq like
  // output: the unchanged-seq scan skip must never hide a title change.
  noteTitle(rawTitle: string): void {
    this.oscTitle = sanitizeOsc(rawTitle)
    this.contentSeq++
  }

  noteProgress(payload: string): void {
    this.oscProgress = sanitizeOsc(payload)
    this.contentSeq++
  }

  /** A Claude Code hook fired for this pane. `forget` (SessionEnd) drops the
   *  mark rather than being one — the pane is a plain shell again and the
   *  scrape must rule. The mark is stamped with the detector clock, NOT the
   *  event's own `atMs`: one clock drives both the TTL and the tick
   *  scheduler (which keeps the manual-clock harness honest), and Tauri
   *  events are FIFO so the ordering the timestamp would encode is already
   *  guaranteed. Then tick immediately: the edge should land now, not up to
   *  300 ms later — and on an idle pane with unchanged output the regular
   *  cadence would have skipped the scan entirely. */
  noteHook(signal: HookSignal | 'forget'): void {
    if (this.disposed || this.exited) return
    this.hook = signal === 'forget' ? null : { signal, atMs: this.deps.now() }
    // A hook change is a verdict input like output: bump the seq so the
    // unchanged-seq skip (idle or working) cannot swallow it — `forget` in
    // particular leaves no live mark behind to disable the skip.
    this.contentSeq++
    this.schedule(0)
  }

  /** Pty exited or errored: stop detecting, drop to unknown so the UI falls
   *  back to the plain activity dot instead of freezing a stale state. Clear
   *  the pending timer too — tick()'s exited early-return already declines to
   *  reschedule, so this is just hygiene, but it stops a stale timer handle
   *  from lingering (and being mistaken for live) between exit and reset(). */
  noteExit(): void {
    this.exited = true
    this.pending = null
    this.hook = null
    this.setState('unknown')
    if (this.timer !== null) this.deps.clearTimer(this.timer)
    this.timer = null
  }

  /** Respawn (agent/cwd/shell switch or retry): the screen and OSC evidence
   *  describe a pty that no longer exists. Re-arm the spawn grace. tick()
   *  deliberately stops rescheduling once `exited`, so nothing else will ever
   *  fire again unless we schedule here — without this, a same-id respawn
   *  (retryTerminal, or refreshDetector reusing the existing detector because
   *  the manifest didn't change) leaves the loop dead forever. */
  reset(): void {
    this.oscTitle = ''
    this.oscProgress = ''
    this.pending = null
    // A respawned pty must not inherit a stale `blocked` from the old one.
    this.hook = null
    this.exited = false
    this.spawnedAt = this.deps.now()
    this.lastScannedSeq = -1
    this.lastScanAt = Number.NEGATIVE_INFINITY
    this.setState('unknown')
    this.schedule(TICK_MS)
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== null) this.deps.clearTimer(this.timer)
    this.timer = null
  }

  private setState(state: AgentEngineState): void {
    if (this.state === state) return
    this.state = state
    this.deps.publish(state, { paneWatched: this.deps.isPaneWatched(), nowMs: this.deps.now() })
  }

  private schedule(ms: number): void {
    if (this.disposed) return
    if (this.timer !== null) this.deps.clearTimer(this.timer)
    this.timer = this.deps.setTimer(() => {
      this.timer = null
      this.tick()
    }, ms)
  }

  /** The hook still needs scans: live now, or live at the last scan and
   *  expired since (the expiry tick must run the scrape fallback — a silent
   *  `working` pane after an Esc interrupt would otherwise stay working). */
  private hookUnobserved(now: number): boolean {
    // `lastScanAt` starts (and resets) at -Infinity, so before the first scan
    // the second test is always false: only a hook live NOW forces a scan.
    return isHookLive(this.hook, now) || isHookLive(this.hook, this.lastScanAt)
  }

  private tick(): void {
    if (this.disposed || this.exited) return
    const now = this.deps.now()
    if (inSpawnGrace(this.spawnedAt, now)) {
      this.schedule(TICK_MS)
      return
    }
    if (
      shouldSkipScreenScan({
        state: this.state,
        contentSeq: this.contentSeq,
        lastScannedSeq: this.lastScannedSeq,
        pendingIdle: this.pending !== null,
        hookActive: this.hookUnobserved(now)
      })
    ) {
      this.schedule(TICK_MS)
      return
    }
    const view = this.deps.getView()
    if (view === null) {
      this.schedule(TICK_MS)
      return
    }
    // Capture the seq BEFORE scanning: output racing in during the scan must
    // trigger a fresh scan next tick, not be silently absorbed.
    const seq = this.contentSeq
    let verdictState: AgentEngineState | null = null
    try {
      const verdict = evaluateManifest(this.manifest, {
        screen: buildSnapshot(view),
        oscTitle: this.oscTitle,
        oscProgress: this.oscProgress
      })
      this.lastScannedSeq = seq
      this.lastScanAt = now
      if (!verdict.skip) {
        // Hook precedence runs BEFORE the idle hold: the hold exists to
        // confirm a scraped idle over three quiet rechecks, and a Stop hook
        // IS that confirmation — so it publishes idle on this very tick.
        // Every other resolution still goes through the hold with the
        // resolved state substituted, so a hook-working verdict over a
        // false-idle frame is seen as working (no hold opens) while a
        // scrape-only idle after an expired mark is held as before.
        const resolved = resolveHookState({ hook: this.hook, scrape: verdict, now })
        if (resolved.bypassIdleHold) {
          this.pending = null
          verdictState = resolved.state
        } else {
          const decision = decideIdleHold({
            prev: this.state,
            next: { ...verdict, state: resolved.state },
            pending: this.pending,
            now,
            processExited: this.exited
          })
          this.pending = decision.pending
          if (decision.publish) verdictState = resolved.state
        }
      }
    } catch (err) {
      // A broken rule must degrade to the old activity-dot behavior, never
      // take the terminal down with it. Log once per detector, and actually
      // publish unknown — paneDot() only falls back to the activity dot for
      // unknown/undetected, so without this the pane would freeze on
      // whatever state it last held instead of degrading.
      if (!this.warned) {
        this.warned = true
        console.warn('agent-state detection failed; pane falls back to activity dot', err)
      }
      this.setState('unknown')
    }
    if (verdictState !== null) this.setState(verdictState)
    this.schedule(this.pending !== null ? PENDING_IDLE_RECHECK_MS : TICK_MS)
  }

  private warned = false
}
