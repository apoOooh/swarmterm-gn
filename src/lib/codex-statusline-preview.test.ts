import { describe, expect, it } from 'vitest'
import { CODEX_ITEMS, codexPreviewLine } from './codex-statusline-preview'

describe('codex status line preview', () => {
  it('grows from compact to detailed, each a superset', () => {
    expect(CODEX_ITEMS.compact).toEqual(['model-with-reasoning', 'context-remaining'])
    for (const id of CODEX_ITEMS.compact) expect(CODEX_ITEMS.extended).toContain(id)
    for (const id of CODEX_ITEMS.extended) expect(CODEX_ITEMS.detailed).toContain(id)
    expect(CODEX_ITEMS.detailed).toHaveLength(9)
  })

  it('renders one example row per template', () => {
    expect(codexPreviewLine('compact')).toBe('gpt-5.5 high · 58% context left')
    expect(codexPreviewLine('extended')).toContain('weekly 59%')
    expect(codexPreviewLine('detailed')).not.toContain('\n')
  })
})
