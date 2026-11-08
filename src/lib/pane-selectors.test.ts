import { describe, expect, it } from 'vitest'
import { shallow } from 'zustand/shallow'
import type { AgentPaneState } from '@/lib/agent-state/rollup'
import type { LayoutNode } from '@/lib/layout-tree'
import { attentionCounts, paneDisplays, paneOutputs, recognisedPanes } from './pane-selectors'

const s = (state: AgentPaneState['state'], seen = true): AgentPaneState => ({ state, seen, sinceMs: 0 })
const leaf = (terminalId: string): LayoutNode => ({ type: 'leaf', id: `l-${terminalId}`, terminalId }) as LayoutNode
const ws = [{ layout: leaf('a') }, { layout: leaf('b') }]

describe('attentionCounts', () => {
  it('counts blocked and unseen-idle (done) panes', () => {
    expect(attentionCounts(ws, { a: s('blocked'), b: s('idle', false) })).toEqual({ blocked: 1, done: 1 })
  })

  it('is shallow-equal across a working <-> seen-idle flip (no re-render)', () => {
    const before = attentionCounts(ws, { a: s('blocked'), b: s('working') })
    const after = attentionCounts(ws, { a: s('blocked'), b: s('idle') })
    expect(shallow(before, after)).toBe(true)
  })

  it('changes when a pane becomes done', () => {
    const before = attentionCounts(ws, { a: s('working'), b: s('working') })
    const after = attentionCounts(ws, { a: s('working'), b: s('idle', false) })
    expect(shallow(before, after)).toBe(false)
  })
})

describe('paneDisplays / paneOutputs', () => {
  it('select nothing for the active tab', () => {
    expect(paneDisplays(['a'], { a: s('blocked') }, true)).toEqual([])
    expect(paneOutputs(['a'], { a: true }, true)).toEqual([])
  })

  it('map only the tab\'s own panes', () => {
    expect(paneDisplays(['a', 'b'], { a: s('blocked'), c: s('working') }, false)).toEqual(['blocked', undefined])
    expect(paneOutputs(['a', 'b'], { b: true, c: true }, false)).toEqual([false, true])
  })

  it('are shallow-equal when only another workspace\'s pane changes', () => {
    const before = paneDisplays(['a'], { a: s('working'), c: s('working') }, false)
    const after = paneDisplays(['a'], { a: s('working'), c: s('blocked') }, false)
    expect(shallow(before, after)).toBe(true)
    expect(shallow(paneOutputs(['a'], { a: true, c: false }, false), paneOutputs(['a'], { a: true, c: true }, false))).toBe(true)
  })

  it('change when the tab\'s own pane changes', () => {
    expect(shallow(paneDisplays(['a'], { a: s('working') }, false), paneDisplays(['a'], { a: s('blocked') }, false))).toBe(false)
  })
})

describe('recognisedPanes', () => {
  it('selects nothing while closed', () => {
    expect(recognisedPanes({ a: s('working') }, false)).toEqual({})
  })

  it('flags panes with a known agent state', () => {
    expect(recognisedPanes({ a: s('working'), b: s('unknown'), c: undefined }, true)).toEqual({ a: true, b: false, c: false })
  })

  it('is shallow-equal across state flips between known states', () => {
    expect(shallow(recognisedPanes({ a: s('working') }, true), recognisedPanes({ a: s('idle') }, true))).toBe(true)
    expect(shallow(recognisedPanes({ a: s('unknown') }, true), recognisedPanes({ a: s('idle') }, true))).toBe(false)
  })
})
