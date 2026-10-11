import { invoke } from '@tauri-apps/api/core'

/**
 * Typed bridge for the in-app folder picker. One level of subfolders per call
 * — the webview has no filesystem. `path: ''` lists the drive roots; `parent`
 * is '' at a drive root (climb to the drive list) and null at the top.
 * Rejects with a readable message for missing or unreadable folders.
 */
export interface FolderListing {
  path: string
  parent: string | null
  folders: string[]
}

export function listFolders(path: string): Promise<FolderListing> {
  return invoke<FolderListing>('list_folders', { path })
}
