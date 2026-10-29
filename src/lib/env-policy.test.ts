import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ENV_POLICY,
  ENV_POLICY_KEY,
  ignoredAllowEntries,
  parseAllowList,
  parseEnvPolicy,
  readEnvPolicy,
  storeEnvPolicy
} from './env-policy'

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data
  }
}

describe('env-policy', () => {
  it('defaults to filtering secrets', () => {
    expect(DEFAULT_ENV_POLICY).toEqual({ passSecrets: false, mode: 'default', allow: [] })
  })

  it('parses field-wise, a bad field falls back to its (secure) default', () => {
    expect(parseEnvPolicy({ passSecrets: 'yes', mode: 'bogus', allow: 'X' })).toEqual(DEFAULT_ENV_POLICY)
    expect(parseEnvPolicy(null)).toEqual(DEFAULT_ENV_POLICY)
    expect(parseEnvPolicy({ passSecrets: true, mode: 'strict', allow: ['A', 7, ' b '] })).toEqual({
      passSecrets: true,
      mode: 'strict',
      allow: ['A', 'b']
    })
  })

  it('splits the allowlist on commas, spaces and newlines, drops invalid names and duplicates', () => {
    expect(parseAllowList('FOO_API_KEY, my_*\nBAR  foo_api_key bad=name *')).toEqual(['FOO_API_KEY', 'my_*', 'BAR'])
  })

  it('lists the entries it ignores so the user sees why they vanished', () => {
    expect(ignoredAllowEntries(' A, bad=name\n*  B ')).toEqual(['bad=name', '*'])
  })

  it('round-trips through storage and survives garbage', () => {
    const s = memory()
    storeEnvPolicy(s, { passSecrets: false, mode: 'strict', allow: ['X'] })
    expect(readEnvPolicy(s)).toEqual({ passSecrets: false, mode: 'strict', allow: ['X'] })
    expect(readEnvPolicy(memory({ [ENV_POLICY_KEY]: '{oops' }))).toEqual(DEFAULT_ENV_POLICY)
    const throwing = {
      getItem: () => {
        throw new Error('denied')
      }
    }
    expect(readEnvPolicy(throwing)).toEqual(DEFAULT_ENV_POLICY)
  })
})
