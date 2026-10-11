import { describe, expect, it } from 'vitest'
import { preferLayoutTargets } from './layout-collision'
import { dockDropId, snapDropId } from './war-room-drop'

const c = (id: string) => ({ id })

describe('preferLayoutTargets', () => {
  it('passes plain collisions through untouched', () => {
    const list = [c('leaf1'), c('war-room-dropzone')]
    expect(preferLayoutTargets(list)).toBe(list)
  })

  it('a dock tile beats the pane it sits on, whatever the order', () => {
    expect(preferLayoutTargets([c('leaf2'), c(dockDropId('leaf2', 'left'))])).toEqual([
      c(dockDropId('leaf2', 'left'))
    ])
  })

  it('a snap slot beats the panes under the snap bar', () => {
    expect(preferLayoutTargets([c('leaf1'), c(snapDropId('rows', 1)), c('leaf3')])).toEqual([
      c(snapDropId('rows', 1))
    ])
  })

  it('handles an empty list', () => {
    expect(preferLayoutTargets([])).toEqual([])
  })
})
