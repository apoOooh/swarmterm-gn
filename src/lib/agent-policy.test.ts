import { describe, it, expect } from 'vitest'
import { AGENT_POLICY_KEY, DEFAULT_AGENT_POLICY, parseAgentPolicy, readAgentPolicy, storeAgentPolicy } from './agent-policy'

function mem(initial: Record<string, string> = {}): Storage {
  const data = { ...initial }
  return {
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => {
      data[k] = v
    }
  } as unknown as Storage
}

describe('agent policy', () => {
  it('defaults to War Room execute off', () => {
    expect(DEFAULT_AGENT_POLICY.allowWarRoomExecute).toBe(false)
    expect(readAgentPolicy(mem())).toEqual({ allowWarRoomExecute: false, workersInheritBypass: false })
  })

  it('only a literal true enables execute', () => {
    expect(parseAgentPolicy({ allowWarRoomExecute: true }).allowWarRoomExecute).toBe(true)
    expect(parseAgentPolicy({ allowWarRoomExecute: 'true' }).allowWarRoomExecute).toBe(false)
    expect(parseAgentPolicy(null).allowWarRoomExecute).toBe(false)
  })

  it('worker bypass inheritance is off unless literally true', () => {
    expect(DEFAULT_AGENT_POLICY.workersInheritBypass).toBe(false)
    expect(parseAgentPolicy({ workersInheritBypass: true }).workersInheritBypass).toBe(true)
    expect(parseAgentPolicy({ workersInheritBypass: 1 }).workersInheritBypass).toBe(false)
  })

  it('round-trips through storage and survives corrupt JSON', () => {
    const s = mem()
    storeAgentPolicy(s, { allowWarRoomExecute: true, workersInheritBypass: true })
    expect(readAgentPolicy(s)).toEqual({ allowWarRoomExecute: true, workersInheritBypass: true })
    expect(readAgentPolicy(mem({ [AGENT_POLICY_KEY]: '{bad' }))).toEqual(DEFAULT_AGENT_POLICY)
  })
})
