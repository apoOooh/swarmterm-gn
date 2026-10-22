import { describe, expect, it } from 'vitest'
import { createRendererPolicy, type RendererPolicyOptions } from './renderer-policy'

const OPTS: RendererPolicyOptions = {
  maxWebgl: 2,
  openWebgl: false,
  evictOnOpen: false,
  demoteMinVisible: 0,
  prefer: 'quiet',
  busyBytesPerSec: 64 * 1024,
  demoteBytesPerSec: 64 * 1024,
  demoteSustainMs: 0,
  promoteBytesPerSec: 2 * 1024,
  promoteQuietMs: 3000,
  minDwellMs: 10_000,
  rateTauMs: 1000
}

/** Feed `bytesPerSec` in 10 ms chunks from `from` to `to`. */
function stream(p: ReturnType<typeof createRendererPolicy<string>>, key: string, bytesPerSec: number, from: number, to: number): void {
  for (let t = from; t < to; t += 10) p.recordOutput(key, bytesPerSec / 100, t)
}

function promoteAll(p: ReturnType<typeof createRendererPolicy<string>>, now: number): void {
  for (let s = p.next(now); s; s = p.next(now)) p.commit(s, now)
}

describe('renderer policy', () => {
  it('starts every pane on DOM and promotes nothing with maxWebgl 0', () => {
    const p = createRendererPolicy<string>({ ...OPTS, maxWebgl: 0 })
    p.add('a', 0)
    p.setVisible('a', true, 0)
    expect(p.renderer('a')).toBe('dom')
    expect(p.next(60_000)).toBeUndefined()
  })

  it('promotes a visible quiet pane only after the quiet period', () => {
    const p = createRendererPolicy<string>(OPTS)
    p.add('a', 0)
    p.setVisible('a', true, 0)
    expect(p.next(2999)).toBeUndefined()
    expect(p.next(3000)).toEqual({ key: 'a', to: 'webgl' })
  })

  it('never promotes a hidden pane', () => {
    const p = createRendererPolicy<string>(OPTS)
    p.add('a', 0)
    expect(p.next(10_000)).toBeUndefined()
  })

  it('smoothed rate settles near the stream rate', () => {
    const p = createRendererPolicy<string>(OPTS)
    p.add('a', 0)
    stream(p, 'a', 100_000, 0, 5000)
    expect(p.rate('a', 5000)).toBeGreaterThan(90_000)
    expect(p.rate('a', 5000)).toBeLessThan(110_000)
  })

  it('a flooding pane is not promoted, and a burst restarts the quiet clock', () => {
    const p = createRendererPolicy<string>(OPTS)
    p.add('a', 0)
    p.setVisible('a', true, 0)
    stream(p, 'a', 500_000, 0, 5000)
    expect(p.next(5000)).toBeUndefined()
    // Rate decays below the promote threshold after ~5.5 tau; quiet 3 s after that.
    expect(p.next(9000)).toBeUndefined()
    expect(p.next(14_000)).toEqual({ key: 'a', to: 'webgl' })
  })

  it('demotes a WebGL pane that starts flooding, respecting the dwell time', () => {
    const p = createRendererPolicy<string>(OPTS)
    p.add('a', 0)
    p.setVisible('a', true, 0)
    p.commit({ key: 'a', to: 'webgl' }, 3000)
    stream(p, 'a', 500_000, 3000, 6000)
    expect(p.next(6000)).toBeUndefined() // dwell: swapped at 3000
    stream(p, 'a', 500_000, 6000, 13_000)
    expect(p.next(13_000)).toEqual({ key: 'a', to: 'dom' })
    p.commit({ key: 'a', to: 'dom' }, 13_000)
    expect(p.webglCount()).toBe(0)
  })

  it('hiding a pane keeps its renderer (no release on hide)', () => {
    const p = createRendererPolicy<string>(OPTS)
    p.add('a', 0)
    p.setVisible('a', true, 0)
    promoteAll(p, 3000)
    p.setVisible('a', false, 4000)
    for (let t = 4000; t < 100_000; t += 1000) expect(p.next(t)).toBeUndefined()
    expect(p.renderer('a')).toBe('webgl')
  })

  it('respects the cap without evicting a holder, and prefers the quietest pane', () => {
    const p = createRendererPolicy<string>(OPTS)
    for (const k of ['a', 'b', 'c']) { p.add(k, 0); p.setVisible(k, true, 0) }
    p.recordOutput('b', 1000, 0) // a bit of output: b is less quiet than a and c
    promoteAll(p, 5000)
    expect(p.webglCount()).toBe(2)
    expect(p.renderer('b')).toBe('dom')
    expect(p.next(60_000)).toBeUndefined()
  })

  it('frees the slot on remove and never promotes a blocked pane', () => {
    const p = createRendererPolicy<string>(OPTS)
    for (const k of ['a', 'b']) { p.add(k, 0); p.setVisible(k, true, 0) }
    promoteAll(p, 5000)
    p.block('a', 6000)
    expect(p.renderer('a')).toBe('dom')
    expect(p.webglCount()).toBe(1)
    p.remove('b')
    expect(p.webglCount()).toBe(0)
    expect(p.next(100_000)).toBeUndefined()
  })

  it('commit is idempotent', () => {
    const p = createRendererPolicy<string>(OPTS)
    p.add('a', 0)
    p.commit({ key: 'a', to: 'webgl' }, 0)
    p.commit({ key: 'a', to: 'webgl' }, 0)
    expect(p.webglCount()).toBe(1)
  })

  it("'busy' mode gives the slots to the busiest sustained streams and keeps them", () => {
    const p = createRendererPolicy<string>({ ...OPTS, prefer: 'busy' })
    for (const k of ['idle', 'slow', 'fast', 'mid']) { p.add(k, 0); p.setVisible(k, true, 0) }
    stream(p, 'slow', 10_000, 0, 3000)
    stream(p, 'fast', 900_000, 0, 3000)
    stream(p, 'mid', 300_000, 0, 3000)
    promoteAll(p, 3000)
    expect(p.renderer('fast')).toBe('webgl')
    expect(p.renderer('mid')).toBe('webgl')
    expect(p.renderer('slow')).toBe('dom')
    expect(p.renderer('idle')).toBe('dom')
    // Quiet again: no demotion, no churn.
    expect(p.next(100_000)).toBeUndefined()
  })

  it('gives panes WebGL at open up to maxWebgl (no eviction), and keeps it while hidden', () => {
    const p = createRendererPolicy<string>({ ...OPTS, maxWebgl: 2, openWebgl: true })
    for (const k of ['a', 'b', 'c']) p.add(k, 0)
    expect(p.claimOnOpen('a', 0).webgl).toBe(true)
    expect(p.claimOnOpen('a', 0).webgl).toBe(false)
    expect(p.claimOnOpen('b', 0).webgl).toBe(true)
    expect(p.claimOnOpen('c', 0).webgl).toBe(false)
    expect(p.webglCount()).toBe(2)
    p.setVisible('a', false, 0)
    expect(p.next(60_000)).toBeUndefined()
    expect(p.renderer('a')).toBe('webgl')
  })

  it('demotes a flooding open-time pane only while many panes are visible', () => {
    const p = createRendererPolicy<string>({ ...OPTS, maxWebgl: 4, openWebgl: true, demoteMinVisible: 3 })
    for (const k of ['a', 'b']) { p.add(k, 0); p.setVisible(k, true, 0) }
    p.block('b', 0) // only 'a' is a candidate; 'b' just counts as visible
    expect(p.claimOnOpen('a', 0).webgl).toBe(true)
    stream(p, 'a', 500_000, 0, 2000)
    expect(p.next(2000)).toBeUndefined() // 2 visible: a flood stays on WebGL
    p.add('c', 2000)
    p.setVisible('c', true, 2000)
    p.block('c', 2000)
    stream(p, 'a', 500_000, 2000, 3000)
    expect(p.next(3000)).toEqual({ key: 'a', to: 'dom' }) // no dwell after an open claim
    p.remove('c')
    stream(p, 'a', 500_000, 3000, 4000)
    expect(p.next(4000)).toBeUndefined()
  })

  it('with evictOnOpen, a pane opening at the cap takes the oldest holder\'s slot', () => {
    const p = createRendererPolicy<string>({ ...OPTS, maxWebgl: 2, openWebgl: true, evictOnOpen: true })
    for (const k of ['a', 'b', 'c', 'd']) p.add(k, 0)
    expect(p.claimOnOpen('a', 0)).toEqual({ webgl: true, evicted: undefined })
    expect(p.claimOnOpen('b', 0)).toEqual({ webgl: true, evicted: undefined })
    expect(p.claimOnOpen('c', 0)).toEqual({ webgl: true, evicted: 'a' })
    expect(p.renderer('a')).toBe('dom')
    p.remove('b')
    expect(p.claimOnOpen('d', 0)).toEqual({ webgl: true, evicted: undefined })
    expect(p.webglCount()).toBe(2)
    expect(p.claimOnOpen('a', 0)).toEqual({ webgl: true, evicted: 'c' })
  })

  it('eviction skips blocked/removed panes, follows WebGL order, and gives the evicted pane a dwell', () => {
    const EV = { ...OPTS, maxWebgl: 2, openWebgl: true, evictOnOpen: true }
    const p = createRendererPolicy<string>(EV)
    for (const k of ['a', 'b', 'c', 'd']) { p.add(k, 0); p.setVisible(k, true, 0) }
    p.claimOnOpen('a', 0)
    p.claimOnOpen('b', 0)
    p.block('a', 0) // blocked: no longer a holder
    expect(p.claimOnOpen('c', 0)).toEqual({ webgl: true, evicted: undefined })
    // 'b' demoted and re-promoted: it is now newer than 'c'.
    p.commit({ key: 'b', to: 'dom' }, 0)
    p.commit({ key: 'b', to: 'webgl' }, 0)
    expect(p.claimOnOpen('d', 1000)).toEqual({ webgl: true, evicted: 'c' })
    p.remove('d')
    // A slot is free, but 'c' was just evicted: no re-promotion before its dwell.
    expect(p.next(5000)).toBeUndefined()
    expect(p.next(11_000)).toEqual({ key: 'c', to: 'webgl' })
  })

  it('claims nothing with maxWebgl 0, and evicts one-for-one with maxWebgl 1', () => {
    const none = createRendererPolicy<string>({ ...OPTS, maxWebgl: 0, openWebgl: true, evictOnOpen: true })
    none.add('a', 0)
    expect(none.claimOnOpen('a', 0)).toEqual({ webgl: false, evicted: undefined })
    const one = createRendererPolicy<string>({ ...OPTS, maxWebgl: 1, openWebgl: true, evictOnOpen: true })
    for (const k of ['a', 'b']) one.add(k, 0)
    one.claimOnOpen('a', 0)
    expect(one.claimOnOpen('b', 0)).toEqual({ webgl: true, evicted: 'a' })
    expect(one.webglCount()).toBe(1)
  })

  it('demotes several floods in successive next/commit rounds', () => {
    const p = createRendererPolicy<string>({ ...OPTS, maxWebgl: 2, openWebgl: true })
    for (const k of ['a', 'b']) { p.add(k, 0); p.setVisible(k, true, 0); p.claimOnOpen(k, 0) }
    stream(p, 'a', 500_000, 0, 2000)
    stream(p, 'b', 500_000, 0, 2000)
    const keys: string[] = []
    for (let s = p.next(2000); s?.to === 'dom'; s = p.next(2000)) { keys.push(s.key); p.commit(s, 2000) }
    expect(keys.sort()).toEqual(['a', 'b'])
  })

  it('a single large dump is demoted: the sustain check runs on the smoothed rate', () => {
    const p = createRendererPolicy<string>({ ...OPTS, openWebgl: true, demoteSustainMs: 1000 })
    p.add('a', 0)
    p.setVisible('a', true, 0)
    p.claimOnOpen('a', 0)
    p.recordOutput('a', 1_000_000, 0) // 1 MB at once: above 64 KB/s for ~2.7 s
    expect(p.next(999)).toBeUndefined()
    expect(p.next(1000)).toEqual({ key: 'a', to: 'dom' })
  })

  it('a flood, a quiet stretch and a new flood restart the sustain clock', () => {
    const p = createRendererPolicy<string>({ ...OPTS, openWebgl: true, demoteSustainMs: 2000 })
    p.add('a', 0)
    p.setVisible('a', true, 0)
    p.claimOnOpen('a', 0)
    stream(p, 'a', 500_000, 0, 1500)
    expect(p.next(5000)).toBeUndefined() // decayed
    stream(p, 'a', 500_000, 5000, 6500)
    expect(p.next(6500)).toBeUndefined() // 1.5 s, not 3 s
  })

  it("'busy' mode never demotes, whatever the sustain time", () => {
    const p = createRendererPolicy<string>({ ...OPTS, prefer: 'busy', openWebgl: true })
    p.add('a', 0)
    p.setVisible('a', true, 0)
    p.claimOnOpen('a', 0)
    stream(p, 'a', 900_000, 0, 30_000)
    expect(p.next(30_000)).toBeUndefined()
  })

  it('demotes only a sustained flood, not a short burst', () => {
    const p = createRendererPolicy<string>({ ...OPTS, openWebgl: true, demoteSustainMs: 3000 })
    p.add('a', 0)
    p.setVisible('a', true, 0)
    expect(p.claimOnOpen('a', 0).webgl).toBe(true)
    stream(p, 'a', 500_000, 0, 1000) // a 1 s dump
    expect(p.next(1000)).toBeUndefined()
    expect(p.next(10_000)).toBeUndefined() // decayed: the burst clock reset
    stream(p, 'a', 500_000, 10_000, 12_900)
    expect(p.next(12_900)).toBeUndefined()
    // The smoothed rate crosses the threshold ~0.15 s into the stream.
    stream(p, 'a', 500_000, 12_900, 13_300)
    expect(p.next(13_300)).toEqual({ key: 'a', to: 'dom' })
  })

  it('re-promotes after a demotion once the dwell time has passed', () => {
    const p = createRendererPolicy<string>(OPTS)
    p.add('a', 0)
    p.setVisible('a', true, 0)
    p.commit({ key: 'a', to: 'webgl' }, 3000)
    p.commit({ key: 'a', to: 'dom' }, 5000) // e.g. a flood demotion
    expect(p.webglCount()).toBe(0)
    expect(p.next(14_999)).toBeUndefined()
    expect(p.next(15_000)).toEqual({ key: 'a', to: 'webgl' })
  })

  it('block frees the WebGL slot, and removing a visible pane lowers the visible count', () => {
    const p = createRendererPolicy<string>({ ...OPTS, maxWebgl: 4, openWebgl: true, demoteMinVisible: 2 })
    for (const k of ['a', 'b', 'c']) { p.add(k, 0); p.setVisible(k, true, 0) }
    expect(p.claimOnOpen('a', 0).webgl).toBe(true)
    expect(p.claimOnOpen('c', 0).webgl).toBe(true)
    p.block('c', 0)
    expect(p.webglCount()).toBe(1)
    p.block('b', 0)
    p.remove('b')
    p.remove('c')
    expect(p.size()).toBe(1)
    stream(p, 'a', 500_000, 0, 2000)
    expect(p.next(2000)).toBeUndefined() // only 1 visible now: no demotion
  })
})
