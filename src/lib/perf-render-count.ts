/**
 * Dev-only render counter for the perf harness (tests/perf/flood.perf.ts,
 * scenario d). The harness sets `window.__perfRenderCounts = {}` before a run
 * and reads it afterwards; without that object (every normal session) and in
 * release builds this is a no-op, so components can call it on every render.
 */
export function countRender(name: string): void {
  if (import.meta.env.DEV !== true || typeof window === 'undefined') return
  const counts = (window as unknown as { __perfRenderCounts?: Record<string, number> }).__perfRenderCounts
  if (counts) counts[name] = (counts[name] ?? 0) + 1
}
