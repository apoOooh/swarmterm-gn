import { describe, expect, it } from 'vitest'
import {
  TTL_WORKING_MS,
  TTL_BLOCKED_MS,
  TTL_IDLE_MS,
  acceptsAgentHooks,
  isHookLive,
  resolveHookState,
  type HookMark,
} from '@/lib/agent-state/hook-signal'

describe('acceptsAgentHooks', () => {
  it('routes hooks only into the detectors tuned against them', () => {
    expect(acceptsAgentHooks('claude-code')).toBe(true)
    // SWA-71: Codex's own turn edges.
    expect(acceptsAgentHooks('codex')).toBe(true)
    expect(acceptsAgentHooks('gemini')).toBe(false)
    expect(acceptsAgentHooks(undefined)).toBe(false)
    expect(acceptsAgentHooks(null)).toBe(false)
  })
})

describe('codex manifest under hooks (SWA-71)', () => {
  it('a hook working mark overrules the title going idle mid-turn', () => {
    const r = resolveHookState({
      hook: { signal: 'working', atMs: 0 },
      scrape: verdict('idle', { visibleIdle: true }),
      now: 1_000,
    })
    expect(r.state).toBe('working')
  })
})
import type { AgentEngineState, Verdict } from '@/lib/agent-state/types'

/** Build a scrape verdict; only the flags the precedence rules look at are settable. */
function verdict(
  state: AgentEngineState,
  flags: { visibleIdle?: boolean; visibleBlocker?: boolean } = {},
): Verdict {
  return {
    state,
    visibleIdle: flags.visibleIdle ?? false,
    visibleBlocker: flags.visibleBlocker ?? false,
    visibleWorking: false,
    skip: false,
  }
}

const NOW = 1_000_000
const ALL_STATES: AgentEngineState[] = ['working', 'blocked', 'idle', 'unknown']

function mark(signal: HookMark['signal'], ageMs: number): HookMark {
  return { signal, atMs: NOW - ageMs }
}

describe('TTL constants', () => {
  it('pin the per-signal lifetimes', () => {
    expect(TTL_WORKING_MS).toBe(30_000)
    expect(TTL_BLOCKED_MS).toBe(600_000)
    expect(TTL_IDLE_MS).toBe(5_000)
  })
})

describe('isHookLive', () => {
  it('is false for a null hook', () => {
    expect(isHookLive(null, NOW)).toBe(false)
  })

  it('is true strictly inside the TTL and false exactly at it — working', () => {
    expect(isHookLive(mark('working', TTL_WORKING_MS - 1), NOW)).toBe(true)
    expect(isHookLive(mark('working', TTL_WORKING_MS), NOW)).toBe(false)
  })

  it('is true strictly inside the TTL and false exactly at it — blocked', () => {
    expect(isHookLive(mark('blocked', TTL_BLOCKED_MS - 1), NOW)).toBe(true)
    expect(isHookLive(mark('blocked', TTL_BLOCKED_MS), NOW)).toBe(false)
  })

  it('is true strictly inside the TTL and false exactly at it — idle', () => {
    expect(isHookLive(mark('idle', TTL_IDLE_MS - 1), NOW)).toBe(true)
    expect(isHookLive(mark('idle', TTL_IDLE_MS), NOW)).toBe(false)
  })
})

describe('resolveHookState — rule 1: no live hook ⇒ scrape wins', () => {
  it('returns the scrape state untouched when the hook is null', () => {
    for (const state of ALL_STATES) {
      expect(resolveHookState({ hook: null, scrape: verdict(state), now: NOW })).toEqual({
        state,
        bypassIdleHold: false,
      })
    }
  })

  it('treats an expired hook exactly like null', () => {
    const expired = mark('blocked', TTL_BLOCKED_MS)
    for (const state of ALL_STATES) {
      expect(resolveHookState({ hook: expired, scrape: verdict(state), now: NOW })).toEqual({
        state,
        bypassIdleHold: false,
      })
    }
  })
})

describe('resolveHookState — rule 2: hook blocked', () => {
  const hook = mark('blocked', 0)

  it('yields to a scrape that sees working (the approved tool is still spinning)', () => {
    expect(resolveHookState({ hook, scrape: verdict('working'), now: NOW })).toEqual({
      state: 'working',
      bypassIdleHold: false,
    })
  })

  it('overrides idle, visible-idle, blocked and unknown scrapes with blocked', () => {
    const scrapes = [
      verdict('idle'),
      verdict('idle', { visibleIdle: true }),
      verdict('blocked'),
      verdict('unknown'),
    ]
    for (const scrape of scrapes) {
      expect(resolveHookState({ hook, scrape, now: NOW })).toEqual({
        state: 'blocked',
        bypassIdleHold: false,
      })
    }
  })
})

describe('resolveHookState — rule 3: hook working', () => {
  const hook = mark('working', 0)

  it('yields only to a VISIBLE blocker (a question the hook never saw)', () => {
    expect(
      resolveHookState({ hook, scrape: verdict('blocked', { visibleBlocker: true }), now: NOW }),
    ).toEqual({ state: 'blocked', bypassIdleHold: false })
  })

  it('does not yield to a blocked scrape without a visible blocker', () => {
    expect(resolveHookState({ hook, scrape: verdict('blocked'), now: NOW })).toEqual({
      state: 'working',
      bypassIdleHold: false,
    })
  })

  it('keeps working over working, false-idle (visible prompt box mid-turn) and unknown scrapes', () => {
    const scrapes = [
      verdict('working'),
      verdict('idle', { visibleIdle: true }),
      verdict('idle'),
      verdict('unknown'),
    ]
    for (const scrape of scrapes) {
      expect(resolveHookState({ hook, scrape, now: NOW })).toEqual({
        state: 'working',
        bypassIdleHold: false,
      })
    }
  })
})

describe('resolveHookState — rule 4: hook idle', () => {
  const hook = mark('idle', 0)

  it('yields to a visible blocker without bypassing the hold', () => {
    expect(
      resolveHookState({ hook, scrape: verdict('blocked', { visibleBlocker: true }), now: NOW }),
    ).toEqual({ state: 'blocked', bypassIdleHold: false })
  })

  it('publishes idle immediately (bypassIdleHold) over every other scrape', () => {
    const scrapes = [
      verdict('working'),
      verdict('idle'),
      verdict('idle', { visibleIdle: true }),
      verdict('unknown'),
      verdict('blocked'),
    ]
    for (const scrape of scrapes) {
      expect(resolveHookState({ hook, scrape, now: NOW })).toEqual({
        state: 'idle',
        bypassIdleHold: true,
      })
    }
  })
})

describe('resolveHookState — bypassIdleHold is exclusive to the hook-idle branch', () => {
  it('never bypasses for null, expired, blocked or working hooks', () => {
    const hooks: Array<HookMark | null> = [
      null,
      mark('idle', TTL_IDLE_MS),
      mark('blocked', 0),
      mark('working', 0),
    ]
    for (const hook of hooks) {
      for (const state of ALL_STATES) {
        for (const flags of [{}, { visibleIdle: true }, { visibleBlocker: true }]) {
          expect(
            resolveHookState({ hook, scrape: verdict(state, flags), now: NOW }).bypassIdleHold,
          ).toBe(false)
        }
      }
    }
  })
})
