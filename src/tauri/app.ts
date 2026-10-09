import { getVersion } from '@tauri-apps/api/app'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

/** The app version baked into tauri.conf.json (e.g. "0.1.0"). */
export const getAppVersion = (): Promise<string> => getVersion()
export const confirmQuit = (): Promise<void> => invoke('confirm_quit')
export const onQuitRequested = (cb: () => void): Promise<() => void> => listen('app:quit-requested', cb)
