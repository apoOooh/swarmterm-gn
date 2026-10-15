import { getVersion } from '@tauri-apps/api/app'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

/** The app version baked into tauri.conf.json (e.g. "0.1.0"). */
export const getAppVersion = (): Promise<string> => getVersion()
export const confirmQuit = (): Promise<void> => invoke('confirm_quit')
export const onQuitRequested = (cb: () => void): Promise<() => void> => listen('app:quit-requested', cb)

/** The MCP server stopped unexpectedly; payload is the reason string. */
export const onMcpServerExited = (cb: (reason: string) => void): Promise<() => void> =>
  listen<string>('mcp:server-exited', (e) => cb(e.payload))
/** The voice pipe failed; `voice:pipe-recovered` follows once it is back. */
export const onVoicePipeError = (cb: (payload: { message: string }) => void): Promise<() => void> =>
  listen<{ message: string }>('voice:pipe-error', (e) => cb(e.payload))
export const onVoicePipeRecovered = (cb: () => void): Promise<() => void> => listen('voice:pipe-recovered', cb)
