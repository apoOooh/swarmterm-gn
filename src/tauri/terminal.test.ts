import { describe, expect, it } from 'vitest'
import { decodeChannelMessage, decodePtyOut, OUT_DATA, OUT_EXIT, OUT_REPLAY } from '@/tauri/terminal'

const enc = new TextEncoder()

/** Same layout as `PtyOut::encode` in `pty.rs`: body, header, u16 LE len, tag. */
function frame(tag: number, body: string, header = ''): ArrayBuffer {
  const b = enc.encode(body)
  const h = enc.encode(header)
  const out = new Uint8Array(b.length + h.length + 3)
  out.set(b, 0)
  out.set(h, b.length)
  out[out.length - 3] = h.length & 0xff
  out[out.length - 2] = h.length >> 8
  out[out.length - 1] = tag
  return out.buffer
}

describe('decodePtyOut', () => {
  it('returns a data body as UTF-8 bytes, the unit Rust counts for acks', () => {
    const text = 'aé─日\u{1F600}\x1b[0m'
    const msg = decodePtyOut(frame(OUT_DATA, text))
    expect(msg.type).toBe('data')
    if (msg.type !== 'data' || typeof msg.payload === 'string') throw new Error('expected bytes')
    expect(msg.payload).toEqual(enc.encode(text))
    expect(msg.payload.byteLength).toBe(enc.encode(text).length)
    expect(new TextDecoder().decode(msg.payload)).toBe(text)
  })

  it('decodes a replay header and keeps its history bytes', () => {
    const msg = decodePtyOut(frame(OUT_REPLAY, 'history', '{"cols":120,"rows":40,"truncated":true}'))
    expect(msg).toEqual({
      type: 'replay',
      payload: { data: enc.encode('history'), cols: 120, rows: 40, truncated: true }
    })
  })

  it('decodes an empty replay (size only)', () => {
    const msg = decodePtyOut(frame(OUT_REPLAY, '', '{"cols":80,"rows":24,"truncated":false}'))
    expect(msg).toEqual({
      type: 'replay',
      payload: { data: new Uint8Array(), cols: 80, rows: 24, truncated: false }
    })
  })

  it('decodes an exit code, negative included', () => {
    expect(decodePtyOut(frame(OUT_EXIT, '', '{"exitCode":-1}'))).toEqual({
      type: 'exit',
      payload: { exitCode: -1 }
    })
  })

  it('handles a header longer than 255 bytes (two-byte length)', () => {
    const header = JSON.stringify({ cols: 1, rows: 2, truncated: false, pad: 'x'.repeat(300) })
    const msg = decodePtyOut(frame(OUT_REPLAY, 'h', header))
    expect(msg.type === 'replay' && msg.payload.cols).toBe(1)
  })

  it('does not copy the body (a view of the message buffer)', () => {
    const buf = frame(OUT_DATA, 'xyz')
    const msg = decodePtyOut(buf)
    expect(msg.type === 'data' && typeof msg.payload !== 'string' && msg.payload.buffer).toBe(buf)
  })

  it('rejects short frames, overrunning headers and unknown tags', () => {
    expect(() => decodePtyOut(new Uint8Array([0, 0]))).toThrow()
    expect(() => decodePtyOut(new Uint8Array([9, 0, 0]))).toThrow()
    expect(() => decodePtyOut(new Uint8Array([5, 0, OUT_EXIT]))).toThrow()
    expect(() => decodePtyOut(frame(7, 'x'))).toThrow()
  })
})

describe('decodeChannelMessage', () => {
  it('passes a small JSON data string through unchanged', () => {
    expect(decodeChannelMessage('h\u00e9')).toEqual({ type: 'data', payload: 'h\u00e9' })
  })

  it('takes the UTF-8 size Rust sends with a small batch', () => {
    expect(decodeChannelMessage([3, 'hé'])).toEqual({ type: 'data', payload: 'hé', bytes: 3 })
    // As Rust's serde_json emits it: escaped ESC, a 4-byte emoji.
    const raw = JSON.parse('[6,"\\u001b\\ud83d\\ude00a"]') as [number, string]
    expect(decodeChannelMessage(raw)).toEqual({ type: 'data', payload: '\u001b\u{1f600}a', bytes: 6 })
  })

  it('decodes a raw frame', () => {
    expect(decodeChannelMessage(new Uint8Array([7, 0, 0, OUT_DATA])).type).toBe('data')
  })
})
