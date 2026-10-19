import { describe, it, expect } from 'vitest'
import { createWebglBudget, WEBGL_CONTEXT_BUDGET } from './webgl-budget'

describe('createWebglBudget', () => {
  it('keeps the budget below the browser context limit', () => {
    expect(WEBGL_CONTEXT_BUDGET).toBeLessThan(16)
  })

  it('grants slots until the budget is full without evicting', () => {
    const evicted: string[] = []
    const b = createWebglBudget<string>(2, (k) => evicted.push(k))
    expect(b.acquire('a')).toBe(true)
    expect(b.acquire('b')).toBe(true)
    expect(b.size()).toBe(2)
    expect(evicted).toEqual([])
  })

  it('evicts the least recently visible holder first', () => {
    const evicted: string[] = []
    const b = createWebglBudget<string>(2, (k) => evicted.push(k))
    b.acquire('a')
    b.acquire('b')
    b.acquire('a') // a seen again: b is now the oldest
    b.acquire('c')
    expect(evicted).toEqual(['b'])
    expect(b.has('a')).toBe(true)
    expect(b.has('b')).toBe(false)
    expect(b.has('c')).toBe(true)
  })

  it('re-acquiring an existing holder never evicts', () => {
    const evicted: string[] = []
    const b = createWebglBudget<string>(1, (k) => evicted.push(k))
    b.acquire('a')
    expect(b.acquire('a')).toBe(true)
    expect(evicted).toEqual([])
  })

  it('a released slot is reused without eviction', () => {
    const evicted: string[] = []
    const b = createWebglBudget<string>(1, (k) => evicted.push(k))
    b.acquire('a')
    b.release('a')
    expect(b.acquire('b')).toBe(true)
    expect(evicted).toEqual([])
    b.release('missing') // no-op
    expect(b.size()).toBe(1)
  })

  it('a zero budget grants nothing', () => {
    const b = createWebglBudget<string>(0, () => {})
    expect(b.acquire('a')).toBe(false)
    expect(b.size()).toBe(0)
  })
})
