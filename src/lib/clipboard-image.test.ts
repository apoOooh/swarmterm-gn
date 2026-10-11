import { describe, it, expect } from 'vitest'
import { imagePasteText, supportsImagePaste } from './clipboard-image'

describe('supportsImagePaste', () => {
  it('is on for Claude Code and Codex only', () => {
    expect(supportsImagePaste('claude-code')).toBe(true)
    expect(supportsImagePaste('codex')).toBe(true)
    expect(supportsImagePaste('gemini')).toBe(false)
    expect(supportsImagePaste('terminal')).toBe(false)
    expect(supportsImagePaste(undefined)).toBe(false)
  })
})

describe('imagePasteText', () => {
  it('leaves a clean path bare with one trailing space', () => {
    expect(imagePasteText('C:\Temp\swarmterm-paste\a.png')).toBe('C:\Temp\swarmterm-paste\a.png ')
  })

  it('double-quotes a path containing whitespace', () => {
    expect(imagePasteText('C:\Users\Jane Doe\Temp\a.png')).toBe('"C:\Users\Jane Doe\Temp\a.png" ')
  })

  it('refuses a path with a newline or quote', () => {
    expect(imagePasteText('C:\a\nb.png')).toBe('')
    expect(imagePasteText('C:\a"b.png')).toBe('')
  })
})
