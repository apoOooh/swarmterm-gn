import { describe, expect, it } from 'vitest'
import { budgetLeft, nextAccountName, planLabel, statusLamp } from './account-status'

describe('planLabel', () => {
  it('maps known plan ids and keeps unknown ones readable', () => {
    expect(planLabel('max')).toBe('Max')
    expect(planLabel('plus')).toBe('Plus')
    expect(planLabel('API key')).toBe('API key')
    expect(planLabel('team_v2')).toBe('Team v2')
    expect(planLabel(null)).toBeUndefined()
  })
})

describe('statusLamp', () => {
  it('derives the traffic light from the login state', () => {
    expect(statusLamp(undefined)).toEqual({ color: 'grey', label: 'Not checked yet' })
    expect(statusLamp({ state: 'connected' }).color).toBe('green')
    expect(statusLamp({ state: 'expired' }).color).toBe('yellow')
    expect(statusLamp({ state: 'loggedOut' }).color).toBe('red')
  })
})

describe('budgetLeft', () => {
  it('reports what is left, not what is used', () => {
    expect(budgetLeft({ pct: 89 })).toBe(11)
    expect(budgetLeft({ pct: 0 })).toBe(100)
    expect(budgetLeft(undefined)).toBeUndefined()
    expect(budgetLeft({ pct: Number.NaN })).toBeUndefined()
  })
})

describe('nextAccountName', () => {
  it('numbers past existing names of the same agent', () => {
    expect(nextAccountName('Codex', [])).toBe('Codex 1')
    expect(nextAccountName('Codex', ['Codex 1', 'Codex 3', 'Work'])).toBe('Codex 4')
  })
})
