import { getTerminalHostStatus, type TerminalHostStatus } from '@/tauri/terminal-host'

/** How often an open panel re-reads the host status: there is no status
 * event, and the host can connect, exit or be replaced at any time. */
const HOST_STATUS_REFRESH_MS = 3000

// One host status poll shared by every component that shows it: the next
// request is scheduled only after the previous one answered, so slow answers
// never pile up, and it runs only while some component is subscribed.
const hostStatusStore = {
  status: null as TerminalHostStatus | null,
  // Bumped by every local set: a poll that started before it answers with
  // older state and is dropped.
  generation: 0,
  listeners: new Set<() => void>(),
  timer: null as ReturnType<typeof setTimeout> | null,
  // Bumped when polling stops, so an answer in flight does not reschedule.
  run: 0,
}

function emitHostStatus(s: TerminalHostStatus | null): void {
  hostStatusStore.status = s
  for (const l of hostStatusStore.listeners) l()
}

function pollHostStatus(run: number): void {
  const started = hostStatusStore.generation
  getTerminalHostStatus()
    .then((s) => {
      if (run === hostStatusStore.run && started === hostStatusStore.generation) emitHostStatus(s)
    })
    .catch((err) => console.error('[TerminalPanel] terminal host status failed', err))
    .finally(() => {
      if (run !== hostStatusStore.run) return
      hostStatusStore.timer = setTimeout(() => pollHostStatus(run), HOST_STATUS_REFRESH_MS)
    })
}

export function subscribeHostStatus(listener: () => void): () => void {
  hostStatusStore.listeners.add(listener)
  if (hostStatusStore.listeners.size === 1) pollHostStatus(hostStatusStore.run)
  return () => {
    hostStatusStore.listeners.delete(listener)
    if (hostStatusStore.listeners.size === 0) {
      hostStatusStore.run += 1
      // A later mount starts from "unknown", not from a stale answer.
      hostStatusStore.status = null
      if (hostStatusStore.timer !== null) clearTimeout(hostStatusStore.timer)
      hostStatusStore.timer = null
    }
  }
}

/** Local set (a toggle's answer). With nobody subscribed it is dropped: a
 * later mount starts from "unknown" and polls, never from a stale answer. */
export function setHostStatus(s: TerminalHostStatus | null): void {
  if (hostStatusStore.listeners.size === 0) return
  hostStatusStore.generation += 1
  emitHostStatus(s)
}

export function getHostStatusSnapshot(): TerminalHostStatus | null {
  return hostStatusStore.status
}
