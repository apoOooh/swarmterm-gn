import { describe, expect, it } from 'vitest'
import { CONNECT_GRACE_MS, connectionStatus } from './war-room-connection'

const base = { connected: false, agentId: 'codex', autoEnrolled: true, joinedAt: 1_000, now: 1_000 }

describe('connectionStatus', () => {
  it('is connected as soon as the handshake landed', () => {
    expect(connectionStatus({ ...base, connected: true }).kind).toBe('connected')
  })

  it('waits during the grace period, then reports an error with a reason', () => {
    expect(connectionStatus({ ...base, now: 1_000 + CONNECT_GRACE_MS - 1 }).kind).toBe('waiting')
    const late = connectionStatus({ ...base, now: 1_000 + CONNECT_GRACE_MS })
    expect(late.kind).toBe('error')
    expect(late.reason).toContain('Settings → MCP')
  })

  it('flags plain shells and agents without auto-enrollment immediately', () => {
    expect(connectionStatus({ ...base, agentId: null }).label).toBe('no agent')
    const manual = connectionStatus({ ...base, autoEnrolled: false })
    expect(manual.kind).toBe('error')
    expect(manual.reason).toContain('SWARMTERM_MCP_URL')
  })
})
