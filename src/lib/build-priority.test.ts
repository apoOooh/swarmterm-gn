import { describe, it, expect } from 'vitest'
import type { LayoutNode } from '@/lib/layout-tree'
import {
  DEFAULT_PRIORITY,
  LEGACY_BUILD_PRIORITY_KEY,
  PRIORITY_KEY,
  exemptTerminalIds,
  normalizeCpuCap,
  parsePriority,
  readPriority,
  storePriority
} from './build-priority'

const leaf = (id: string): LayoutNode => ({ type: 'leaf', id: `l-${id}`, terminalId: id })
const split = (a: LayoutNode, b: LayoutNode): LayoutNode => ({
  type: 'split', id: 's', direction: 'horizontal', sizes: [50, 50], children: [a, b]
})

type MemStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { map: Map<string, string> }

function memory(init: Record<string, string> = {}): MemStorage {
  const map = new Map(Object.entries(init))
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k)
  }
}

describe('process priority settings', () => {
  it('defaults to strict, below-normal pane, idle builds, no cap', () => {
    expect(readPriority(memory())).toEqual({ mode: 'strict', paneLevel: 'below-normal', buildLevel: 'idle', cpuCap: null })
  })

  it('migrates the old boolean: false ⇒ off, anything else ⇒ defaults', () => {
    expect(readPriority(memory({ [LEGACY_BUILD_PRIORITY_KEY]: 'false' })).mode).toBe('off')
    expect(readPriority(memory({ [LEGACY_BUILD_PRIORITY_KEY]: 'true' }))).toEqual(DEFAULT_PRIORITY)
  })

  it('round-trips and drops the legacy key on store', () => {
    const s = memory({ [LEGACY_BUILD_PRIORITY_KEY]: 'false' })
    const v = { mode: 'agent-normal', paneLevel: 'idle', buildLevel: 'below-normal', cpuCap: 40 } as const
    storePriority(s, v)
    expect(readPriority(s)).toEqual(v)
    expect(s.map.has(LEGACY_BUILD_PRIORITY_KEY)).toBe(false)
  })

  it('repairs bad fields to defaults, never to off', () => {
    expect(parsePriority({ mode: 'normal', paneLevel: 'high', buildLevel: 3, cpuCap: 0 })).toEqual(DEFAULT_PRIORITY)
    expect(readPriority(memory({ [PRIORITY_KEY]: '{broken' }))).toEqual(DEFAULT_PRIORITY)
    expect(parsePriority(null)).toEqual(DEFAULT_PRIORITY)
  })

  it('stays at the defaults when storage throws', () => {
    const broken = { getItem: (): string | null => { throw new Error('denied') } }
    expect(readPriority(broken)).toEqual(DEFAULT_PRIORITY)
  })

  it('keeps the CPU cap to whole percents 1-99', () => {
    expect(normalizeCpuCap(50)).toBe(50)
    expect(normalizeCpuCap(12.6)).toBe(13)
    expect(normalizeCpuCap(0)).toBeNull()
    expect(normalizeCpuCap(100)).toBeNull()
    expect(normalizeCpuCap('50')).toBeNull()
    expect(normalizeCpuCap(Number.NaN)).toBeNull()
  })
})

describe('exemptTerminalIds', () => {
  it('lists every pane of opted-out workspaces only, sorted', () => {
    expect(
      exemptTerminalIds([
        { layout: split(leaf('b'), leaf('a')), normalBuildPriority: true },
        { layout: leaf('c') },
        { layout: leaf('d'), normalBuildPriority: false }
      ])
    ).toEqual(['a', 'b'])
  })
})
