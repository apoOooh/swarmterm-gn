/**
 * Wiring of passive media detection (see media-detect.ts) between the
 * terminal registry's output path, the backend allow-list and the gallery.
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
import { registerDetectedMedia } from '@/tauri/files'

export const SCAN_INTERVAL_MS = 400

/** Raw bytes held between scans; a flood keeps only its newest chunks. */
export const MAX_PENDING_BYTES = 256 * 1024

interface ScanState {
  chunks: Uint8Array[]
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
  for (const chunk of state.chunks) state.buffer.append(state.decoder.decode(chunk, { stream: true }))
  state.chunks = []
  state.bytes = 0
  // Lines are scanned once complete; a partial last line (a TUI redraw or the
  // prompt line) is drained one interval after the pane went quiet.
  const text = quiet ? state.buffer.drain() : state.buffer.take()
  if (state.buffer.hasPartial) state.timer = setTimeout(() => scan(terminalId, state), SCAN_INTERVAL_MS)
  if (!text) return
  const now = Date.now()
  const offered = detectMediaPaths(text).filter((p) => state.seen.offer(p, now))
  if (offered.length === 0) return
  registerDetectedMedia(terminalId, offered)
    .then((results) => {
      if (states.get(terminalId) !== state) return
      const source = paneSourceLabel(terminalId)
      results.forEach((path, i) => {
        if (path === null) return
        state.seen.confirm(offered[i])
        const kind = mediaKind(path)
        if (kind) useMediaStore.getState().detect({ path, kind, terminalId, source, shownAt: now })
      })
    })
    // The terminal may be gone (unknown terminal); detection is best effort.
    .catch(() => {})
}

/** Called for every decoded pty chunk of a live pane (not for replayed history). */
export function noteMediaOutput(terminalId: string, data: Uint8Array): void {
  let state = states.get(terminalId)
  if (!state) {
    state = { chunks: [], bytes: 0, decoder: new TextDecoder(), buffer: new MediaOutputBuffer(), seen: new SeenPaths(), timer: null }
    states.set(terminalId, state)
  }
  state.chunks.push(data)
  state.bytes += data.byteLength
  // Rare (a >256 KB burst within one interval): drop the oldest chunks. Lines
  // cut this way may be missed, and a fresh decoder avoids a stale split.
  while (state.bytes > MAX_PENDING_BYTES && state.chunks.length > 1) {
    state.bytes -= state.chunks.shift()!.byteLength
    state.decoder = new TextDecoder()
  }
  if (state.timer === null) {
    const s = state
    s.timer = setTimeout(() => scan(terminalId, s), SCAN_INTERVAL_MS)
  }
}

export function forgetMediaOutput(terminalId: string): void {
  const state = states.get(terminalId)
  if (state?.timer) clearTimeout(state.timer)
  states.delete(terminalId)
  useMediaStore.getState().clearUnseen(terminalId)
}
