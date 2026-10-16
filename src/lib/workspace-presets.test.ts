import { describe, it, expect } from 'vitest'
import {
  BUILTIN_DEFAULT_PRESET,
  WORKSPACE_DEFAULTS_STORAGE_KEY,
  WORKSPACE_TEMPLATES_STORAGE_KEY,
  addTemplate,
  normalizePreset,
  presetSummary,
  readStoredDefaultPreset,
  readStoredTemplates,
  removeTemplate,
  storeDefaultPreset,
  storeTemplates,
  uniqueTemplateName,
  updateTemplate,
  withAvailableAgents,
  fitPresetToCap,
  withKnownAccounts,
  type PresetStorage,
  type WorkspacePreset
} from './workspace-presets'

function fakeStorage(initial: Record<string, string> = {}): PresetStorage & { data: Record<string, string> } {
  const data: Record<string, string> = { ...initial }
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value
    }
  }
}

const preset = (over: Partial<WorkspacePreset> = {}): WorkspacePreset => ({ ...BUILTIN_DEFAULT_PRESET, ...over })

describe('normalizePreset', () => {
  it('keeps a valid preset as is', () => {
    const p = preset({
      folder: 'C:/code',
      terminalCount: 4,
      agentCounts: { 'claude-code': 2, codex: 1 },
      accountSelections: { codex: { mode: 'round-robin' } },
      isolateWorktrees: true,
      splitAgent: 'codex'
    })
    expect(normalizePreset(p)).toEqual(p)
  })

  it('falls back for an invalid terminal count', () => {
    expect(normalizePreset(preset({ terminalCount: 3 })).terminalCount).toBe(2)
  })

  it('drops unknown agents and clamps counts to the terminal total', () => {
    const n = normalizePreset({ terminalCount: 2, agentCounts: { 'claude-code': 5, nope: 1, terminal: 1 } })
    expect(n.agentCounts).toEqual({ 'claude-code': 2 })
  })

  it('drops account selections for agents without accounts and bad shapes', () => {
    const n = normalizePreset({ accountSelections: { gemini: { mode: 'round-robin' }, codex: { mode: 'x' } } })
    expect(n.accountSelections).toEqual({})
  })

  it('clears an unknown split agent', () => {
    expect(normalizePreset({ splitAgent: 'nope' }).splitAgent).toBe('')
  })

  it('keeps a trailing space in the folder (the editor saves while typing)', () => {
    expect(normalizePreset({ folder: 'C:/My ' }).folder).toBe('C:/My ')
  })

  it('turns garbage into the built-in default', () => {
    expect(normalizePreset(null)).toEqual(BUILTIN_DEFAULT_PRESET)
  })
})

describe('default preset storage', () => {
  it('returns the built-in default when nothing is stored', () => {
    expect(readStoredDefaultPreset(fakeStorage())).toEqual(BUILTIN_DEFAULT_PRESET)
  })

  it('returns the built-in default for corrupt JSON', () => {
    expect(readStoredDefaultPreset(fakeStorage({ [WORKSPACE_DEFAULTS_STORAGE_KEY]: '{' }))).toEqual(BUILTIN_DEFAULT_PRESET)
  })

  it('round-trips', () => {
    const s = fakeStorage()
    const p = preset({ folder: 'D:/repo', terminalCount: 6, agentCounts: { codex: 3 } })
    storeDefaultPreset(s, p)
    expect(readStoredDefaultPreset(s)).toEqual(p)
  })

  it('keeps an explicitly empty agent set', () => {
    const s = fakeStorage()
    storeDefaultPreset(s, preset({ agentCounts: {} }))
    expect(readStoredDefaultPreset(s).agentCounts).toEqual({})
  })
})

describe('templates', () => {
  it('reads nothing from empty, corrupt or wrong-version storage', () => {
    expect(readStoredTemplates(fakeStorage())).toEqual([])
    expect(readStoredTemplates(fakeStorage({ [WORKSPACE_TEMPLATES_STORAGE_KEY]: 'x' }))).toEqual([])
    expect(readStoredTemplates(fakeStorage({ [WORKSPACE_TEMPLATES_STORAGE_KEY]: '{"version":99,"templates":[]}' }))).toEqual([])
  })

  it('adds, updates, removes and round-trips', () => {
    const s = fakeStorage()
    let list = addTemplate([], 'Big', preset({ terminalCount: 8 }), 'a')
    list = addTemplate(list, 'Small', preset({ terminalCount: 1, agentCounts: {} }), 'b')
    list = updateTemplate(list, 'a', 'Bigger', preset({ terminalCount: 12 }))
    storeTemplates(s, list)
    const back = readStoredTemplates(s)
    expect(back.map((t) => [t.id, t.name, t.terminalCount])).toEqual([['a', 'Bigger', 12], ['b', 'Small', 1]])
    expect(removeTemplate(back, 'a').map((t) => t.id)).toEqual(['b'])
  })

  it('skips stored entries without a name or with a duplicate id', () => {
    const raw = JSON.stringify({ version: 1, templates: [{ id: 'a', name: ' ' }, { id: 'b', name: 'B' }, { id: 'b', name: 'C' }] })
    expect(readStoredTemplates(fakeStorage({ [WORKSPACE_TEMPLATES_STORAGE_KEY]: raw })).map((t) => t.name)).toEqual(['B'])
  })

  it('makes names unique ignoring case', () => {
    const list = addTemplate([], 'Dev', preset(), 'a')
    expect(uniqueTemplateName(list, 'dev')).toBe('dev (2)')
    expect(addTemplate(list, 'DEV', preset(), 'b')[1].name).toBe('DEV (2)')
    // renaming a template to its own name keeps it
    expect(updateTemplate(list, 'a', 'Dev', preset())[0].name).toBe('Dev')
  })
})

describe('helpers', () => {
  it('summarises a preset', () => {
    const p = preset({ terminalCount: 4, agentCounts: { 'claude-code': 2, codex: 1 }, isolateWorktrees: true })
    expect(presetSummary(p, (id) => id)).toBe('4 terminals · 2 claude-code · 1 codex · worktrees')
  })

  it('fits a preset next to resumed panes under the 12-pane cap', () => {
    const p = preset({ terminalCount: 12, agentCounts: { 'claude-code': 10 } })
    expect(fitPresetToCap(p, 0)).toEqual(p)
    const fitted = fitPresetToCap(p, 3)
    expect(fitted.terminalCount).toBe(8)
    expect(fitted.agentCounts).toEqual({ 'claude-code': 8 })
    expect(fitPresetToCap(p, 11).terminalCount).toBe(1)
  })

  it('drops fixed account choices for deleted accounts', () => {
    const sel = { 'claude-code': { mode: 'fixed' as const, accountId: 'gone' }, codex: { mode: 'round-robin' as const } }
    expect(withKnownAccounts(sel, new Set(['other']))).toEqual({ codex: { mode: 'round-robin' } })
    expect(withKnownAccounts(sel, new Set(['gone']))).toEqual(sel)
  })

  it('drops agents that are not installed', () => {
    const p = preset({ terminalCount: 4, agentCounts: { 'claude-code': 2, codex: 1 } })
    expect(withAvailableAgents(p, (id) => id === 'codex').agentCounts).toEqual({ codex: 1 })
  })
})
