import { describe, expect, it } from 'vitest'
import { budgetUsed, nextAccountName, planLabel, statusLamp } from './account-status'

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

describe('budgetUsed', () => {
  // Same reading as the Claude Code status line, so card and pane never disagree.
  it('reports what is used, clamped and rounded', () => {
    expect(budgetUsed({ pct: 82.4 })).toBe(82)
    expect(budgetUsed({ pct: 0 })).toBe(0)
    expect(budgetUsed({ pct: 140 })).toBe(100)
    expect(budgetUsed(undefined)).toBeUndefined()
    expect(budgetUsed({ pct: Number.NaN })).toBeUndefined()
  })
})

describe('nextAccountName', () => {
  it('numbers past existing names of the same agent', () => {
    expect(nextAccountName('Codex', [])).toBe('Codex 1')
    expect(nextAccountName('Codex', ['Codex 1', 'Codex 3', 'Work'])).toBe('Codex 4')
  })
})
