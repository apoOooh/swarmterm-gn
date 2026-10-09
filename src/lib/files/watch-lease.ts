import { unwatchFiles, watchFiles } from '@/tauri/files'
/** Pair release with async acquisition even if a pane closes before native setup completes. */
export class FileWatchLease {
  private released = false
  private acquired = false
  readonly ready: Promise<void>
  constructor(readonly contextId: string, paths: string[] = []) {
    this.ready = watchFiles(contextId, paths).then(() => {
      this.acquired = true
      if (this.released) return unwatchFiles(this.contextId)
    })
  }
  release(): void {
    if (this.released) return
    this.released = true
    if (this.acquired) void unwatchFiles(this.contextId).catch(() => {})
  }
}
