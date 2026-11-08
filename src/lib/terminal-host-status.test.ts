import { describe, expect, it } from 'vitest'
import { describeHostStatus } from './terminal-host-status'
import type { TerminalHostStatus } from '@/tauri/terminal-host'

const base: TerminalHostStatus = {
  enabled: false,
  supported: true,
  connected: false,
  hostVersion: null,
  error: null,
  priorityUnsupported: null,
  olderHosts: null
}

describe('describeHostStatus', () => {
  it('says panes run in Swarmterm while off', () => {
    expect(describeHostStatus(base)).toBe('Off: terminals run inside Swarmterm.')
  })

  it('names the connected host version', () => {
    expect(describeHostStatus({ ...base, enabled: true, connected: true, hostVersion: '0.1.0' })).toBe(
      'Connected to terminal host 0.1.0.'
    )
  })

  it('waits for the first pane when on but not yet started', () => {
    expect(describeHostStatus({ ...base, enabled: true })).toBe('On: the host starts with the next new pane.')
  })

  it('reports why new panes fell back to in-process', () => {
    expect(describeHostStatus({ ...base, enabled: true, error: 'terminal host not found' })).toBe(
      'Unavailable (terminal host not found). New panes run inside Swarmterm.'
    )
  })

  it('adds the note on hosts of an earlier build', () => {
    const olderHosts = 'Panes from before the update still run on the terminal host 0.1.0.'
    expect(describeHostStatus({ ...base, enabled: true, connected: true, hostVersion: '0.2.0', olderHosts })).toBe(
      `Connected to terminal host 0.2.0. ${olderHosts}`
    )
  })

  it('is unsupported off Windows', () => {
    expect(describeHostStatus({ ...base, supported: false })).toBe('Only available on Windows.')
  })
})
