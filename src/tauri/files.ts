import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export interface FileContext { id: string; root: string }
export interface FileEntry { name: string; path: string; isDir: boolean; isSymlink: boolean }
export interface TextFile { content: string; version: string; truncated: boolean; binary: boolean; bom: boolean }
export interface Snapshot { id: string; path: string; created: number; bytes: number; isDir: boolean }
export interface TransferResult { completed: { source: string; destination: string }[]; errors: string[] }
export interface RemoveResult { removed: string[]; warnings: string[]; snapshots: Snapshot[] }
/** `rescan`: the watcher may have lost events (native buffer overflow), so everything shown for the context is reloaded. */
export interface FileChange { contextId: string; paths: string[]; gitChanged: boolean; rescan: boolean; error?: string }
export interface FileProgress { contextId: string; operationId: string; path: string; bytes: number }
export interface GitFile { path: string; status: string; added: number; removed: number }

function request<T>(type: string, args: Record<string, unknown> = {}): Promise<T> {
  return invoke('files_request', { request: { type, ...args } })
}
export const openFileContext = (terminalId: string, expectedCwd?: string): Promise<FileContext> => invoke('files_open_context', { terminalId, expectedCwd })
export const listFiles = (contextId: string, path: string): Promise<FileEntry[]> => request('list', { contextId, path })
export const readFile = (contextId: string, path: string): Promise<TextFile> => request('read', { contextId, path })
export const statMedia = (contextId: string, path: string): Promise<{ mtimeMs: number; size: number }> => request('mediaStat', { contextId, path })
export const openMediaExternal = (contextId: string, path: string): Promise<void> => request('openMedia', { contextId, path })
export const writeFile = (contextId: string, path: string, content: string, expectedVersion: string, bom: boolean): Promise<{ version: string }> => request('write', { contextId, path, content, expectedVersion, bom })
export const createFile = (contextId: string, directory: string, name: string, isDir: boolean): Promise<string> => request('create', { contextId, directory, name, isDir })
export const renameFile = (contextId: string, path: string, name: string): Promise<string> => request('rename', { contextId, path, name })
export const transferFiles = (contextId: string, sourceContextId: string, paths: string[], directory: string, cut: boolean, operationId: string): Promise<TransferResult> => request('transfer', { contextId, sourceContextId, paths, directory, cut, operationId })
export const removeFiles = (contextId: string, paths: string[]): Promise<RemoveResult> => request('remove', { contextId, paths })
export const listHistory = (contextId: string): Promise<Snapshot[]> => request('history', { contextId })
export const restoreSnapshot = (contextId: string, id: string): Promise<string> => request('restore', { contextId, id })
export const getFileGitStatus = (contextId: string): Promise<GitFile[]> => request('git', { contextId })
export const copyNativeFiles = (contextId: string, paths: string[]): Promise<void> => request('clipboardWrite', { contextId, paths })
export const readNativeFiles = (): Promise<string[]> => request('clipboardRead')
export const importNativeFiles = (contextId: string, directory: string, operationId: string, expectedPaths: string[]): Promise<TransferResult> => request('clipboardImport', { contextId, directory, operationId, expectedPaths })
export const revealFile = (contextId: string, path: string): Promise<void> => request('reveal', { contextId, path })
export const watchFiles = (contextId: string, paths: string[] = []): Promise<void> => invoke('files_watch', { contextId, paths })
export const unwatchFiles = (contextId: string): Promise<void> => invoke('files_unwatch', { contextId })
export const onFileChange = (cb: (change: FileChange) => void): Promise<() => void> => listen<FileChange>('files:changed', (e) => cb(e.payload))
export const onFileProgress = (cb: (progress: FileProgress) => void): Promise<() => void> => listen<FileProgress>('files:progress', (e) => cb(e.payload))
export function mediaUrl(contextId: string, path: string, revision: string | number = 0): string {
  // convertFileSrc encodes the entire path, so use it for the scheme/host only.
  return `${convertFileSrc(contextId, 'swarmterm-media')}?path=${encodeURIComponent(path)}&revision=${revision}`
}
/** Context id of the backend's unrooted media route (`UNROOTED_ID` in `files/media.rs`). */
export const UNROOTED_MEDIA = 'unrooted'
/** Media outside every file context; only files the user opened (or copied) are served. */
export const unrootedMediaUrl = (path: string, revision: string | number = 0): string => mediaUrl(UNROOTED_MEDIA, path, revision)
export interface ClipboardMediaEvent { path: string }
/** `media:clipboard`: a clipboard image saved as PNG (or a copied media file), canonical and already registered. */
export const onClipboardMedia = (cb: (e: ClipboardMediaEvent) => void): Promise<() => void> => listen<ClipboardMediaEvent>('media:clipboard', (e) => cb(e.payload))
/** Starts/stops the backend clipboard watcher (opt-in setting). */
export const setClipboardMediaEnabled = (enabled: boolean): Promise<void> => invoke('clipboard_media_set_enabled', { enabled })
/** Passive detection: which candidates are existing media files (relative = terminal cwd). Registers nothing. One entry per input: its canonical path, or null. */
export const checkDetectedMedia = (terminalId: string, paths: string[]): Promise<(string | null)[]> => invoke('media_check_detected', { terminalId, paths })
/** User action only (open click, Ctrl+click): allow-lists one absolute media file for the unrooted route; resolves to its canonical path. */
export const registerOpenedMedia = (path: string): Promise<string> => invoke('media_open', { path })
/** Annotate: bytes of an image the user opened (the served <img> would taint the flatten canvas). */
export const readOpenedImage = (path: string): Promise<ArrayBuffer> => invoke('media_read_opened_image', { path })
/** Annotate → save: writes the flattened PNG as a new temp file (raw IPC body), allow-listed like a clipboard image; resolves to its canonical path. */
export const saveMarkedImage = (png: Uint8Array): Promise<string> => invoke('media_save_marked', png)
/** Hands a Markdown file to the external MarkText app. `executable` empty = auto-detect. */
export const openInMarkText = (contextId: string, path: string, executable: string): Promise<void> => request('openMarkText', { contextId, path, executable })
/** Unsaved HTML buffer the preview frame renders instead of disk; `null` drops it. */
export const setPreviewDraft = (contextId: string, path: string, content: string | null): Promise<void> => request('previewDraft', { contextId, path, content })
/** Opens an HTML/SVG file with the OS default handler (normally the browser). */
export const openPreviewExternal = (contextId: string, path: string): Promise<void> => request('openPreviewExternal', { contextId, path })
/** Base for path-addressed preview URLs, see `previewFrameUrl`. */
export const previewBase = (contextId: string): string => convertFileSrc(contextId, 'swarmterm-media')
/** Resolved MarkText executable, or null when none is installed where we look. */
export const locateMarkText = (executable: string): Promise<string | null> => request('locateMarkText', { executable })
