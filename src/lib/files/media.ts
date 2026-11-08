// Adapted from parsingk/Astera, debc3098; Apache-2.0. See third-party-licenses/Astera/.
export interface MediaStat {
  mtimeMs: number
  size: number
}

/** The URL version for a stat: mtime and size together, so a regenerated file that keeps one of the
 *  two (a coarse clock, an encoder that writes the same length) still gets a new URL. */
export function mediaVersion(st: MediaStat): string {
  return `${Math.trunc(st.mtimeMs)}-${st.size}`
}

const sameStat = (a: MediaStat | null, b: MediaStat | null): boolean =>
  a === null || b === null ? a === b : a.mtimeMs === b.mtimeMs && a.size === b.size

/** The viewer's reload bookkeeping. `loaded`: what is on screen (undefined before the first answer,
 *  null when the file was found missing). `pending`: a new stat seen once and waiting for a second
 *  look (undefined when nothing is pending). `lastSeq`: the newest check whose answer was applied. */
export interface ReloadState {
  loaded: MediaStat | null | undefined
  pending: MediaStat | null | undefined
  lastSeq: number
}

/** One check's answer, applied. A generator rewriting a clip in place (ffmpeg -y truncates, then
 *  writes for seconds) shows a different, half-written stat on every check until it is done, so a
 *  change — a new stat, or the file missing — is acted on only when two checks in a row agree on it:
 *  'reload' (load the new bytes) or 'gone' (say it cannot be opened). Until then the old picture
 *  stays. The first answer is acted on at once: nothing is on screen yet. `seq` numbers the checks in
 *  the order they were started; an answer older than (or the same as) the newest applied one is
 *  dropped, because a poll, a focus and a second click run concurrently and can answer out of order. */
export function reloadStep(
  s: ReloadState,
  seq: number,
  next: MediaStat | null
): { state: ReloadState; action: 'none' | 'reload' | 'gone' } {
  if (seq <= s.lastSeq) return { state: s, action: 'none' }
  const act = (): { state: ReloadState; action: 'reload' | 'gone' } => ({
    state: { loaded: next, pending: undefined, lastSeq: seq },
    action: next === null ? 'gone' : 'reload'
  })
  if (s.loaded === undefined) return act()
  if (sameStat(s.loaded, next)) return { state: { ...s, pending: undefined, lastSeq: seq }, action: 'none' }
  if (s.pending !== undefined && sameStat(s.pending, next)) return act()
  return { state: { ...s, pending: next, lastSeq: seq }, action: 'none' }
}

/** Where to resume after a reload: the old position when the new file still runs past it, else the
 *  start. A duration of Infinity (no known end yet) covers any position; NaN (not known at all)
 *  covers none. */
export function resumeAt(prevTime: number, duration: number): number {
  if (!Number.isFinite(prevTime) || prevTime < 0 || Number.isNaN(duration)) return 0
  return prevTime < duration ? prevTime : 0
}
