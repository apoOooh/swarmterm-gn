import { describe, expect, it } from 'vitest'
import {
  deliverResubmit,
  effectiveResubmitMode,
  parseResubmitMode,
  type ResubmitDeps,
  type ResubmitMode,
  type ResubmitRequest
} from '@/lib/prompt-resubmit'
import type { AgentEngineState } from '@/lib/agent-state/types'

// Built at runtime so no literal mask placeholder sits in the source.
const MASKED = `Check account [${'IBAN'}_${'0a1b2c3d'}] please`

interface Pane {
  box: string
  stamp: number | undefined
  state: AgentEngineState | undefined
  bracketed: boolean
  composing: boolean
  gone: boolean
  /** Claude restores the blocked draft after this many sleeps. */
  restoreAfter: number
  restoreText: string
  /** Esc Esc clears the box (false = a layout we cannot clear). */
  escClears: boolean
}

function harness(over: Partial<Pane> = {}, mode: ResubmitMode = 'send') {
  const pane: Pane = {
    box: '',
    stamp: undefined,
    state: 'idle',
    bracketed: true,
    composing: false,
    gone: false,
    restoreAfter: 0,
    restoreText: 'blocked plaintext',
    escClears: true,
    ...over
  }
  const writes: string[] = []
  let sleeps = 0
  let escs = 0
  let clock = 1000
  const tick = () => {
    if (sleeps === pane.restoreAfter && pane.restoreText) pane.box = pane.restoreText
  }
  tick()
  const deps: ResubmitDeps = {
    mode: () => mode,
    draftInfo: () => (pane.gone ? undefined : { bracketed: pane.bracketed, composing: pane.composing }),
    agentState: () => pane.state,
    boxHasDraft: () => pane.box !== '',
    inputStamp: () => pane.stamp,
    write: async (_id, spawn, data) => {
      if (spawn !== 'g1') throw new Error('target-gone: respawned')
      writes.push(data)
      if (data === '\x1b' && ++escs % 2 === 0 && pane.escClears) pane.box = ''
      else if (data.startsWith('\x1b[200~') || (!pane.bracketed && data !== '\x1b' && data !== '\r')) pane.box = data
    },
    resetInput: () => {},
    markDraft: (_id, now) => {
      pane.stamp = now
      return now
    },
    now: () => ++clock,
    sleep: async () => {
      sleeps++
      tick()
    },
    submitDelayMs: 200
  }
  const req: ResubmitRequest = { terminalId: 't1', spawnId: 'g1', text: MASKED, send: true }
  const flush = () => new Promise((r) => setTimeout(r, 0))
  return { pane, writes, deps, req, flush }
}

describe('deliverResubmit', () => {
  it('clears the restored plaintext with Esc Esc, inserts the masked text and sends it', async () => {
    const h = harness({ restoreAfter: 3 })
    const out = await deliverResubmit(h.req, h.deps)
    await h.flush()
    expect(out).toEqual({ kind: 'inserted', submitScheduled: true })
    expect(h.writes).toEqual(['\x1b', '\x1b', `\x1b[200~${MASKED}\x1b[201~`, '\r'])
  })

  it('never presses Esc on an empty box (rewind menu) and still inserts', async () => {
    const h = harness({ restoreText: '' })
    const out = await deliverResubmit(h.req, h.deps)
    await h.flush()
    expect(out.kind).toBe('inserted')
    expect(h.writes).not.toContain('\x1b')
    expect(h.writes[0]).toContain(MASKED)
  })

  it('insert-only mode (or Rust saying no send) leaves the Enter to the user', async () => {
    for (const [mode, send] of [['insert', true], ['send', false]] as const) {
      const h = harness({}, mode)
      const out = await deliverResubmit({ ...h.req, send }, h.deps)
      await h.flush()
      expect(out).toEqual({ kind: 'inserted', submitScheduled: false })
      expect(h.writes).not.toContain('\r')
    }
  })

  it('off drops it without a single write', async () => {
    const h = harness({}, 'off')
    expect(await deliverResubmit(h.req, h.deps)).toEqual({ kind: 'dropped', reason: 'off' })
    expect(h.writes).toEqual([])
  })

  it('a key since the Enter wins: nothing is cleared or written', async () => {
    const h = harness({ stamp: 5 })
    expect(await deliverResubmit(h.req, h.deps)).toEqual({ kind: 'fallback', reason: 'typed' })
    expect(h.writes).toEqual([])
  })

  it('a key while waiting for the restore also wins', async () => {
    const h = harness({ restoreAfter: 99 })
    const sleep = h.deps.sleep
    let n = 0
    h.deps.sleep = async (ms) => {
      if (++n === 2) h.pane.stamp = 7
      await sleep(ms)
    }
    expect(await deliverResubmit(h.req, h.deps)).toEqual({ kind: 'fallback', reason: 'typed' })
    expect(h.writes).toEqual([])
  })

  it('a box Esc Esc cannot clear falls back before anything is inserted', async () => {
    const h = harness({ escClears: false })
    expect(await deliverResubmit(h.req, h.deps)).toEqual({ kind: 'fallback', reason: 'not-cleared' })
    expect(h.writes).toEqual(['\x1b', '\x1b'])
  })

  it('a permission prompt gets nothing', async () => {
    const h = harness({ state: 'blocked' })
    expect(await deliverResubmit(h.req, h.deps)).toEqual({ kind: 'fallback', reason: 'target-busy' })
    expect(h.writes).toEqual([])
  })

  it('a key typed after the insert stops the Enter', async () => {
    const h = harness()
    const sleep = h.deps.sleep
    h.deps.sleep = async (ms) => {
      if (ms === 200) h.pane.stamp = 999_999
      await sleep(ms)
    }
    await deliverResubmit(h.req, h.deps)
    await h.flush()
    expect(h.writes).not.toContain('\r')
  })

  it('a respawned or closed pane is dropped', async () => {
    const gone = harness({ gone: true })
    expect(await deliverResubmit(gone.req, gone.deps)).toEqual({ kind: 'dropped', reason: 'target-gone' })
    const respawned = harness()
    expect(await deliverResubmit({ ...respawned.req, spawnId: 'g0' }, respawned.deps)).toEqual({
      kind: 'dropped',
      reason: 'target-gone'
    })
  })

  it('a plain shell gets the text flattened and no Enter', async () => {
    const h = harness({ bracketed: false, restoreText: '' })
    const out = await deliverResubmit({ ...h.req, text: `${MASKED}\nrm -rf x` }, h.deps)
    await h.flush()
    expect(out).toEqual({ kind: 'inserted', submitScheduled: false })
    expect(h.writes).toEqual([`${MASKED} rm -rf x`])
  })
})

describe('resubmit mode', () => {
  it('parses to send unless insert or off', () => {
    expect(parseResubmitMode('insert')).toBe('insert')
    expect(parseResubmitMode('off')).toBe('off')
    expect(parseResubmitMode('SEND')).toBe('send')
    expect(parseResubmitMode(undefined)).toBe('send')
  })

  it('admin locks only tighten', () => {
    expect(effectiveResubmitMode('send', {})).toBe('send')
    expect(effectiveResubmitMode('send', { disablePromptResubmitSend: true })).toBe('insert')
    expect(effectiveResubmitMode('off', { disablePromptResubmitSend: true })).toBe('off')
    expect(effectiveResubmitMode('insert', { disablePromptResubmit: true })).toBe('off')
  })
})
