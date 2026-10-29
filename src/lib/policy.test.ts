import { describe, expect, it } from 'vitest'
import { describeActivePolicies, isLaunchModeLocked, parseAdminPolicy, UNMANAGED_POLICY } from './policy'

describe('parseAdminPolicy', () => {
  it('reads a malformed answer as unmanaged', () => {
    expect(parseAdminPolicy(null)).toEqual(UNMANAGED_POLICY)
    expect(parseAdminPolicy({ disableMcp: 1, envPolicy: 'off', envAllow: 'X', active: 'nope' })).toEqual(
      UNMANAGED_POLICY
    )
  })

  it('takes literal true flags, valid env values and the active list', () => {
    const p = parseAdminPolicy({
      disableMcp: true,
      envPolicy: 'strict',
      envAllow: ['CORP_PROXY', 3],
      active: ['DisableMcp', 'EnvPolicy', 'EnvAllow']
    })
    expect(p.disableMcp).toBe(true)
    expect(p.disableCompanion).toBe(false)
    expect(p.envPolicy).toBe('strict')
    expect(p.envAllow).toEqual(['CORP_PROXY'])
    expect(p.locked).toBe(true)
  })
})

describe('describeActivePolicies', () => {
  it('describes known values, details env ones and keeps unknown names', () => {
    const p = parseAdminPolicy({
      envPolicy: 'default',
      envAllow: ['A', 'B'],
      active: ['DisableMcp', 'EnvPolicy', 'EnvAllow', 'Future']
    })
    expect(describeActivePolicies(p)).toEqual([
      'The Swarmterm MCP server is off',
      'The environment filter is forced on (default)',
      'Extra environment names are allowed by the administrator: A, B',
      'Future'
    ])
  })
})

describe('isLaunchModeLocked', () => {
  it('locks only dangerous modes and only under DisableBypassModes', () => {
    const locked = parseAdminPolicy({ disableBypassModes: true, active: ['DisableBypassModes'] })
    expect(isLaunchModeLocked(locked, true)).toBe(true)
    expect(isLaunchModeLocked(locked, false)).toBe(false)
    expect(isLaunchModeLocked(UNMANAGED_POLICY, true)).toBe(false)
  })
})
