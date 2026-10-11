import { describe, expect, it, vi } from 'vitest'
import { createFrameTaskQueue } from './frame-task-queue'

function fixture() {
  let next = 0
  const frames = new Map<number, () => void>()
  const cancel = vi.fn((handle: number) => { frames.delete(handle) })
  const queue = createFrameTaskQueue(callback => { frames.set(++next, callback); return next }, cancel)
  const tick = (): void => {
    const first = frames.entries().next().value
    if (!first) throw new Error('No scheduled frame')
    frames.delete(first[0]); first[1]()
  }
  return { queue, frames, cancel, tick }
}

describe('frame task queue', () => {
  it('yields between fresh terminal initializers and stops after the final frame', () => {
    const { queue, frames, tick } = fixture()
    const run = vi.fn()
    for (const id of ['one', 'two', 'three']) queue.enqueue(id, () => run(id))
    expect(run).not.toHaveBeenCalled()
    expect(frames.size).toBe(1)
    tick(); expect(run.mock.calls).toEqual([['one']]); expect(frames.size).toBe(1)
    tick(); expect(run.mock.calls).toEqual([['one'], ['two']]); expect(frames.size).toBe(1)
    tick(); expect(run.mock.calls).toEqual([['one'], ['two'], ['three']]); expect(frames.size).toBe(0)
  })

  it('replaces an obsolete attach callback while preserving other queued panes', () => {
    const { queue, tick } = fixture()
    const obsolete = vi.fn(), latest = vi.fn(), sibling = vi.fn()
    queue.enqueue('pane', obsolete); queue.enqueue('sibling', sibling); queue.enqueue('pane', latest)
    tick(); expect(latest).toHaveBeenCalledOnce(); expect(obsolete).not.toHaveBeenCalled()
    tick(); expect(sibling).toHaveBeenCalledOnce()
  })

  it('cancels detached panes and cancels the browser frame when no tasks remain', () => {
    const { queue, frames, cancel, tick } = fixture()
    const detached = vi.fn(), survivor = vi.fn()
    queue.enqueue('detached', detached); queue.enqueue('survivor', survivor)
    queue.cancel('detached'); tick()
    expect(detached).not.toHaveBeenCalled(); expect(survivor).toHaveBeenCalledOnce()
    queue.enqueue('disposed', detached); queue.cancel('disposed')
    expect(cancel).toHaveBeenCalledOnce(); expect(frames.size).toBe(0)
  })

  it('starts later attachments after cancellation and schedules tasks added during a frame once', () => {
    const { queue, frames, tick } = fixture()
    const obsolete = vi.fn(), following = vi.fn()
    queue.enqueue('pane', obsolete); queue.cancel('pane')
    queue.enqueue('pane', () => queue.enqueue('next', following))
    tick(); expect(following).not.toHaveBeenCalled(); expect(frames.size).toBe(1)
    tick(); expect(following).toHaveBeenCalledOnce(); expect(frames.size).toBe(0)
    expect(obsolete).not.toHaveBeenCalled()
  })
})
