import { describe, expect, it } from 'vitest'
import { addEntry, markTerminalRead, unreadCount } from './notification-center'
import { INPUT_ALERT_ID, MCP_ALERT_ID, VOICE_ALERT_ID, inputDroppedEntry, mcpExitedEntry, voicePipeErrorEntry } from './backend-alerts'
import { isInputQueueFull } from '@/tauri/terminal'

describe('backend alerts', () => {
  it('builds an MCP exit entry with the reason', () => {
    expect(mcpExitedEntry('bind failed', 1)).toEqual({ kind: 'backend', terminalId: MCP_ALERT_ID, title: 'MCP server stopped', detail: 'bind failed', at: 1 })
  })

  it('repeated voice errors collapse into one unread entry', () => {
    let list = addEntry([], voicePipeErrorEntry({ message: 'a' }, 1))
    list = addEntry(list, voicePipeErrorEntry({ message: 'b' }, 2))
    expect(unreadCount(list)).toBe(1)
    expect(list[0].detail).toBe('b')
  })

  it('recovery marks only the voice entry read', () => {
    let list = addEntry([], voicePipeErrorEntry({ message: 'x' }, 1))
    list = addEntry(list, mcpExitedEntry('y', 2))
    list = markTerminalRead(list, VOICE_ALERT_ID, ['backend'])
    expect(list.find((e) => e.terminalId === VOICE_ALERT_ID)?.read).toBe(true)
    expect(list.find((e) => e.terminalId === MCP_ALERT_ID)?.read).toBe(false)
  })

  it('tolerates a missing payload', () => {
    expect(voicePipeErrorEntry(undefined, 1).detail).toBe('')
  })

  it('input-dropped alerts are backend entries that never replace a pane entry', () => {
    const e = inputDroppedEntry('Claude', 3)
    expect(e.kind).toBe('backend')
    expect(e.terminalId).toBe(INPUT_ALERT_ID)
    expect(e.detail).toContain('Claude')
  })

  it('recognises only the queue-full error', () => {
    expect(isInputQueueFull('input-queue-full')).toBe(true)
    expect(isInputQueueFull('target-gone')).toBe(false)
    expect(isInputQueueFull(new Error('x'))).toBe(false)
  })
})
