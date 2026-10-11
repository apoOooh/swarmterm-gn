import { invoke } from '@tauri-apps/api/core'
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager'

/** Write `text` to the system clipboard. */
export const writeClipboard = (text: string): Promise<void> => writeText(text)

/** Read the system clipboard as plain text (empty string if unavailable). */
export async function readClipboard(): Promise<string> {
  // The plugin rejects (rather than returning '') when the clipboard holds no
  // text — e.g. only a screenshot — and the image-paste fallback needs to see
  // that as "no text", not as a failure.
  try {
    return (await readText()) ?? ''
  } catch {
    return ''
  }
}

/** Save a clipboard image to a temp PNG; resolves to its path, or `null` when there is no image. */
export const saveClipboardImage = (): Promise<string | null> => invoke<string | null>('save_clipboard_image')
