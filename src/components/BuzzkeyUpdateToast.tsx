import type { ReactElement } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useBuzzkeyUpdateStore } from '@/store/buzzkey-update-store'

/**
 * "buzzkey <x> is available" (bottom right). Covers the native preview
 * webviews while shown (`data-covers-webview`): they paint over all DOM, and
 * the toast appears at most once per buzzkey version. Rules in
 * `lib/buzzkey-update.ts`.
 */
export function BuzzkeyUpdateToast(): ReactElement | null {
  const toast = useBuzzkeyUpdateStore((s) => s.toast)
  const autoUpdate = useBuzzkeyUpdateStore((s) => s.prefs.autoUpdate)
  if (!toast) return null
  const { decline, updateNow, setAutoUpdate } = useBuzzkeyUpdateStore.getState()
  return (
    <div
      role="status"
      aria-label="buzzkey update"
      data-testid="buzzkey-update-toast"
      data-covers-webview
      data-focus-return
      className="fixed bottom-4 right-4 z-50 w-80 rounded-md border border-border bg-popover p-3 text-sm text-popover-foreground shadow-lg"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="font-medium">buzzkey {toast.version} is available</div>
        <button
          type="button"
          aria-label="Dismiss until the next version"
          className="text-muted-foreground hover:text-foreground disabled:opacity-50"
          disabled={toast.installing}
          onClick={decline}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {toast.majorJump
          ? 'A major new version â€” it is never installed automatically.'
          : 'Signed release; buzzkey restarts after the update.'}
      </div>
      {toast.error && (
        <div className="mt-2 text-xs text-destructive" data-testid="buzzkey-update-error">
          {toast.error}
        </div>
      )}
      <label className="mt-2 flex items-center gap-2 text-xs">
        <input type="checkbox" checked={autoUpdate} onChange={(e) => setAutoUpdate(e.target.checked)} />
        Update automatically
      </label>
      <div className="mt-3 flex justify-end gap-2">
        <Button size="sm" variant="outline" disabled={toast.installing} onClick={decline}>
          Later
        </Button>
        <Button size="sm" disabled={toast.installing} onClick={() => void updateNow()}>
          {toast.installing ? 'Updatingâ€¦' : 'Update now'}
        </Button>
      </div>
    </div>
  )
}
