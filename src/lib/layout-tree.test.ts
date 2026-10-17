import { describe, it, expect } from 'vitest'
import {
  type LayoutNode,
  type LeafNode,
  type SplitNode,
  findLeaf,
  collectLeaves,
  splitLeaf,
  closeLeaf,
  resizeSplit,
  updateLeaf,
  reorderLeaves,
  gridFor,
  buildBalancedTree,
  buildGridLayout,
  paneLayoutFor,
  layoutSummary,
  moveLeafBeside,
  tidyLayout,
  equalizeSplit
} from './layout-tree'

// --- helpers ---------------------------------------------------------------

function leaf(id: string): LeafNode {
  return { type: 'leaf', id, terminalId: `term-${id}` }
}

function split(
  id: string,
  direction: SplitNode['direction'],
  children: [LayoutNode, LayoutNode],
  sizes: [number, number] = [50, 50]
): SplitNode {
  return { type: 'split', id, direction, sizes, children }
}

// Nested fixture:
//   S1 (horizontal) [50,50]
//   ├─ A
//   └─ S2 (vertical) [60,40]
//      ├─ B
//      └─ C
function nestedTree(): SplitNode {
  return split('S1', 'horizontal', [
    leaf('A'),
    split('S2', 'vertical', [leaf('B'), leaf('C')], [60, 40])
  ])
}

// --- findLeaf --------------------------------------------------------------

describe('findLeaf', () => {
  it('returns the leaf when the tree is a single matching leaf', () => {
    expect(findLeaf(leaf('A'), 'A')).toEqual(leaf('A'))
  })

  it('returns null when a single-leaf tree does not match', () => {
    expect(findLeaf(leaf('A'), 'Z')).toBeNull()
  })

  it('finds a deeply nested leaf', () => {
    expect(findLeaf(nestedTree(), 'C')).toEqual(leaf('C'))
  })

  it('returns null for a split node id (only leaves match)', () => {
    expect(findLeaf(nestedTree(), 'S2')).toBeNull()
  })

  it('returns null when the leaf is absent from a nested tree', () => {
    expect(findLeaf(nestedTree(), 'Z')).toBeNull()
  })
})

// --- collectLeaves ---------------------------------------------------------

describe('collectLeaves', () => {
  it('returns the single leaf for a leaf-only tree', () => {
    expect(collectLeaves(leaf('A'))).toEqual([leaf('A')])
  })

  it('returns every leaf in left-to-right order', () => {
    expect(collectLeaves(nestedTree()).map((l) => l.id)).toEqual(['A', 'B', 'C'])
  })
})

// --- resizeSplit -----------------------------------------------------------

describe('resizeSplit', () => {
  it('updates the sizes of the targeted split', () => {
    const result = resizeSplit(nestedTree(), 'S2', [25, 75]) as SplitNode
    const s2 = result.children[1] as SplitNode
    expect(s2.sizes).toEqual([25, 75])
  })

  it('leaves other splits untouched', () => {
    const result = resizeSplit(nestedTree(), 'S2', [25, 75]) as SplitNode
    expect(result.sizes).toEqual([50, 50])
  })

  it('returns the tree unchanged when the split id is absent', () => {
    const tree = nestedTree()
    expect(resizeSplit(tree, 'NOPE', [10, 90])).toEqual(tree)
  })

  it('does not mutate the input tree', () => {
    const tree = nestedTree()
    resizeSplit(tree, 'S2', [25, 75])
    expect((tree.children[1] as SplitNode).sizes).toEqual([60, 40])
  })
})

// --- splitLeaf -------------------------------------------------------------

describe('splitLeaf', () => {
  it('replaces a single-leaf tree with a split of [old, new]', () => {
    const result = splitLeaf(leaf('A'), 'A', 'vertical', leaf('B'), 'S1') as SplitNode
    expect(result.type).toBe('split')
    expect(result.id).toBe('S1')
    expect(result.direction).toBe('vertical')
    expect(result.sizes).toEqual([50, 50])
    expect(result.children).toEqual([leaf('A'), leaf('B')])
  })

  it('splits a nested leaf in place, keeping the rest of the tree', () => {
    const result = splitLeaf(nestedTree(), 'A', 'horizontal', leaf('D'), 'S3') as SplitNode
    const newSplit = result.children[0] as SplitNode
    expect(newSplit.id).toBe('S3')
    expect(newSplit.direction).toBe('horizontal')
    expect(newSplit.children).toEqual([leaf('A'), leaf('D')])
    expect(result.children[1]).toEqual(nestedTree().children[1])
  })

  it('returns the tree unchanged when the leaf id is absent', () => {
    const tree = nestedTree()
    expect(splitLeaf(tree, 'Z', 'vertical', leaf('D'), 'S3')).toEqual(tree)
  })

  it('does not mutate the input tree', () => {
    const tree = nestedTree()
    splitLeaf(tree, 'A', 'vertical', leaf('D'), 'S3')
    expect(tree.children[0]).toEqual(leaf('A'))
  })
})

// --- closeLeaf -------------------------------------------------------------

describe('closeLeaf', () => {
  it('returns null when closing the only leaf (root leaf)', () => {
    expect(closeLeaf(leaf('A'), 'A')).toBeNull()
  })

  it('collapses the parent split, promoting the sibling leaf', () => {
    const result = closeLeaf(nestedTree(), 'B') as SplitNode
    expect(result.id).toBe('S1')
    expect(result.children[0]).toEqual(leaf('A'))
    expect(result.children[1]).toEqual(leaf('C'))
  })

  it('promotes a whole sibling subtree when closing its sibling leaf', () => {
    const result = closeLeaf(nestedTree(), 'A') as SplitNode
    expect(result.id).toBe('S2')
    expect(collectLeaves(result).map((l) => l.id)).toEqual(['B', 'C'])
  })

  it('returns the tree unchanged when the leaf id is absent', () => {
    const tree = nestedTree()
    expect(closeLeaf(tree, 'Z')).toEqual(tree)
  })

  it('does not mutate the input tree', () => {
    const tree = nestedTree()
    closeLeaf(tree, 'B')
    expect(collectLeaves(tree).map((l) => l.id)).toEqual(['A', 'B', 'C'])
  })
})

// --- gridFor ---------------------------------------------------------------

describe('gridFor', () => {
  it('maps each supported terminal count to a grid', () => {
    expect(gridFor(1)).toEqual({ rows: 1, cols: 1 })
    expect(gridFor(2)).toEqual({ rows: 1, cols: 2 })
    expect(gridFor(4)).toEqual({ rows: 2, cols: 2 })
    expect(gridFor(6)).toEqual({ rows: 2, cols: 3 })
    expect(gridFor(8)).toEqual({ rows: 2, cols: 4 })
    expect(gridFor(10)).toEqual({ rows: 2, cols: 5 })
    expect(gridFor(12)).toEqual({ rows: 3, cols: 4 })
  })

  it('has rows times cols equal to the terminal count', () => {
    for (const n of [1, 2, 4, 6, 8, 10, 12]) {
      const { rows, cols } = gridFor(n)
      expect(rows * cols).toBe(n)
    }
  })

  it('throws for an unsupported terminal count', () => {
    expect(() => gridFor(3)).toThrow()
  })
})

// --- buildBalancedTree -----------------------------------------------------

/** A fresh sequential split-id generator: `sp0`, `sp1`, ... */
function splitIds(): () => string {
  let n = 0
  return () => `sp${n++}`
}

describe('buildBalancedTree', () => {
  it('returns the single item unchanged for a one-item list', () => {
    expect(buildBalancedTree([leaf('A')], 'horizontal', splitIds())).toEqual(leaf('A'))
  })

  it('combines two items into one even split', () => {
    const result = buildBalancedTree([leaf('A'), leaf('B')], 'horizontal', splitIds()) as SplitNode
    expect(result.type).toBe('split')
    expect(result.direction).toBe('horizontal')
    expect(result.sizes).toEqual([50, 50])
    expect(collectLeaves(result).map((l) => l.id)).toEqual(['A', 'B'])
  })

  it('keeps left-to-right order for more than two items', () => {
    const result = buildBalancedTree([leaf('A'), leaf('B'), leaf('C')], 'vertical', splitIds())
    expect(collectLeaves(result).map((l) => l.id)).toEqual(['A', 'B', 'C'])
  })

  it('sizes a split in proportion to each side leaf count', () => {
    const result = buildBalancedTree(
      [leaf('A'), leaf('B'), leaf('C')],
      'horizontal',
      splitIds()
    ) as SplitNode
    // left subtree holds 2 leaves, right holds 1
    expect(result.sizes[0]).toBeCloseTo(66.667, 2)
    expect(result.sizes[0] + result.sizes[1]).toBe(100)
  })
})

// --- buildGridLayout -------------------------------------------------------

/** Fresh deterministic leaf / split-id generators for grid-layout tests. */
function gridGenerators(): { makeLeaf: () => LeafNode; makeSplitId: () => string } {
  let l = 0
  let s = 0
  return {
    makeLeaf: (): LeafNode => {
      const id = `L${l++}`
      return { type: 'leaf', id, terminalId: `t-${id}` }
    },
    makeSplitId: () => `S${s++}`
  }
}

describe('buildGridLayout', () => {
  it('returns a single leaf for a one-terminal layout', () => {
    const { makeLeaf, makeSplitId } = gridGenerators()
    expect(buildGridLayout(1, makeLeaf, makeSplitId).type).toBe('leaf')
  })

  it('produces exactly `count` leaves for every supported count', () => {
    for (const n of [1, 2, 4, 6, 8, 10, 12]) {
      const { makeLeaf, makeSplitId } = gridGenerators()
      expect(collectLeaves(buildGridLayout(n, makeLeaf, makeSplitId))).toHaveLength(n)
    }
  })

  it('lays four terminals out as rows of columns', () => {
    const { makeLeaf, makeSplitId } = gridGenerators()
    const tree = buildGridLayout(4, makeLeaf, makeSplitId) as SplitNode
    expect(tree.type).toBe('split')
    expect(tree.direction).toBe('vertical')
    expect((tree.children[0] as SplitNode).direction).toBe('horizontal')
  })

  it('gives each leaf a distinct terminalId', () => {
    const { makeLeaf, makeSplitId } = gridGenerators()
    const ids = collectLeaves(buildGridLayout(8, makeLeaf, makeSplitId)).map((l) => l.terminalId)
    expect(new Set(ids).size).toBe(8)
  })
})

// --- updateLeaf ------------------------------------------------------------

describe('updateLeaf', () => {
  it('patches the matching leaf with the given fields', () => {
    const result = updateLeaf(nestedTree(), 'B', { agentId: 'codex' }) as SplitNode
    const s2 = result.children[1] as SplitNode
    expect((s2.children[0] as LeafNode).agentId).toBe('codex')
  })

  it('sets a per-pane cwd override', () => {
    const result = updateLeaf(leaf('A'), 'A', { cwd: 'D:/x' }) as LeafNode
    expect(result.cwd).toBe('D:/x')
  })

  it('clears a cwd override when patched with undefined', () => {
    const withCwd = updateLeaf(leaf('A'), 'A', { cwd: 'D:/x' }) as LeafNode
    const cleared = updateLeaf(withCwd, 'A', { cwd: undefined }) as LeafNode
    expect(cleared.cwd).toBeUndefined()
  })

  it('leaves other leaves untouched', () => {
    const result = updateLeaf(nestedTree(), 'B', { shellId: 'wsl' }) as SplitNode
    expect((result.children[0] as LeafNode).shellId).toBeUndefined()
  })

  it('returns the tree unchanged when the leaf id is absent', () => {
    const tree = nestedTree()
    expect(updateLeaf(tree, 'Z', { agentId: 'codex' })).toEqual(tree)
  })

  it('does not mutate the input tree', () => {
    const tree = nestedTree()
    updateLeaf(tree, 'B', { agentId: 'codex' })
    const s2 = tree.children[1] as SplitNode
    expect((s2.children[0] as LeafNode).agentId).toBeUndefined()
  })

  it('sets and clears worktree binding fields', () => {
    const leaf: LayoutNode = { type: 'leaf', id: 'a', terminalId: 't-a' }
    const bound = updateLeaf(leaf, 'a', { worktreeBranch: 'feat/login', initialPrompt: 'go' })
    expect((bound as LeafNode).worktreeBranch).toBe('feat/login')
    expect((bound as LeafNode).initialPrompt).toBe('go')
    const cleared = updateLeaf(bound, 'a', { worktreeBranch: undefined, initialPrompt: undefined })
    expect((cleared as LeafNode).worktreeBranch).toBeUndefined()
  })

  it('updateLeaf can set and clear resumeSessionId', () => {
    const leaf: LeafNode = { type: 'leaf', id: 'l1', terminalId: 't1' }
    const set = updateLeaf(leaf, 'l1', { resumeSessionId: 'fe845bc6-6932-4459-8fb6-cdd0e7c6cc84' })
    expect((set as LeafNode).resumeSessionId).toBe('fe845bc6-6932-4459-8fb6-cdd0e7c6cc84')
    const cleared = updateLeaf(set, 'l1', { resumeSessionId: undefined })
    expect((cleared as LeafNode).resumeSessionId).toBeUndefined()
  })
})

// --- reorderLeaves ---------------------------------------------------------

// 2x2 grid fixture, leaves in depth-first order [A, B, C, D]:
//   R  (vertical)   [30,70]
//   ├─ T  (horizontal) [50,50] ├─ A └─ B
//   └─ B2 (horizontal) [40,60] ├─ C └─ D
function gridTree(): SplitNode {
  return split(
    'R',
    'vertical',
    [
      split('T', 'horizontal', [leaf('A'), leaf('B')], [50, 50]),
      split('B2', 'horizontal', [leaf('C'), leaf('D')], [40, 60])
    ],
    [30, 70]
  )
}

describe('reorderLeaves', () => {
  it('moves a leaf to the target slot, shifting the panes in between (reflow)', () => {
    // Drag A (slot 0) onto C (slot 2): [A,B,C,D] -> [B,C,A,D]
    const result = reorderLeaves(gridTree(), 'A', 'C')
    expect(collectLeaves(result).map((l) => l.id)).toEqual(['B', 'C', 'A', 'D'])
  })

  it('reorders two leaves under the same parent', () => {
    const result = reorderLeaves(gridTree(), 'A', 'B')
    expect(collectLeaves(result).map((l) => l.id)).toEqual(['B', 'A', 'C', 'D'])
  })

  it('moves a later leaf earlier, shifting the rest right', () => {
    // Drag D (slot 3) onto A (slot 0): [A,B,C,D] -> [D,A,B,C]
    const result = reorderLeaves(gridTree(), 'D', 'A')
    expect(collectLeaves(result).map((l) => l.id)).toEqual(['D', 'A', 'B', 'C'])
  })

  it('carries the whole leaf node (terminalId and overrides) to its new slot', () => {
    const a: LeafNode = { type: 'leaf', id: 'A', terminalId: 'term-A', agentId: 'claude-code', cwd: '/a' }
    const tree = split('S', 'horizontal', [a, leaf('B')])
    const result = reorderLeaves(tree, 'A', 'B') as SplitNode
    expect(result.children[1]).toEqual(a) // moved intact, overrides preserved
  })

  it('preserves the split skeleton (ids, directions, sizes)', () => {
    const result = reorderLeaves(gridTree(), 'A', 'C') as SplitNode
    expect(result.id).toBe('R')
    expect(result.direction).toBe('vertical')
    expect(result.sizes).toEqual([30, 70])
    const top = result.children[0] as SplitNode
    expect(top.id).toBe('T')
    expect(top.direction).toBe('horizontal')
    expect(top.sizes).toEqual([50, 50])
    expect((result.children[1] as SplitNode).sizes).toEqual([40, 60])
  })

  it('returns the same tree reference when both ids are equal', () => {
    const tree = gridTree()
    expect(reorderLeaves(tree, 'A', 'A')).toBe(tree)
  })

  it('returns the same tree reference when a leaf is missing', () => {
    const tree = gridTree()
    expect(reorderLeaves(tree, 'A', 'Z')).toBe(tree)
  })

  it('does not mutate its input', () => {
    const tree = gridTree()
    const snapshot = structuredClone(tree)
    reorderLeaves(tree, 'A', 'C')
    expect(tree).toEqual(snapshot)
  })
})

// --- paneLayoutFor -----------------------------------------------------------

describe('paneLayoutFor', () => {
  function makeLeafFactory(): () => LeafNode {
    let n = 0
    return () => ({ type: 'leaf', id: `L${n}`, terminalId: `T${n++}` })
  }
  function splitIds(): () => string {
    let n = 0
    return () => `s${n++}`
  }

  it('produces exactly `count` leaves for every count 1..12', () => {
    for (let count = 1; count <= 12; count++) {
      const tree = paneLayoutFor(count, makeLeafFactory(), splitIds())
      expect(collectLeaves(tree)).toHaveLength(count)
    }
  })

  it('matches buildGridLayout for supported grid counts', () => {
    for (const count of [1, 2, 4, 6, 8, 10, 12]) {
      const grid = buildGridLayout(count, makeLeafFactory(), splitIds())
      const viaPane = paneLayoutFor(count, makeLeafFactory(), splitIds())
      expect(viaPane).toEqual(grid)
    }
  })

  it('builds a valid tree with the right leaf count for odd counts', () => {
    for (const count of [3, 5, 7, 9, 11]) {
      const tree = paneLayoutFor(count, makeLeafFactory(), splitIds())
      expect(collectLeaves(tree)).toHaveLength(count)
    }
  })

  it('calls makeLeaf row-major so leaves come out in build order', () => {
    const tree = paneLayoutFor(5, makeLeafFactory(), splitIds())
    expect(collectLeaves(tree).map((l) => l.terminalId)).toEqual(['T0', 'T1', 'T2', 'T3', 'T4'])
  })

  it('throws on a count below 1', () => {
    expect(() => paneLayoutFor(0, makeLeafFactory(), splitIds())).toThrow()
  })
})

// --- layoutSummary -----------------------------------------------------------

describe('layoutSummary', () => {
  it('captions a single pane without a grid shape', () => {
    expect(layoutSummary(1)).toBe('1 pane')
  })

  it('captions grid counts with their grid shape', () => {
    expect(layoutSummary(2)).toBe('2 panes · 1×2')
    expect(layoutSummary(4)).toBe('4 panes · 2×2')
    expect(layoutSummary(12)).toBe('12 panes · 3×4')
  })

  it('omits the grid shape for non-grid counts', () => {
    expect(layoutSummary(3)).toBe('3 panes')
    expect(layoutSummary(5)).toBe('5 panes')
  })
})

// --- moveLeafBeside --------------------------------------------------------

describe('moveLeafBeside', () => {
  // The user's case: [A | B] on top, C full-width below.
  //   R (vertical)
  //   ├─ T (horizontal) [A, B]
  //   └─ C
  function threePane(): SplitNode {
    return split('R', 'vertical', [split('T', 'horizontal', [leaf('A'), leaf('B')]), leaf('C')])
  }

  it('docks A left of C: B widens, C slot splits side by side with A first', () => {
    expect(moveLeafBeside(threePane(), 'A', 'C', 'left', 'N')).toEqual(
      split('R', 'vertical', [leaf('B'), split('N', 'horizontal', [leaf('A'), leaf('C')])])
    )
  })

  it('docks A below C: stacked with A second', () => {
    expect(moveLeafBeside(threePane(), 'A', 'C', 'bottom', 'N')).toEqual(
      split('R', 'vertical', [leaf('B'), split('N', 'vertical', [leaf('C'), leaf('A')])])
    )
  })

  it('maps right → horizontal after and top → vertical before', () => {
    const two = split('S', 'horizontal', [leaf('A'), leaf('B')])
    expect(moveLeafBeside(two, 'A', 'B', 'right', 'N')).toEqual(
      split('N', 'horizontal', [leaf('B'), leaf('A')])
    )
    expect(moveLeafBeside(two, 'A', 'B', 'top', 'N')).toEqual(
      split('N', 'vertical', [leaf('A'), leaf('B')])
    )
  })

  it('keeps unrelated split sizes', () => {
    const out = moveLeafBeside(nestedTree(), 'B', 'A', 'top', 'N') as SplitNode
    expect(out.sizes).toEqual([50, 50])
    expect(out.children[0]).toEqual(split('N', 'vertical', [leaf('B'), leaf('A')]))
    expect(out.children[1]).toEqual(leaf('C'))
  })

  it('returns the same reference for self-drops and unknown ids', () => {
    const t = threePane()
    expect(moveLeafBeside(t, 'A', 'A', 'left', 'N')).toBe(t)
    expect(moveLeafBeside(t, 'Z', 'C', 'left', 'N')).toBe(t)
    expect(moveLeafBeside(t, 'A', 'Z', 'left', 'N')).toBe(t)
  })

  it('never mutates its input', () => {
    const t = threePane()
    const snapshot = JSON.parse(JSON.stringify(t))
    moveLeafBeside(t, 'A', 'C', 'right', 'N')
    expect(t).toEqual(snapshot)
  })
})

describe('splitLeaf position', () => {
  it("'before' puts the new leaf first", () => {
    expect(splitLeaf(leaf('A'), 'A', 'vertical', leaf('B'), 'N', 'before')).toEqual(
      split('N', 'vertical', [leaf('B'), leaf('A')])
    )
  })
})

// --- tidyLayout -------------------------------------------------------------

/** Split by id, or throw: keeps assertions on nested sizes terse. */
function splitById(tree: LayoutNode, id: string): SplitNode {
  if (tree.type === 'split') {
    if (tree.id === id) return tree
    for (const child of tree.children) {
      try {
        return splitById(child, id)
      } catch {
        /* keep looking in the sibling */
      }
    }
  }
  throw new Error(`no split ${id}`)
}

describe('tidyLayout', () => {
  it('returns a lone leaf unchanged', () => {
    const t = leaf('A')
    expect(tidyLayout(t)).toBe(t)
  })

  it('splits two panes evenly', () => {
    const out = tidyLayout(split('S', 'horizontal', [leaf('A'), leaf('B')], [70, 30])) as SplitNode
    expect(out.sizes).toEqual([50, 50])
  })

  it('gives [A | [B | C]] a third each: outer 33.3 %, inner 50 %', () => {
    const t = split('S1', 'horizontal', [leaf('A'), split('S2', 'horizontal', [leaf('B'), leaf('C')], [20, 80])], [50, 50])
    const out = tidyLayout(t)
    expect(splitById(out, 'S1').sizes[0]).toBeCloseTo(100 / 3, 6)
    expect(splitById(out, 'S1').sizes[1]).toBeCloseTo(200 / 3, 6)
    expect(splitById(out, 'S2').sizes).toEqual([50, 50])
  })

  it('weighs the left side too: [[A | B] | C]', () => {
    const t = split('S1', 'horizontal', [split('S2', 'horizontal', [leaf('A'), leaf('B')]), leaf('C')], [10, 90])
    const out = tidyLayout(t)
    expect(splitById(out, 'S1').sizes[0]).toBeCloseTo(200 / 3, 6)
    expect(splitById(out, 'S1').sizes[1]).toBeCloseTo(100 / 3, 6)
  })

  it('walks a long same-direction chain: 25 / 33.3 / 50', () => {
    const t = split('S1', 'vertical', [
      leaf('A'),
      split('S2', 'vertical', [leaf('B'), split('S3', 'vertical', [leaf('C'), leaf('D')])])
    ])
    const out = tidyLayout(t)
    expect(splitById(out, 'S1').sizes[0]).toBeCloseTo(25, 6)
    expect(splitById(out, 'S2').sizes[0]).toBeCloseTo(100 / 3, 6)
    expect(splitById(out, 'S3').sizes).toEqual([50, 50])
  })

  it('counts a perpendicular subtree as a single unit', () => {
    // A beside a column of B over C: two columns, however tall the right one is.
    const t = split('S1', 'horizontal', [leaf('A'), split('S2', 'vertical', [leaf('B'), leaf('C')], [80, 20])], [30, 70])
    const out = tidyLayout(t)
    expect(splitById(out, 'S1').sizes).toEqual([50, 50])
    expect(splitById(out, 'S2').sizes).toEqual([50, 50])
  })

  it('counts a perpendicular subtree as one unit even when it holds a whole row', () => {
    // Rows [A|B|C] over [D|E]: the two rows share the height, each row its own widths.
    const t = split(
      'V',
      'vertical',
      [
        split('R1', 'horizontal', [split('R1a', 'horizontal', [leaf('A'), leaf('B')]), leaf('C')]),
        split('R2', 'horizontal', [leaf('D'), leaf('E')])
      ],
      [75, 25]
    )
    const out = tidyLayout(t)
    expect(splitById(out, 'V').sizes).toEqual([50, 50])
    expect(splitById(out, 'R1').sizes[0]).toBeCloseTo(200 / 3, 6)
    expect(splitById(out, 'R1a').sizes).toEqual([50, 50])
    expect(splitById(out, 'R2').sizes).toEqual([50, 50])
  })

  it('tidies a generated grid to equal rows and columns', () => {
    let n = 0
    const grid = buildGridLayout(6, () => leaf(`L${n++}`), () => `S${n++}`)
    const messy = resizeSplit(grid, (grid as SplitNode).id, [90, 10])
    const out = tidyLayout(messy) as SplitNode
    expect(out.sizes).toEqual([50, 50])
    for (const row of out.children as SplitNode[]) {
      expect(row.sizes[0]).toBeCloseTo(200 / 3, 6)
    }
  })

  it('keeps ids, directions, leaves and their order', () => {
    const t = nestedTree()
    const out = tidyLayout(t)
    expect(collectLeaves(out)).toEqual(collectLeaves(t))
    expect(splitById(out, 'S1').direction).toBe('horizontal')
    expect(splitById(out, 'S2').direction).toBe('vertical')
  })

  it('never mutates its input', () => {
    const t = split('S1', 'horizontal', [leaf('A'), split('S2', 'horizontal', [leaf('B'), leaf('C')], [10, 90])], [5, 95])
    const snapshot = JSON.parse(JSON.stringify(t))
    tidyLayout(t)
    expect(t).toEqual(snapshot)
  })

  it('returns the same reference when the layout is already tidy', () => {
    const t = split('S1', 'horizontal', [leaf('A'), leaf('B')])
    expect(tidyLayout(t)).toBe(t)
    const once = tidyLayout(
      split('S1', 'horizontal', [leaf('A'), split('S2', 'horizontal', [leaf('B'), leaf('C')])], [10, 90])
    )
    expect(tidyLayout(once)).toBe(once)
  })

  it('reuses untouched subtrees', () => {
    const inner = split('S2', 'vertical', [leaf('B'), leaf('C')])
    const out = tidyLayout(split('S1', 'horizontal', [leaf('A'), inner], [20, 80])) as SplitNode
    expect(out.children[1]).toBe(inner)
  })

  describe('with hidden panes (drawer or floating)', () => {
    it('ignores a hidden pane when weighing: [A | [B | C]] without B is two columns', () => {
      const t = split('S1', 'horizontal', [leaf('A'), split('S2', 'horizontal', [leaf('B'), leaf('C')], [30, 70])], [20, 80])
      expect(splitById(tidyLayout(t, ['B']), 'S1').sizes).toEqual([50, 50])
    })

    it('leaves a split with a hidden side alone so a restore finds its old sizes', () => {
      const t = split('S1', 'horizontal', [leaf('A'), split('S2', 'horizontal', [leaf('B'), leaf('C')], [30, 70])], [20, 80])
      expect(splitById(tidyLayout(t, ['B']), 'S2').sizes).toEqual([30, 70])
    })

    it('sees through a collapsed perpendicular split: [A | (X over [B | C])] without X', () => {
      const t = split('S1', 'horizontal', [
        leaf('A'),
        split('S2', 'vertical', [leaf('X'), split('S3', 'horizontal', [leaf('B'), leaf('C')])])
      ])
      const out = tidyLayout(t, ['X'])
      expect(splitById(out, 'S1').sizes[0]).toBeCloseTo(100 / 3, 6)
      expect(splitById(out, 'S3').sizes).toEqual([50, 50])
    })

    it('counts a perpendicular split that keeps both sides as one unit', () => {
      const t = split(
        'S1',
        'horizontal',
        [leaf('A'), split('S2', 'vertical', [leaf('X'), split('S3', 'horizontal', [leaf('B'), leaf('C')])])],
        [10, 90]
      )
      expect(splitById(tidyLayout(t, []), 'S1').sizes).toEqual([50, 50])
    })

    it('returns the same reference when every pane is hidden', () => {
      const t = split('S1', 'horizontal', [leaf('A'), leaf('B')], [30, 70])
      expect(tidyLayout(t, ['A', 'B'])).toBe(t)
    })
  })
})

describe('equalizeSplit', () => {
  it('evens out two panes', () => {
    const out = equalizeSplit(split('S', 'horizontal', [leaf('A'), leaf('B')], [30, 70]), 'S') as SplitNode
    expect(out.sizes).toEqual([50, 50])
  })

  it('sizes by panes along its axis: [A | [B | C]] gives A a third', () => {
    const t = split('S1', 'horizontal', [leaf('A'), split('S2', 'horizontal', [leaf('B'), leaf('C')], [20, 80])], [50, 50])
    const out = equalizeSplit(t, 'S1')
    expect(splitById(out, 'S1').sizes[0]).toBeCloseTo(100 / 3, 6)
    // Only the double-clicked split changes.
    expect(splitById(out, 'S2').sizes).toEqual([20, 80])
  })

  it('counts a perpendicular subtree as one unit', () => {
    const t = split('S1', 'horizontal', [leaf('A'), split('S2', 'vertical', [leaf('B'), leaf('C')], [80, 20])], [30, 70])
    const out = equalizeSplit(t, 'S1')
    expect(splitById(out, 'S1').sizes).toEqual([50, 50])
    expect(splitById(out, 'S2').sizes).toEqual([80, 20])
  })

  it('evens out a nested split by id', () => {
    const out = equalizeSplit(nestedTree(), 'S2')
    expect(splitById(out, 'S2').sizes).toEqual([50, 50])
  })

  it('ignores hidden panes', () => {
    const t = split('S1', 'horizontal', [leaf('A'), split('S2', 'horizontal', [leaf('B'), leaf('C')])], [30, 70])
    expect(splitById(equalizeSplit(t, 'S1', ['C']), 'S1').sizes).toEqual([50, 50])
  })

  it('returns the input for an unknown id or an already even split', () => {
    const t = nestedTree()
    expect(equalizeSplit(t, 'nope')).toBe(t)
    expect(equalizeSplit(t, 'S1')).toBe(t)
  })
})
