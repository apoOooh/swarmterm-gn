/** Run at most one keyed task per animation frame, yielding between tasks. */
export function createFrameTaskQueue(
  requestFrame: (callback: () => void) => number,
  cancelFrame: (handle: number) => void
): { enqueue: (key: string, task: () => void) => void; cancel: (key: string) => void } {
  const tasks = new Map<string, () => void>()
  let frame: number | undefined
  const schedule = (): void => {
    if (frame !== undefined || tasks.size === 0) return
    frame = requestFrame(() => {
      frame = undefined
      const next = tasks.entries().next().value
      if (!next) return
      tasks.delete(next[0])
      try { next[1]() } finally { schedule() }
    })
  }
  return {
    enqueue: (key, task) => { tasks.set(key, task); schedule() },
    cancel: key => {
      tasks.delete(key)
      if (tasks.size === 0 && frame !== undefined) {
        cancelFrame(frame)
        frame = undefined
      }
    }
  }
}
