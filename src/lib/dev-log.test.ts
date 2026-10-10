import { describe, expect, it } from 'vitest'
import { formatRecord } from './dev-log'
describe('dev log records', () => {
  it('serialises errors, cycles and long strings without throwing', () => {
    const cyc: Record<string, unknown> = { a: 1 }; cyc.self = cyc
    const line = formatRecord({ t: 'T', level: 'error', event: 'x', data: { err: new Error('boom'), cyc, long: 'y'.repeat(3000) } })
    const parsed = JSON.parse(line)
    expect(parsed.data.err.message).toBe('boom')
    expect(parsed.data.cyc.self).toBe('[circular]')
    expect(parsed.data.long.length).toBeLessThan(2100)
    expect(line).not.toContain('\n')
  })
})
