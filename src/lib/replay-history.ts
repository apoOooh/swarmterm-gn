/**
 * Writes a reattached pane's history into xterm (perf phase 2 flow gate).
 *
 * Only `data` is acked: the host's gate counted exactly the replayed bytes,
 * so `onParsed` (which acks `data.byteLength`) rides on the history write.
 * The truncation note is renderer-local text the host never counted; it is
 * written without a callback so its bytes are never acked, whatever its
 * wording. Acking it would open the gate early by the note's length.
 */
export const REPLAY_TRUNCATED_NOTE = '\x1b[2m[older output is not available]\x1b[0m\r\n'

export interface ReplayWriter {
  write(data: string | Uint8Array, callback?: () => void): void
}

export function writeReplayHistory(
  term: ReplayWriter,
  data: Uint8Array,
  truncated: boolean,
  onParsed: () => void
): void {
  if (truncated) term.write(REPLAY_TRUNCATED_NOTE)
  term.write(data, onParsed)
}
