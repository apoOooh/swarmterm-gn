import { describe, expect, it } from 'vitest'
import { endExplorerDrag, startExplorerDrag, takeExplorerDrag } from './explorer-drag'
describe('explorer drag hand-off', () => {
  it('hands the paths out exactly once', () => {
    startExplorerDrag(['/p/a.svg'])
    expect(takeExplorerDrag()).toEqual(['/p/a.svg'])
    expect(takeExplorerDrag()).toBeNull()
  })
  it('lets a late native drop claim the drag, but not a stale one', () => {
    startExplorerDrag(['/p/a.svg']); endExplorerDrag(1000)
    expect(takeExplorerDrag(2000)).toEqual(['/p/a.svg'])
    startExplorerDrag(['/p/a.svg']); endExplorerDrag(1000)
    expect(takeExplorerDrag(5000)).toBeNull()
    startExplorerDrag([])
    expect(takeExplorerDrag()).toBeNull()
  })
})
