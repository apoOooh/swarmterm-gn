import { describe, expect, it } from 'vitest'
import {
  AUTO_SEND_WINDOW_MS,
  CLEAR_SETTLE_MS,
  USER_SUBMIT_MAX_AGE_MS,
  createAutoSendLimiter,
  deliverResubmit,
  effectiveResubmitMode,
  matchesFingerprint,
  parseResubmitMode,
  type PromptFingerprint,
  type ResubmitDeps,
  type ResubmitMode,
  type ResubmitRequest
} from '@/lib/prompt-resubmit'
import type { AgentEngineState } from '@/lib/agent-state/types'

// Built at runtime so no literal mask placeholder sits in the source.
const MASKED = `Check account [${'IBAN'}_${'0a1b2c3d'}] please`
const PLAIN = 'blocked plaintext'
const ESC = '\x1b'
const PASTED = `\x1b[200~${MASKED}\x1b[201~`

const sha256 = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}
const fingerprintOf = async (text: string): Promise<PromptFingerprint> => ({
  len: new TextEncoder().encode(text).length,
  sha256: await sha256(text)
})
const ASKED = await fingerprintOf(PLAIN)

interface Pane {
  box: string
  stamp: number | undefined
  dirty: boolean
  state: AgentEngineState | undefined
  bracketed: boolean
  composing: boolean
  gone: boolean
  /** Claude restores the blocked draft after this many sleeps. */
  restoreAfter: number
  restoreText: string
  /** Esc Esc clears the box (false = a layout we cannot clear). */
  escClears: boolean
  /** The draft reads back as exact text (false = several rows, DIM, ...). */
  readable: boolean
  /** When the user's last real Enter was seen (undefined = none). */
  submitAt: number | undefined
  /** Typing-store input revision: every real input and every clear moves it on. */
  rev: number
}

function harness(over: Partial<Pane> = {}, mode: ResubmitMode = 'send') {
  const pane: Pane = {
    box: '',
    stamp: undefined,
    dirty: false,
    state: 'idle',
    bracketed: true,
    composing: false,
    gone: false,
    restoreAfter: 0,
    restoreText: PLAIN,
    escClears: true,
    readable: true,
    submitAt: 900,
    rev: 10,
    ...over
  }
  const writes: string[] = []
  let sleeps = 0
  let escs = 0
  let clock = 1000
  let currentMode = mode
  const tick = () => {
    if (sleeps === pane.restoreAfter && pane.restoreText) pane.box = pane.restoreText
  }
  tick()
  const deps: ResubmitDeps = {
    mode: () => currentMode,
    draftInfo: () => (pane.gone ? undefined : { bracketed: pane.bracketed, composing: pane.composing }),
    agentState: () => pane.state,
    boxHasDraft: () => pane.box !== '',
    draftText: () => (pane.readable && pane.box !== '' ? pane.box : undefined),
    inputRevision: () => pane.rev,
    inputStamp: () => pane.stamp,
    inputDirty: () => pane.dirty,
    takeUserSubmit: (_id, now, maxAge) => {
      const at = pane.submitAt
      pane.submitAt = undefined
      return at !== undefined && now - at <= maxAge ? pane.rev : undefined
    },
    claimAutoSend: createAutoSendLimiter(),
    sha256,
    write: async (_id, spawn, data) => {
      if (spawn !== 'g1') throw new Error('target-gone: respawned')
      writes.push(data)
      if (data === ESC && ++escs % 2 === 0 && pane.escClears) pane.box = ''
      else if (data.startsWith('\x1b[200~') || (!pane.bracketed && data !== ESC && data !== '\r')) pane.box = data
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
  const req: ResubmitRequest = { terminalId: 't1', spawnId: 'g1', text: MASKED, send: true, asked: ASKED }
  const flush = () => new Promise((r) => setTimeout(r, 0))
  const setMode = (m: ResubmitMode) => {
    currentMode = m
  }
  return { pane, writes, deps, req, flush, setMode }
}

/** Runs `effect` right after the first write of `data`. */
function afterWrite(h: ReturnType<typeof harness>, data: string, effect: () => void) {
  const write = h.deps.write
  let done = false
  h.deps.write = async (id, spawn, d) => {
    await write(id, spawn, d)
    if (!done && d === data) {
      done = true
      effect()
    }
  }
}

describe('deliverResubmit', () => {
  it('clears the restored plaintext with Esc Esc, inserts the masked text and sends it', async () => {
    const h = harness({ restoreAfter: 3 })
    const out = await deliverResubmit(h.req, h.deps)
    await h.flush()
    expect(out).toEqual({ kind: 'inserted', submitScheduled: true })
    expect(h.writes).toEqual([ESC, ESC, PASTED, '\r'])
  })

  describe('bound to a real Enter of the user', () => {
    it('no Enter seen in this pane: nothing is written', async () => {
      const h = harness({ submitAt: undefined })
      expect(await deliverResubmit(h.req, h.deps)).toEqual({ kind: 'fallback', reason: 'no-user-submit' })
      expect(h.writes).toEqual([])
    })

    it('an Enter 14 s old counts, one 16 s old does not', async () => {
      expect(USER_SUBMIT_MAX_AGE_MS).toBe(15_000)
      // The clock reads 1001 when the event is handled.
      const fresh = harness({ submitAt: 1001 - 14_000 })
      expect((await deliverResubmit(fresh.req, fresh.deps)).kind).toBe('inserted')
      const stale = harness({ submitAt: 1001 - 16_000 })
      expect(await deliverResubmit(stale.req, stale.deps)).toEqual({ kind: 'fallback', reason: 'no-user-submit' })
      expect(stale.writes).toEqual([])
    })

    it('one Enter allows one resubmit: a second event (e.g. a faked edge) gets nothing', async () => {
      const h = harness()
      expect((await deliverResubmit(h.req, h.deps)).kind).toBe('inserted')
      await h.flush()
      const before = h.writes.length
      h.pane.box = PLAIN
      h.pane.stamp = undefined
      expect(await deliverResubmit(h.req, h.deps)).toEqual({ kind: 'fallback', reason: 'no-user-submit' })
      expect(h.writes.length).toBe(before)
    })

    it('a failed attempt still uses up the Enter', async () => {
      const h = harness({ restoreText: '' })
      expect((await deliverResubmit(h.req, h.deps)).kind).toBe('fallback')
      h.pane.box = PLAIN
      expect(await deliverResubmit(h.req, h.deps)).toEqual({ kind: 'fallback', reason: 'no-user-submit' })
    })
  })

  describe('the restored draft must be the blocked prompt', () => {
    it('no visible draft (e.g. a tool runs, box empty): nothing is cleared, inserted or sent', async () => {
      const h = harness({ restoreText: '' })
      expect(await deliverResubmit(h.req, h.deps)).toEqual({ kind: 'fallback', reason: 'no-draft' })
      expect(h.writes).toEqual([])
    })

    it('a multi-row draft that cannot be read back is still cleared, inserted and sent', async () => {
      // Several rows / wrapped / "[Pasted text …]": no hash, the Enter binding carries it.
      const h = harness({ readable: false, restoreText: 'first line\nsecond line of the blocked prompt' })
      const out = await deliverResubmit(h.req, h.deps)
      await h.flush()
      expect(out).toEqual({ kind: 'inserted', submitScheduled: true })
      expect(h.writes).toEqual([ESC, ESC, PASTED, '\r'])
    })

    it('an unreadable draft still stops at a key between the Escs', async () => {
      const h = harness({ readable: false })
      afterWrite(h, ESC, () => {
        h.pane.stamp = 31
      })
      expect(await deliverResubmit(h.req, h.deps)).toEqual({ kind: 'fallback', reason: 'typed' })
      expect(h.writes).toEqual([ESC])
    })

    it('a readable draft that differs from the fingerprint falls back', async () => {
      const h = harness({ restoreText: 'something a process printed' })
      expect(await deliverResubmit(h.req, h.deps)).toEqual({ kind: 'fallback', reason: 'unverified' })
      expect(h.writes).toEqual([])
    })

    it('a draft that vanishes right before the first Esc gets no Esc', async () => {
      const h = harness()
      const box = h.deps.boxHasDraft
      let reads = 0
      // Seen by the wait loop, gone at the read right before Esc 1.
      h.deps.boxHasDraft = (id) => (++reads > 1 ? false : box(id))
      expect(await deliverResubmit(h.req, h.deps)).toEqual({ kind: 'fallback', reason: 'no-draft' })
      expect(h.writes).toEqual([])
    })

    it('a plain shell has no Claude box: fallback, nothing written', async () => {
      const h = harness({ bracketed: false, restoreText: '' })
      expect(await deliverResubmit({ ...h.req, text: `${MASKED}\nsecond line` }, h.deps)).toEqual({
        kind: 'fallback',
        reason: 'no-draft'
      })
      expect(h.writes).toEqual([])
    })
  })

  describe('user activity stops the sequence at every step', () => {
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

    it('typing between Esc 1 and Esc 2: Esc 2 is never sent', async () => {
      const h = harness()
      afterWrite(h, ESC, () => {
        h.pane.stamp = 4242
      })
      expect(await deliverResubmit(h.req, h.deps)).toEqual({ kind: 'fallback', reason: 'typed' })
      expect(h.writes).toEqual([ESC])
    })

    it('an unsubmitted line (dirty) counts as typing too', async () => {
      const h = harness()
      afterWrite(h, ESC, () => {
        h.pane.dirty = true
      })
      expect(await deliverResubmit(h.req, h.deps)).toEqual({ kind: 'fallback', reason: 'typed' })
      expect(h.writes).toEqual([ESC])
    })

    it('an IME composition between the Escs stops it', async () => {
      const h = harness()
      afterWrite(h, ESC, () => {
        h.pane.composing = true
      })
      expect(await deliverResubmit(h.req, h.deps)).toEqual({ kind: 'fallback', reason: 'typed' })
      expect(h.writes).toEqual([ESC])
    })

    it('typing while the clear settles stops the insert', async () => {
      const h = harness()
      const sleep = h.deps.sleep
      let settling = 0
      h.deps.sleep = async (ms) => {
        // The settle is polled; a key in its middle must be seen.
        if (h.writes.length === 2 && ++settling === 3) h.pane.stamp = 77
        await sleep(ms)
      }
      expect(await deliverResubmit(h.req, h.deps)).toEqual({ kind: 'fallback', reason: 'typed' })
      expect(h.writes).toEqual([ESC, ESC])
      expect(CLEAR_SETTLE_MS).toBeGreaterThan(0)
    })

    // What the typing store does for a line-ending key: lastKeyAt and dirty
    // are CLEARED (so the old checks see nothing), only the revision moves.
    it('Ctrl+C after Esc 1: no Esc 2, no paste, no Enter', async () => {
      const h = harness()
      afterWrite(h, ESC, () => {
        h.pane.rev++
        h.pane.stamp = undefined
        h.pane.dirty = false
      })
      expect(await deliverResubmit(h.req, h.deps)).toEqual({ kind: 'fallback', reason: 'typed' })
      await h.flush()
      expect(h.writes).toEqual([ESC])
    })

    it('text + Enter after Esc 1 (a new submit) ends the old attempt: nothing more is written', async () => {
      const h = harness()
      afterWrite(h, ESC, () => {
        h.pane.rev += 2
        h.pane.stamp = undefined
        h.pane.dirty = false
        h.pane.submitAt = 1100
      })
      expect(await deliverResubmit(h.req, h.deps)).toEqual({ kind: 'fallback', reason: 'typed' })
      await h.flush()
      expect(h.writes).toEqual([ESC])
    })

    it('a clear (Esc, the clear shortcut) during the settle stops the insert', async () => {
      const h = harness()
      const sleep = h.deps.sleep
      h.deps.sleep = async (ms) => {
        if (h.writes.length === 2) h.pane.rev++
        await sleep(ms)
      }
      expect(await deliverResubmit(h.req, h.deps)).toEqual({ kind: 'fallback', reason: 'typed' })
      expect(h.writes).toEqual([ESC, ESC])
    })

    it('input after the insert (revision moved, typing signals cleared) stops the Enter', async () => {
      const h = harness()
      const sleep = h.deps.sleep
      h.deps.sleep = async (ms) => {
        if (ms === 200) {
          h.pane.rev++
          h.pane.stamp = undefined
        }
        await sleep(ms)
      }
      await deliverResubmit(h.req, h.deps)
      await h.flush()
      expect(h.writes).not.toContain('\r')
    })

    it('switching resubmit off mid-sequence stops it', async () => {
      const h = harness()
      afterWrite(h, ESC, () => h.setMode('off'))
      expect(await deliverResubmit(h.req, h.deps)).toEqual({ kind: 'dropped', reason: 'off' })
      expect(h.writes).toEqual([ESC])
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
  })

  it('a first Esc that already cleared the box gets no second Esc (rewind menu)', async () => {
    const h = harness()
    afterWrite(h, ESC, () => {
      h.pane.box = ''
    })
    const out = await deliverResubmit(h.req, h.deps)
    await h.flush()
    expect(out).toEqual({ kind: 'inserted', submitScheduled: true })
    expect(h.writes).toEqual([ESC, PASTED, '\r'])
  })

  it('a box emptied before the Enter gets no Enter', async () => {
    const h = harness()
    const sleep = h.deps.sleep
    h.deps.sleep = async (ms) => {
      if (ms === 200) h.pane.box = ''
      await sleep(ms)
    }
    await deliverResubmit(h.req, h.deps)
    await h.flush()
    expect(h.writes).not.toContain('\r')
  })

  it('one attempt with Enter per pane in 30 s, failed ones included: the next is inserted, not sent', async () => {
    const claim = createAutoSendLimiter()
    const failed = harness({ restoreText: '' })
    failed.deps.claimAutoSend = claim
    expect((await deliverResubmit(failed.req, failed.deps)).kind).toBe('fallback')
    const next = harness({ restoreAfter: 1 })
    next.deps.claimAutoSend = claim
    const out = await deliverResubmit(next.req, next.deps)
    await next.flush()
    expect(out).toEqual({ kind: 'inserted', submitScheduled: false, rateLimited: true })
    expect(next.writes).toEqual([ESC, ESC, PASTED])
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

  it('a box Esc Esc cannot clear falls back before anything is inserted', async () => {
    const h = harness({ escClears: false })
    expect(await deliverResubmit(h.req, h.deps)).toEqual({ kind: 'fallback', reason: 'not-cleared' })
    expect(h.writes).toEqual([ESC, ESC])
  })

  it('a permission prompt gets nothing', async () => {
    const h = harness({ state: 'blocked' })
    expect(await deliverResubmit(h.req, h.deps)).toEqual({ kind: 'fallback', reason: 'target-busy' })
    expect(h.writes).toEqual([])
  })

  it('blocked right after Esc 1: no Esc 2 and no paste', async () => {
    const h = harness()
    afterWrite(h, ESC, () => {
      h.pane.state = 'blocked'
    })
    expect(await deliverResubmit(h.req, h.deps)).toEqual({ kind: 'fallback', reason: 'target-busy' })
    await h.flush()
    expect(h.writes).toEqual([ESC])
  })

  it('blocked during the settle: no paste', async () => {
    const h = harness()
    const sleep = h.deps.sleep
    h.deps.sleep = async (ms) => {
      if (h.writes.length === 2) h.pane.state = 'blocked'
      await sleep(ms)
    }
    expect(await deliverResubmit(h.req, h.deps)).toEqual({ kind: 'fallback', reason: 'target-busy' })
    expect(h.writes).toEqual([ESC, ESC])
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
})

describe('matchesFingerprint', () => {
  it('needs the exact UTF-8 length and hash', async () => {
    const umlauts = await fingerprintOf('Grüße')
    expect(umlauts.len).toBe(7)
    expect(await matchesFingerprint(PLAIN, ASKED, sha256)).toBe(true)
    expect(await matchesFingerprint(`${PLAIN} `, ASKED, sha256)).toBe(false)
    expect(await matchesFingerprint('Grüße', umlauts, sha256)).toBe(true)
    expect(await matchesFingerprint('Grüße', { ...umlauts, len: 5 }, sha256)).toBe(false)
  })
})

describe('auto-send limiter', () => {
  it('allows one claim per pane per window', () => {
    const claim = createAutoSendLimiter()
    expect(claim('t1', 1000)).toBe(true)
    expect(claim('t1', 1000 + AUTO_SEND_WINDOW_MS - 1)).toBe(false)
    expect(claim('t2', 1001)).toBe(true)
    expect(claim('t1', 1000 + AUTO_SEND_WINDOW_MS)).toBe(true)
    expect(AUTO_SEND_WINDOW_MS).toBe(30_000)
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
