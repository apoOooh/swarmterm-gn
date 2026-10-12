import { describe, expect, it } from 'vitest'
import { rewordForPrompt } from './prompt-delivery'

describe('rewordForPrompt', () => {
  it('turns handoff wording into prompt wording', () => {
    expect(rewordForPrompt('The new pane stopped or restarted; the brief was not sent.')).toBe('The pane stopped or restarted; the prompt was not sent.')
    expect(rewordForPrompt('you typed in the new pane')).toBe('you typed in the pane')
  })
})
