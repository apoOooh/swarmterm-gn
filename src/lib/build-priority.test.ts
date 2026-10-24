import { describe, it, expect } from 'vitest'
import type { LayoutNode } from '@/lib/layout-tree'
import { exemptTerminalIds, readLowerBuildPriority, storeLowerBuildPriority } from './build-priority'

const leaf = (id: string): LayoutNode => ({ type: 'leaf', id: `l-${id}`, terminalId: id })
const split = (a: LayoutNode, b: LayoutNode): LayoutNode => ({
  type: 'split', id: 's', direction: 'horizontal', sizes: [50, 50], children: [a, b]
})

function memory(): Storage {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } as Storage
}

describe('build priority setting', () => {
  it('is on by default and round-trips', () => {
    const s = memory()
    expect(readLowerBuildPriority(s)).toBe(true)
    storeLowerBuildPriority(s, false)
    expect(readLowerBuildPriority(s)).toBe(false)
    storeLowerBuildPriority(s, true)
    expect(readLowerBuildPriority(s)).toBe(true)
  })

  it('stays on when storage throws', () => {
    const broken = { getItem: () => { throw new Error('denied') } }
    expect(readLowerBuildPriority(broken)).toBe(true)
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
