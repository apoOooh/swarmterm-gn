import { describe, expect, it } from 'vitest'
import { centerEntryView } from './notification-entry-view'
import { mcpExitedEntry, voicePipeErrorEntry } from './backend-alerts'
import type { CenterEntry } from './notification-center'

const entry = (over: Partial<CenterEntry>): CenterEntry =>
  ({ id: 'e1', kind: 'completion', terminalId: 't1', title: 'Done', detail: '', at: 1, read: false, ...over }) as CenterEntry

const ws = { name: 'Main', layout: { type: 'leaf' as const, id: 'l1', terminalId: 't1' } }

describe('centerEntryView', () => {
  it('backend MCP entry shows its detail and stays clickable without reveal', () => {
    const e = { ...mcpExitedEntry('bind failed', 1), id: 'x', read: false } as CenterEntry
    expect(centerEntryView([ws], e)).toEqual({ subtitle: 'bind failed', disabled: false, reveal: false })
  })

  it('backend voice entry is not "Pane closed"', () => {
    const e = { ...voicePipeErrorEntry({ message: 'pipe broke' }, 1), id: 'y', read: false } as CenterEntry
    const v = centerEntryView([], e)
    expect(v.subtitle).toBe('pipe broke')
    expect(v.disabled).toBe(false)
  })

  it('pane entry with a live pane reveals it', () => {
    expect(centerEntryView([ws], entry({ detail: 'Build' }))).toEqual({ subtitle: 'Main · Build', disabled: false, reveal: true })
  })

  it('pane entry whose pane is gone is disabled', () => {
    expect(centerEntryView([ws], entry({ terminalId: 'gone' }))).toEqual({ subtitle: 'Pane closed', disabled: true, reveal: false })
  })

  it('marks drawered panes', () => {
    expect(centerEntryView([{ ...ws, drawerLeafIds: ['l1'] }], entry({ detail: 'X' })).subtitle).toBe('Main · X (drawer)')
  })
})
