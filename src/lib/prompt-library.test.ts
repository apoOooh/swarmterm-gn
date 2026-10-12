import { describe, expect, it } from 'vitest'
import {
  MAX_PROMPTS,
  MAX_PROMPT_CHARS,
  filterPrompts,
  parsePromptLibrary,
  dispatchTargets,
  removePrompt,
  serializePromptLibrary,
  upsertPrompt,
  validatePrompt,
  type SavedPrompt
} from './prompt-library'

const p = (id: string, title: string, body = 'body', updatedAt = 1): SavedPrompt => ({ id, title, body, updatedAt })

describe('validatePrompt', () => {
  it('needs a title and a body within limits', () => {
    expect(validatePrompt({ title: 'Review', body: 'Check the diff' })).toBeNull()
    expect(validatePrompt({ title: '  ', body: 'x' })).toMatch(/title/i)
    expect(validatePrompt({ title: 'x', body: ' \n ' })).toMatch(/text/i)
    expect(validatePrompt({ title: 'x'.repeat(121), body: 'x' })).toMatch(/title/i)
    expect(validatePrompt({ title: 'x', body: 'x'.repeat(MAX_PROMPT_CHARS + 1) })).toMatch(/long/i)
  })
})

describe('upsertPrompt / removePrompt', () => {
  it('adds new prompts on top and replaces by id', () => {
    const a = upsertPrompt([], p('a', 'A'))
    const b = upsertPrompt(a, p('b', 'B'))
    expect(b.map((x) => x.id)).toEqual(['b', 'a'])
    const edited = upsertPrompt(b, p('a', 'A2', 'new', 5))
    expect(edited.map((x) => x.title)).toEqual(['A2', 'B'])
  })

  it('trims the title, keeps the body verbatim', () => {
    expect(upsertPrompt([], p('a', '  A  ', '  keep\n'))[0]).toMatchObject({ title: 'A', body: '  keep\n' })
  })

  it('refuses a new prompt beyond the cap but allows edits', () => {
    const full = Array.from({ length: MAX_PROMPTS }, (_, i) => p(String(i), `P${i}`))
    expect(upsertPrompt(full, p('new', 'N'))).toBe(full)
    expect(upsertPrompt(full, p('3', 'edited'))[0].title).toBe('edited')
  })

  it('removes by id', () => {
    expect(removePrompt([p('a', 'A'), p('b', 'B')], 'a').map((x) => x.id)).toEqual(['b'])
  })
})

describe('filterPrompts', () => {
  const list = [p('a', 'Code review', 'look at the diff'), p('b', 'Release notes', 'summarise CHANGELOG')]
  it('matches title and body, case-insensitive, every word', () => {
    expect(filterPrompts(list, '').length).toBe(2)
    expect(filterPrompts(list, 'REVIEW').map((x) => x.id)).toEqual(['a'])
    expect(filterPrompts(list, 'changelog').map((x) => x.id)).toEqual(['b'])
    expect(filterPrompts(list, 'release diff')).toEqual([])
  })
})

describe('persistence', () => {
  it('round-trips and survives garbage', () => {
    const list = [p('a', 'A', 'x', 3)]
    expect(parsePromptLibrary(serializePromptLibrary(list))).toEqual(list)
    expect(parsePromptLibrary(null)).toEqual([])
    expect(parsePromptLibrary('nope')).toEqual([])
    expect(parsePromptLibrary('{"version":2,"prompts":[]}')).toEqual([])
  })

  it('drops invalid entries and duplicate ids', () => {
    const raw = JSON.stringify({
      version: 1,
      prompts: [p('a', 'A'), { id: 'b', title: '', body: 'x', updatedAt: 1 }, { id: 3 }, p('a', 'dup')]
    })
    expect(parsePromptLibrary(raw).map((x) => x.title)).toEqual(['A'])
  })
})

describe('dispatchTargets', () => {
  it('lists running agent panes only, labelled with workspace', () => {
    const targets = dispatchTargets(
      [
        {
          workspaceName: 'api',
          panes: [
            { terminalId: 't1', agentId: 'claude-code', title: 'Fix login', running: true },
            { terminalId: 't2', agentId: 'terminal', title: 'pwsh', running: true },
            { terminalId: 't3', agentId: 'codex', title: '', running: false }
          ]
        },
        { workspaceName: 'web', panes: [{ terminalId: 't4', agentId: 'codex', title: 'Tests', running: true }] }
      ],
      (id) => (id === 'claude-code' ? 'Claude Code' : 'Codex')
    )
    expect(targets).toEqual([
      { terminalId: 't1', label: 'api · Claude Code · Fix login' },
      { terminalId: 't4', label: 'web · Codex · Tests' }
    ])
  })
})
