import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/**
 * SWA-88 events from Rust's `POST /resubmit` (data-shield's guard blocked a
 * Claude Code prompt). Mirrors `ResubmitEvent` in `src-tauri/src/mcp/server.rs`
 * (serde camelCase). `prompt:resubmit` goes to the main webview only and is
 * the one event carrying prompt text — masked; never log or forward it.
 */
export interface PromptResubmitEvent {
  terminalId: string
  spawnId: string
  text: string
  send: boolean
  /** Fingerprint of the blocked plaintext (length + SHA-256), to compare
   *  with the draft Claude restored. Never log, store or forward it. */
  asked: { len: number; sha256: string }
}

/** The blocked prompt had already opened a turn: it never ran. No text. */
export interface PromptBlockedEvent {
  terminalId: string
  atMs: number
}

export const onPromptResubmit = (handler: (e: PromptResubmitEvent) => void): Promise<UnlistenFn> =>
  listen<PromptResubmitEvent>('prompt:resubmit', (event) => handler(event.payload))

export const onPromptBlocked = (handler: (e: PromptBlockedEvent) => void): Promise<UnlistenFn> =>
  listen<PromptBlockedEvent>('agent:prompt-blocked', (event) => handler(event.payload))
