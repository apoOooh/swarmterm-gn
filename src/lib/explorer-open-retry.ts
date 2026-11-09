/**
 * How long the explorer keeps asking for a pane's folder while the pane has
 * not started yet (SWA-83 V7). A pane whose terminal host is slow falls back
 * to the in-process backend after 15 s; a fixed 5 s of retries gave up
 * before that and left "not ready" on screen for good.
 */
export const OPEN_RETRY_WINDOW_MS = 30_000

/** Milliseconds until the next attempt, or `null` to show the error. */
export function openRetryDelay(error: unknown, elapsedMs: number): number | null {
  if (!String(error).toLowerCase().includes('not ready')) return null
  if (elapsedMs >= OPEN_RETRY_WINDOW_MS) return null
  return elapsedMs < 5_000 ? 250 : 1_000
}
