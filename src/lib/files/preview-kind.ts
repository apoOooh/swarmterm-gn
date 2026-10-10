import { isMarkdownPath } from '@/lib/markdown-pref'

/**
 * Text files that get an Editor/Split/Preview toolbar. All three follow the one
 * "Open Markdown, SVG and HTML as" default so a project of docs, icons and pages opens alike.
 */
export type PreviewKind = 'markdown' | 'svg' | 'html'

export function previewKind(path: string): PreviewKind | null {
  if (isMarkdownPath(path)) return 'markdown'
  if (/\.svg$/i.test(path)) return 'svg'
  if (/\.html?$/i.test(path)) return 'html'
  return null
}

/**
 * Path-addressed preview URL (`/<id>/f/<abs path>`): the frame's own relative
 * URLs then resolve against the file's folder, which `?path=` cannot do. Each
 * segment is encoded on its own so `/` keeps meaning "directory".
 */
export function previewFrameUrl(base: string, path: string, revision: number): string {
  const segments = path.replace(/\\/g, '/').replace(/^\/+/, '').split('/').map(encodeURIComponent)
  // A drive letter's colon must survive so the backend sees `C:/…`.
  return `${base.replace(/\/+$/, '')}/f/${segments.join('/').replace(/^([A-Za-z])%3A/, '$1:')}?revision=${revision}`
}

export interface View { scale: number; x: number; y: number }
export const MIN_SCALE = 0.05
export const MAX_SCALE = 64

/** Wheel zoom that keeps the point under the cursor fixed (VS Code image preview feel). */
export function zoomAt(view: View, factor: number, px: number, py: number): View {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor))
  const k = scale / view.scale
  return { scale, x: px - (px - view.x) * k, y: py - (py - view.y) * k }
}

/** Centre `w×h` content in a `cw×ch` viewport, shrinking but never enlarging it. */
export function fitView(w: number, h: number, cw: number, ch: number): View {
  const scale = w > 0 && h > 0 ? Math.min(1, cw / w, ch / h) : 1
  return { scale, x: (cw - w * scale) / 2, y: (ch - h * scale) / 2 }
}
