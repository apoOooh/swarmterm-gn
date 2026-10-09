import type { FileEntry } from '@/tauri/files'
export interface Directory { entries?: FileEntry[]; loading?: boolean; error?: string }
export interface TreeRow { entry: FileEntry; depth: number; parent: string; expanded: boolean }
export function treeRows(root: string, dirs: Record<string, Directory>, expanded: ReadonlySet<string>, filter = ''): TreeRow[] {
  const out: TreeRow[] = []
  function walk(path: string, depth: number): void {
    for (const entry of dirs[path]?.entries ?? []) {
      if (filter && !entry.isDir && !entry.name.toLowerCase().includes(filter.toLowerCase())) continue
      const open = expanded.has(entry.path)
      out.push({ entry, depth, parent: path, expanded: open })
      if (entry.isDir && open) walk(entry.path, depth + 1)
    }
  }
  walk(root, 0)
  return out
}
export function virtualRange(count: number, scrollTop: number, height: number, rowHeight: number): { start: number; end: number } {
  return { start: Math.max(0, Math.floor(scrollTop / rowHeight) - 8), end: Math.min(count, Math.ceil((scrollTop + height) / rowHeight) + 8) }
}
export function gitBadge(path: string, statuses: Record<string, string>): string | undefined {
  if (statuses[path]) return statuses[path]
  const prefix = path.replace(/\\/g, '/').replace(/\/$/, '') + '/'
  const nested = Object.entries(statuses).filter(([p]) => p.replace(/\\/g, '/').startsWith(prefix)).map(([, s]) => s)
  return nested.find((s) => s === 'U') ?? nested.find((s) => s !== '?') ?? nested[0]
}
export function fileKind(path: string): 'text' | 'image' | 'video' {
  if (/\.(png|jpe?g|gif|webp)$/i.test(path)) return 'image'
  if (/\.(mp4|m4v|mov|webm)$/i.test(path)) return 'video'
  return 'text'
}
