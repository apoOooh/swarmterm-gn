import { describe, expect, it, vi } from 'vitest'
import { COMPOSITION_WAIT_MS, deliverDictation, type DictationDeps, type DictationRequest } from './voice-delivery'

function setup(over: Partial<DictationDeps> = {}) {
  const calls: string[] = []
  let stamp: number | undefined
  const deps: DictationDeps = {
    draftInfo: () => ({ bracketed: true, composing: false }),
    agentState: () => 'idle',
    freeTextActive: () => false,
    write: vi.fn(async (_id: string, _spawn: string, data: string) => {
      calls.push(`write:${JSON.stringify(data)}`)
    }),
    resetInput: () => calls.push('reset'),
    markDraft: (_id, now) => {
      calls.push('dirty')
      stamp = now
      return now
    },
    inputStamp: () => stamp,
    now: () => 42,
    sleep: async () => {},
    submitDelayMs: 300,
    ...over
  }
  return { deps, calls, setStamp: (v: number | undefined) => (stamp = v) }
}

const req: DictationRequest = { requestId: 'r1', terminalId: 't1', expectedSpawnId: 's1', text: 'hi', submit: false }

describe('deliverDictation', () => {
  it('resets the IME baseline, marks dirty, then writes the framed draft', async () => {
    const { deps, calls } = setup()
    expect(await deliverDictation(req, deps)).toEqual({ ok: true, submitScheduled: false })
    expect(calls).toEqual(['reset', 'dirty', 'write:"\\u001b[200~hi\\u001b[201~"'])
  })

  it('passes the pinned spawn id to the checked write', async () => {
    const { deps } = setup()
    await deliverDictation(req, deps)
    expect(deps.write).toHaveBeenCalledWith('t1', 's1', expect.any(String))
  })

  it('refuses a blocked pane without writing', async () => {
    const { deps, calls } = setup({ agentState: () => 'blocked' })
    expect(await deliverDictation(req, deps)).toEqual({ ok: false, reason: 'target-busy' })
    expect(calls).toEqual([])
  })

  it('inserts into a blocked pane whose choice free-text row is selected, without Enter (SWA-96)', async () => {
    const { deps, calls } = setup({ agentState: () => 'blocked', freeTextActive: () => true })
    expect(await deliverDictation({ ...req, submit: true }, deps)).toMatchObject({ ok: true })
    expect(calls).toContain('reset')
    await new Promise((r) => setTimeout(r, 0))
    expect(deps.write).toHaveBeenCalledTimes(1)
  })

  it('reports target-gone for an unknown pane and for a rejected checked write', async () => {
    expect(await deliverDictation(req, setup({ draftInfo: () => undefined }).deps)).toEqual({
      ok: false,
      reason: 'target-gone'
    })
    const { deps } = setup({ write: async () => Promise.reject('target-gone') })
    expect(await deliverDictation(req, deps)).toEqual({ ok: false, reason: 'target-gone' })
  })

  it('waits for an open IME composition and gives up after the limit', async () => {
    const { deps } = setup({ draftInfo: () => ({ bracketed: true, composing: true }) })
    let slept = 0
    deps.sleep = async (ms) => {
      slept += ms
    }
    expect(await deliverDictation(req, deps)).toEqual({ ok: false, reason: 'composing' })
    expect(slept).toBe(COMPOSITION_WAIT_MS)
  })

  it('sends Enter as a separate later write when nothing changed', async () => {
    const { deps, calls } = setup()
    const out = await deliverDictation({ ...req, submit: true }, deps)
    expect(out.submitScheduled).toBe(true)
    await vi.waitFor(() => expect(calls).toContain('write:"\\r"'))
    expect(calls.indexOf('write:"\\r"')).toBeGreaterThan(calls.indexOf('dirty'))
  })

  it('keeps the draft when the user typed before the Enter', async () => {
    const { deps, calls, setStamp } = setup()
    deps.sleep = async () => {
      setStamp(99)
    }
    await deliverDictation({ ...req, submit: true }, deps)
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).not.toContain('write:"\\r"')
  })

  it('never submits in a plain shell and flattens line breaks there', async () => {
    const { deps, calls } = setup({ draftInfo: () => ({ bracketed: false, composing: false }) })
    const out = await deliverDictation({ ...req, text: 'a\nb', submit: true }, deps)
    expect(out.submitScheduled).toBe(false)
    expect(calls[2]).toBe('write:"a b"')
  })
})

describe('deliverDictation into a choice free-text row (SWA-96)', () => {
  it('inserts single-line and never sends Enter, even when the state turns idle', async () => {
    let state: 'blocked' | 'idle' = 'blocked'
    const { deps, calls } = setup({
      agentState: () => state,
      freeTextActive: () => true,
      write: vi.fn(async (_id: string, _spawn: string, data: string) => {
        calls.push(`write:${JSON.stringify(data)}`)
        state = 'idle'
      })
    })
    expect(await deliverDictation({ ...req, text: 'a\nb\tc', submit: true }, deps)).toEqual({
      ok: true,
      submitScheduled: false
    })
    await new Promise((r) => setTimeout(r, 0))
    const writes = calls.filter((c) => c.startsWith('write'))
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0].slice(6))).toBe(String.fromCharCode(27) + '[200~a b c' + String.fromCharCode(27) + '[201~')
  })

  it('does not read the screen for a pane that is not blocked', async () => {
    const freeTextActive = vi.fn(() => true)
    await deliverDictation(req, setup({ freeTextActive }).deps)
    expect(freeTextActive).not.toHaveBeenCalled()
  })
})
