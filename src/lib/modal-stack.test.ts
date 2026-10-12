import { describe, expect, it } from 'vitest'
import { foreignModalAbove, ownsKeyboard, pushModal, removeModal } from './modal-stack'

describe('modal stack', () => {
  it('only the most recently opened modal owns the keyboard', () => {
    const s = pushModal(pushModal([], 1), 2)
    expect(ownsKeyboard(s, 2, false)).toBe(true)
    expect(ownsKeyboard(s, 1, false)).toBe(false)
  })

  it('the lower modal regains the keyboard when the top one closes', () => {
    const s = removeModal(pushModal(pushModal([], 1), 2), 2)
    expect(ownsKeyboard(s, 1, false)).toBe(true)
  })

  it('a foreign modal (e.g. Settings) opened over ours takes the keyboard', () => {
    expect(ownsKeyboard(pushModal([], 1), 1, true)).toBe(false)
  })

  it('re-pushing moves a modal to the top without duplicates', () => {
    expect(pushModal([1, 2], 1)).toEqual([2, 1])
  })

  it('an unregistered modal never owns the keyboard', () => {
    expect(ownsKeyboard([], 1, false)).toBe(false)
  })

  it('a foreign modal that was already open below ours does not take the keyboard (review 6)', () => {
    const settings = {}
    const later = {}
    expect(foreignModalAbove([settings], new Set([settings]))).toBe(false)
    expect(foreignModalAbove([settings, later], new Set([settings]))).toBe(true)
    expect(foreignModalAbove([], new Set([settings]))).toBe(false)
  })
})
