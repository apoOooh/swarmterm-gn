import { message, open } from '@tauri-apps/plugin-dialog'
import { homeDir } from '@tauri-apps/api/path'

/** Native OS message box. Used for update-check verdicts so they land centered
 * and OS-styled instead of floating over the terminal. Needs the
 * `dialog:allow-message` capability — without it the promise rejects silently. */
export async function showMessage(
  text: string,
  opts?: { title?: string; kind?: 'info' | 'error' }
): Promise<void> {
  await message(text, { title: opts?.title, kind: opts?.kind })
}

/** Open the native Windows folder dialog, starting in `startDir` (home when
 * absent). Resolves to the chosen path, or null if cancelled. Callers use the
 * in-app picker (`pickFolder` in store/folder-picker-store); this is its
 * "Windows dialog" fallback. */
export async function pickDirectory(startDir?: string): Promise<string | null> {
  const defaultPath = startDir !== undefined && startDir !== '' ? startDir : await homeDir()
  const picked = await open({ directory: true, defaultPath })
  return typeof picked === 'string' ? picked : null
}

export const getHomeDir = (): Promise<string> => homeDir()
