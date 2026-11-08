import { create } from 'zustand'
import type { DragEffect } from '@/lib/pointer-drag'

export interface ExplorerDrag {
  paths: string[]
  x: number
  y: number
  effect: DragEffect
  /** Folder row currently highlighted as the drop target, if any. */
  overDir: string | null
  /** Media drags: a thumbnail URL, or which icon stands in for it. */
  ghost?: DragGhost
}

export type DragGhost = { url: string } | { icon: 'film' | 'image' }

/** The explorer drag in flight (pointer-driven, see lib/pointer-drag.ts); null when idle. */
export const useExplorerDragStore = create<{ drag: ExplorerDrag | null }>(() => ({ drag: null }))
