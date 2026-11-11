/**
 * Wiring of passive media detection (see media-detect.ts) between the
 * terminal registry's output path, the backend existence check and the
 * gallery. Detection only records paths: nothing is registered for serving
 * (pane output is agent-controlled); the user opening an item does that.
 *
 * Hot-path contract: `noteMediaOutput` only keeps a reference to the raw
 * chunk (no decode, no copy) and arms a
 * per-terminal timer if none is armed (a throttle, not a debounce, so a
 * continuous stream is still scanned every SCAN_INTERVAL_MS). Scanning, IPC
 * and store updates all happen in the timer, never per chunk.
 */
import { detectMediaPaths, MediaOutputBuffer, SeenPaths } from '@/lib/media-detect'
import { mediaKind } from '@/lib/media-gallery'
import { collectLeaves } from '@/lib/layout-tree'
import { useAppStore } from '@/store/app-store'
import { useMediaStore } from '@/store/media-store'
import { useGitStore } from '@/store/git-store'
import { checkDetectedMedia, registerOpenedMedia } from '@/tauri/files'

export const SCAN_INTERVAL_MS = 400

/** Raw bytes held between scans; a flood keeps only its newest chunks. */
export const MAX_PENDING_BYTES = 256 * 1024

interface ScanState {
  chunks: (Uint8Array | string)[]
  bytes: number
  /** Streaming, so a UTF-8 sequence split across chunks decodes intact. */
  decoder: TextDecoder
  buffer: MediaOutputBuffer
  seen: SeenPaths
  timer: ReturnType<typeof setTimeout> | null
}

const states = new Map<string, ScanState>()

/** Pane label for a gallery item, captured now because the pane may close later. */
export function paneSourceLabel(terminalId: string): string {
  for (const w of useAppStore.getState().workspaces) {
    const leaf = collectLeaves(w.layout).find((l) => l.terminalId === terminalId)
    if (leaf) return leaf.name ?? leaf.agentId ?? 'terminal'
  }
  return 'pane'
}

function scan(terminalId: string, state: ScanState): void {
  state.timer = null
  const quiet = state.chunks.length === 0
  for (const chunk of state.chunks) {
    // Small batches arrive as strings (already decoded, whole UTF-8
    // sequences). Flush the decoder first so bytes it still holds from a
    // split sequence land before the string, not after it.
    if (typeof chunk === 'string') state.buffer.append(state.decoder.decode() + chunk)
    else state.buffer.append(state.decoder.decode(chunk, { stream: true }))
  }
  state.chunks = []
  state.bytes = 0
  // Lines are scanned once complete; a partial last line (a TUI redraw or the
  // prompt line) is drained one interval after the pane went quiet. Re-arm
  // only when this round brought new data: a quiet round drains everything,
  // so an idle pane never keeps a timer ticking.
  const text = quiet ? state.buffer.drain() : state.buffer.take()
  if (!quiet && state.buffer.hasPartial) state.timer = setTimeout(() => scan(terminalId, state), SCAN_INTERVAL_MS)
  if (!text) return
  const now = Date.now()
  const offered = detectMediaPaths(text).filter((p) => state.seen.offer(p, now))
  if (offered.length === 0) return
  checkDetectedMedia(terminalId, offered)
    .then((results) => {
      if (states.get(terminalId) !== state) return
      const source = paneSourceLabel(terminalId)
      // Answer time, not scan time: shownAt orders the strip against items
      // added meanwhile (clipboard) and is the URL revision.
      const at = Date.now()
      results.forEach((hit, i) => {
        if (hit === null) return
        // A reprint of an unchanged file (redraw) is not news; an overwritten
        // one is: it moves up with a fresh shownAt, which also cache-busts
        // the thumbnail, overlay and viewer URLs.
        const version = `${hit.mtimeMs}:${hit.size}`
        // Keyed on the printed spelling, while the hook keys on the canonical
        // path: one file may thus be looked up under two keys. Harmless, since
        // the store dedupes by path and version (and ignores older versions).
        if (!state.seen.confirm(offered[i], version, at)) return
        const kind = mediaKind(hit.path)
        if (!kind) return
        const item = { path: hit.path, kind, terminalId, source, shownAt: at, opened: false, version }
        if (useMediaStore.getState().detect(item)) useMediaStore.getState().announce(item, 'agent')
      })
    })
    // The terminal may be gone (unknown terminal); detection is best effort.
    .catch(() => {})
}

function stateOf(terminalId: string): ScanState {
  let state = states.get(terminalId)
  if (!state) {
    state = { chunks: [], bytes: 0, decoder: new TextDecoder(), buffer: new MediaOutputBuffer(), seen: new SeenPaths(), timer: null }
    states.set(terminalId, state)
  }
  return state
}

/** Called for every decoded pty chunk of a live pane (not for replayed history). */
export function noteMediaOutput(terminalId: string, data: Uint8Array | string): void {
  const state = stateOf(terminalId)
  state.chunks.push(data)
  state.bytes += chunkSize(data)
  // Rare (a >256 KB burst within one interval): drop the oldest chunks. Lines
  // cut this way may be missed, and a fresh decoder avoids a stale split.
  while (state.bytes > MAX_PENDING_BYTES && state.chunks.length > 1) {
    state.bytes -= chunkSize(state.chunks.shift()!)
    state.decoder = new TextDecoder()
  }
  if (state.timer === null) {
    const s = state
    s.timer = setTimeout(() => scan(terminalId, s), SCAN_INTERVAL_MS)
  }
}

/** UTF-16 length for strings: a cheap cap estimate, no encode on the hot path. */
function chunkSize(chunk: Uint8Array | string): number {
  return typeof chunk === 'string' ? chunk.length : chunk.byteLength
}

/**
 * A media file an agent (or one of its subagents) opened or wrote, reported
 * by the Claude PostToolUse hook (`media:detected`): canonical, existing,
 * never shown on screen. Shares the pane's `SeenPaths` with the screen scan,
 * so a path named both ways is announced once; like the screen path, a known
 * path whose stamp (mtime and size) changed is news again (overwritten in
 * place), an unchanged one stays silent.
 */
export function noteHookMedia(terminalId: string, path: string, mtimeMs: number, size: number): void {
  const kind = mediaKind(path)
  if (!kind) return
  const state = stateOf(terminalId)
  const at = Date.now()
  const version = `${mtimeMs}:${size}`
  if (!state.seen.confirm(path, version, at)) return
  const item = { path, kind, terminalId, source: paneSourceLabel(terminalId), shownAt: at, opened: false, version }
  if (useMediaStore.getState().detect(item)) useMediaStore.getState().announce(item, 'agent')
}

export function forgetMediaOutput(terminalId: string): void {
  const state = states.get(terminalId)
  if (state?.timer) clearTimeout(state.timer)
  states.delete(terminalId)
  useMediaStore.getState().clearUnseen(terminalId)
}

/**
 * Ctrl+click on a media path in a pane (outside the project): registers the
 * file (the click is the user action) and shows it in the Media panel.
 * Resolves false for non-media paths or a refused registration, so the
 * caller falls back to its usual open-path handling.
 */
export async function showClickedMedia(terminalId: string, path: string): Promise<boolean> {
  const kind = mediaKind(path)
  if (!kind) return false
  let canonical: string
  try {
    canonical = await registerOpenedMedia(path)
  } catch {
    return false
  }
  const item = { path: canonical, kind, terminalId, source: paneSourceLabel(terminalId), shownAt: Date.now(), opened: true }
  useMediaStore.getState().show(item)
  useMediaStore.getState().clearUnseen(terminalId)
  useGitStore.getState().setMode('media')
  return true
}
