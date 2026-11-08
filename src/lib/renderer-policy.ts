/**
 * Which renderer (DOM or WebGL) each terminal pane should use, decided by its
 * output rate. Pure bookkeeping — no DOM, no xterm — so the rules are
 * unit-testable; terminal-registry.ts applies the decisions off the hot path.
 *
 * Why (measured, docs/perf-baseline.md "Renderer policy"):
 * - A WebGL pane redraws its whole canvas on every frame it gets output, inside
 *   the shared rAF. With a dozen flooding panes on WebGL, xterm's write→parse
 *   latency rose from 0.7 ms to 9.9 ms and frames to 12.5 ms (scenario c), so
 *   a flooding pane belongs on the DOM renderer.
 * - Creating a context is a synchronous loadAddon (shader compile, atlas) and
 *   disposing it forces a refit. Releasing on hide and re-acquiring on show
 *   (perf phase 4) cost 400 creates and 1.6 s of loadAddon across 49
 *   workspace switches (scenario f). So contexts never follow visibility: a
 *   pane keeps its renderer while hidden, and swaps happen only on a sustained
 *   rate change, with a minimum dwell between swaps (hysteresis).
 * - Chromium caps live contexts per page (~16) and drops the oldest beyond it.
 *   Like 1.22.1, every pane gets WebGL at open; at the cap the policy evicts
 *   the oldest holder itself (`evictOnOpen`), so Chromium never has to. A
 *   5-pane cap with later promotion regressed scenarios d (15 agents) and f
 *   (16 visible panes) against 1.22.1.
 */

export type RendererKind = 'dom' | 'webgl'

export interface RendererPolicyOptions {
  /**
   * Most panes allowed on WebGL at once (0 = DOM only). The default is
   * Chromium's per-page limit: nothing else in the main webview uses WebGL
   * (previews are native child webviews), so a 16th context drops nothing.
   */
  maxWebgl: number
  /**
   * Panes get WebGL in their open step (within `maxWebgl`). Measured: a
   * TUI/flood pane only matches 1.22.1 when it is on WebGL from its first
   * frame; promoting it mid-stream never finds the idle time (scenario b).
   */
  openWebgl: boolean
  /**
   * A pane opening with the cap full takes the slot of the OLDEST holder
   * (which goes to DOM) instead of staying on DOM itself. This is what
   * 1.22.1 got from Chromium's context cap, minus the loss events: with 11
   * flooding panes opened before 20 idle ones (scenario c), the floods end up
   * on DOM and the newest panes on WebGL, which is the fast arrangement.
   */
  evictOnOpen: boolean
  /**
   * Busy WebGL panes are demoted only while at least this many panes are
   * visible: a few flooding panes render fastest on WebGL (scenarios a/b),
   * a dozen of them stall the shared frame (scenario c).
   */
  demoteMinVisible: number
  /**
   * …and only while at least this many panes (on any renderer) are busy
   * together, i.e. above `demoteBytesPerSec` for `demoteSustainMs`. The frame
   * stalls on the AGGREGATE: a dozen floods at once (scenario c) need DOM,
   * while agent panes take turns dumping (scenario d) and one or two
   * concurrent dumps render fastest on WebGL. Gating on visibility alone
   * demoted a d pane per long dump and, with promotion rarely finding idle
   * time, left a third of them on DOM by the end of a 150 s run (WebView CPU
   * +70 %, dump delivery p95 x2.5 against 1.22.1).
   */
  demoteMinBusy: number
  /**
   * Which panes get the WebGL slots: 'quiet' = interactive/low-rate panes
   * (busy ones are demoted), 'busy' = sustained high-rate panes (kept until
   * the pane is removed; quiet panes stay on DOM).
   */
  prefer: 'quiet' | 'busy'
  /** 'busy' mode: smoothed rate at which a pane qualifies for WebGL. */
  busyBytesPerSec: number
  /** Output rate (bytes/s, smoothed) above which a WebGL pane goes to DOM… */
  demoteBytesPerSec: number
  /**
   * …once it has stayed above it this long. Agent panes dump bursts (a diff,
   * a file) that exceed the rate for a moment; a flood is sustained. This is
   * the SMOOTHED rate: one burst of B bytes stays above the threshold for
   * about tau·ln(B/(tau·threshold)), so only a single dump of ~1.3 MB or
   * more is demoted too. 3 s, not 1 s: at 1 s every 100-400 KB tool dump of
   * a busy agent pane sent it to DOM, whose per-row rebuilds doubled scenario
   * d's dump delivery lag (p95 ~330 ms vs ~160 ms in 1.22.1). A real flood
   * (scenario c) stays above the rate for its whole run, so the 2 s later
   * demotion costs it little. A demoted pane re-promotes once quiet.
   */
  demoteSustainMs: number
  /** A DOM pane is promoted only while its rate stays below this… */
  promoteBytesPerSec: number
  /** …for at least this long, without a burst above `demoteBytesPerSec`. */
  promoteQuietMs: number
  /** Minimum time between two swaps of the same pane (hysteresis). */
  minDwellMs: number
  /** Time constant of the rate's exponential smoothing. */
  rateTauMs: number
}

export const DEFAULT_RENDERER_POLICY: RendererPolicyOptions = {
  maxWebgl: 16,
  openWebgl: true,
  evictOnOpen: true,
  demoteMinVisible: 8,
  demoteMinBusy: 4,
  prefer: 'quiet',
  busyBytesPerSec: 64 * 1024,
  demoteBytesPerSec: 64 * 1024,
  demoteSustainMs: 3000,
  // Not ~0: an agent pane never goes silent (spinner, streamed text at
  // ~20 KB/s), so a near-zero bar kept a pane that two close tool dumps had
  // demoted on DOM for the rest of the run (scenario d, one run in two).
  promoteBytesPerSec: 32 * 1024,
  promoteQuietMs: 3000,
  minDwellMs: 10_000,
  rateTauMs: 1000
}

interface PaneState {
  renderer: RendererKind
  /** Smoothed bytes/s as of `rateAt`. */
  rate: number
  rateAt: number
  /** Start of the current low-rate stretch, or undefined while busy. */
  quietSince: number | undefined
  /** Start of the current stretch above `demoteBytesPerSec`, or undefined. */
  busySince: number | undefined
  lastSwapAt: number
  visible: boolean
  /** WebGL failed for this pane (load error or context loss). */
  blocked: boolean
}

export interface RendererSwap<K> {
  key: K
  to: RendererKind
}

export interface RendererPolicy<K> {
  /** Register a pane on the DOM renderer. */
  add: (key: K, now: number) => void
  /**
   * At open: claim an open-time WebGL slot for an added pane (`webgl` = the
   * caller loads the addon now and the pane counts as WebGL). `evicted` is a
   * holder that lost its slot to this pane (`evictOnOpen`): it already counts
   * as DOM, and the caller disposes its addon.
   */
  claimOnOpen: (key: K, now: number) => { webgl: boolean; evicted: K | undefined }
  remove: (key: K) => void
  /** Record `bytes` of output. Hot path: O(1), no allocation. */
  recordOutput: (key: K, bytes: number, now: number) => void
  /** Only visible panes are promoted; hiding never demotes. */
  setVisible: (key: K, visible: boolean, now: number) => void
  /** The pane's WebGL failed: it is on DOM now and is never promoted again. */
  block: (key: K, now: number) => void
  renderer: (key: K) => RendererKind | undefined
  /** Smoothed rate as of `now` (for tests/diagnostics). */
  rate: (key: K, now: number) => number
  webglCount: () => number
  /** Registered panes. */
  size: () => number
  /**
   * The next swap to apply, or undefined. Demotions first (they free load),
   * then the quietest promotable pane. The caller `commit`s each swap; it may
   * apply all pending demotions (cheap disposes) together, but at most ONE
   * promotion (a synchronous loadAddon) per idle slice.
   */
  next: (now: number) => RendererSwap<K> | undefined
  commit: (swap: RendererSwap<K>, now: number) => void
}

export function createRendererPolicy<K>(
  opts: RendererPolicyOptions = DEFAULT_RENDERER_POLICY
): RendererPolicy<K> {
  const panes = new Map<K, PaneState>()
  let webgl = 0
  let visibleCount = 0
  /** WebGL panes in the order they got WebGL (eviction picks the first). */
  const holders = new Set<K>()

  function setRenderer(key: K, p: PaneState, to: RendererKind): void {
    if (p.renderer === to) return
    p.renderer = to
    if (to === 'webgl') {
      webgl++
      holders.add(key)
    } else {
      webgl--
      holders.delete(key)
    }
  }

  function decay(p: PaneState, now: number): void {
    const dt = now - p.rateAt
    if (dt <= 0) return
    const before = p.rate
    p.rate *= Math.exp(-dt / opts.rateTauMs)
    if (p.quietSince === undefined && p.rate < opts.promoteBytesPerSec) {
      // The moment the decay crossed the threshold, not the moment we looked.
      p.quietSince = p.rateAt + opts.rateTauMs * Math.log(before / opts.promoteBytesPerSec)
    }
    if (p.rate <= opts.demoteBytesPerSec) p.busySince = undefined
    p.rateAt = now
  }

  return {
    add(key, now) {
      if (panes.has(key)) return
      panes.set(key, {
        renderer: 'dom', rate: 0, rateAt: now, quietSince: now, busySince: undefined,
        lastSwapAt: -Infinity, visible: false, blocked: false
      })
    },
    claimOnOpen(key, now) {
      const no = { webgl: false, evicted: undefined }
      const p = panes.get(key)
      if (!p || p.blocked || p.renderer === 'webgl') return no
      if (!opts.openWebgl || opts.maxWebgl <= 0) return no
      let evicted: K | undefined
      if (webgl >= opts.maxWebgl) {
        if (!opts.evictOnOpen) return no
        // Sets iterate in insertion order: the first holder is the oldest.
        // Oldest even if it is visible and the new pane is hidden, on
        // purpose: it matches 1.22.1 (Chromium drops the oldest context),
        // which in scenario c puts the early flood panes on DOM. Evicting
        // the oldest HIDDEN holder first was screened (2026-10-24) and
        // regressed c (echo p95 41-47 vs 36 ms, frame p99 14 vs 9 ms) and
        // f (WebView CPU 1.8-1.9 vs 1.6 %) against 1.22.1.
        const oldest = holders.values().next()
        if (oldest.done === true) return no
        evicted = oldest.value
        const e = panes.get(evicted)!
        setRenderer(evicted, e, 'dom')
        // Dwell: a freed slot must not re-promote it just to be evicted again.
        e.lastSwapAt = now
      }
      // No lastSwapAt: a pane that turns out to flood may be demoted at once.
      setRenderer(key, p, 'webgl')
      return { webgl: true, evicted }
    },
    remove(key) {
      const p = panes.get(key)
      if (!p) return
      if (p.renderer === 'webgl') setRenderer(key, p, 'dom')
      if (p.visible) visibleCount--
      panes.delete(key)
    },
    recordOutput(key, bytes, now) {
      const p = panes.get(key)
      if (!p) return
      decay(p, now)
      // Impulse into the EWMA: a steady stream of r bytes/s settles at r.
      p.rate += bytes * 1000 / opts.rateTauMs
      if (p.rate >= opts.promoteBytesPerSec) p.quietSince = undefined
      if (p.rate > opts.demoteBytesPerSec && p.busySince === undefined) p.busySince = now
    },
    setVisible(key, visible, now) {
      const p = panes.get(key)
      if (!p) return
      decay(p, now)
      if (p.visible !== visible) visibleCount += visible ? 1 : -1
      p.visible = visible
    },
    block(key, now) {
      const p = panes.get(key)
      if (!p) return
      setRenderer(key, p, 'dom')
      p.blocked = true
      p.lastSwapAt = now
    },
    renderer: (key) => panes.get(key)?.renderer,
    rate(key, now) {
      const p = panes.get(key)
      if (!p) return 0
      decay(p, now)
      return p.rate
    },
    webglCount: () => webgl,
    size: () => panes.size,
    next(now) {
      const busy = opts.prefer === 'busy'
      let promote: K | undefined
      let best = busy ? -Infinity : Infinity
      // Counts sustained-busy panes on either renderer, so demotion goes on
      // (hysteresis) until fewer than demoteMinBusy floods are left.
      let busyPanes = 0
      for (const p of panes.values()) {
        decay(p, now)
        if (p.busySince !== undefined && now - p.busySince >= opts.demoteSustainMs) busyPanes++
      }
      const demoting = !busy && visibleCount >= opts.demoteMinVisible && busyPanes >= opts.demoteMinBusy
      for (const [key, p] of panes) {
        if (now - p.lastSwapAt < opts.minDwellMs) continue
        if (p.renderer === 'webgl') {
          if (demoting && p.busySince !== undefined && now - p.busySince >= opts.demoteSustainMs) return { key, to: 'dom' }
        } else if (!p.blocked && p.visible && webgl < opts.maxWebgl) {
          const ok = busy
            ? p.rate >= opts.busyBytesPerSec && p.rate > best
            : p.quietSince !== undefined && now - p.quietSince >= opts.promoteQuietMs && p.rate < best
          if (ok) {
            promote = key
            best = p.rate
          }
        }
      }
      return promote === undefined ? undefined : { key: promote, to: 'webgl' }
    },
    commit(swap, now) {
      const p = panes.get(swap.key)
      if (!p || p.renderer === swap.to) return
      setRenderer(swap.key, p, swap.to)
      p.lastSwapAt = now
    }
  }
}
