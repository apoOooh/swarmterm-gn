import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { ArrowUp, Folder, FolderOpen, Search, Star } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { filterFolders, pickerOwnsEnter, quickAccess, samePath, selectableFolder, splitTypedPath, typedNavigation } from '@/lib/folder-picker'
import { folderName } from '@/lib/recent-folders'
import { useFolderPickerStore } from '@/store/folder-picker-store'
import { useRecentsStore } from '@/store/recents-store'
import { useSavedWorkspacesStore } from '@/store/saved-workspaces-store'
import { getHomeDir, pickDirectory } from '@/tauri/dialog'
import { listFolders, type FolderListing } from '@/tauri/folders'

/**
 * App-wide in-app folder picker, replacing the native Windows dialog. Mounted
 * once in App; opened through `pickFolder()`. Hand-rolled overlay like
 * RecentsDialog: role="dialog" is what overlay-watch (hides native preview
 * webviews) and terminal-focus (stops stealing focus back) key on. It owns the
 * keyboard, so it deliberately carries no data-focus-return.
 */
export function FolderPicker(): ReactElement | null {
  const request = useFolderPickerStore((s) => s.request)
  const favorites = useFolderPickerStore((s) => s.favorites)
  const settle = useFolderPickerStore((s) => s.settle)
  const toggleFav = useFolderPickerStore((s) => s.toggleFavorite)
  const recents = useRecentsStore((s) => s.recents)
  const saved = useSavedWorkspacesStore((s) => s.entries)

  const [listing, setListing] = useState<FolderListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  // Drops stale responses when the user types/navigates faster than Rust lists.
  // Also bumped when a picker closes, so nothing in flight from an old opening
  // can land in (or redirect) the next one.
  const seq = useRef(0)
  // True while the latest navigation has not answered: the old listing stays
  // visible, but Select must not hand it back as if it were the new folder.
  const [pending, setPending] = useState(false)
  const typeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelTyping = (): void => {
    if (typeTimer.current !== null) clearTimeout(typeTimer.current)
    typeTimer.current = null
  }

  const navigate = useCallback((path: string): void => {
    const mine = ++seq.current
    setPending(true)
    setError(null)
    listFolders(path)
      .then((l) => {
        if (mine !== seq.current) return
        setListing(l)
        setPending(false)
        setActive(0)
      })
      .catch((e: unknown) => {
        if (mine !== seq.current) return
        setError(String(e))
        setPending(false)
      })
  }, [])

  useEffect(() => {
    if (!request) return
    setInput('')
    setListing(null)
    setError(null)
    setPending(true)
    inputRef.current?.focus()
    const opening = ++seq.current
    const start = request.startDir
    void (start !== '' ? Promise.resolve(start) : getHomeDir()).then(
      (dir) => {
        // A slow home lookup from a cancelled opening, or one overtaken by the
        // user navigating, must not redirect the picker.
        if (opening === seq.current) navigate(dir)
      },
      (e: unknown) => {
        if (opening !== seq.current) return
        setError(String(e))
        setPending(false)
      }
    )
    return () => {
      seq.current++
      cancelTyping()
    }
  }, [request, navigate])

  if (!request) return null

  const typed = splitTypedPath(input)
  const visible = listing ? filterFolders(listing.folders, typed.filter) : []
  const quick = quickAccess(favorites, recents, saved)
  const current = listing?.path ?? ''
  const isFavorite = current !== '' && favorites.some((f) => samePath(f, current))
  const selectable = selectableFolder({ listing, pending, error })

  const onInput = (value: string): void => {
    setInput(value)
    setActive(0)
    const wasTyping = typeTimer.current !== null
    cancelTyping()
    const dir = typedNavigation(value, current)
    if (dir === null) {
      // The typed path was edited back to a filter: the scheduled listing is
      // void, so the folder on screen is the selectable one again.
      if (wasTyping) {
        seq.current++
        setPending(false)
      }
      return
    }
    // Pending NOW, not after the debounce: an immediate Select/Ctrl+Enter
    // would otherwise return the folder still on screen. The seq bump also
    // voids any listing still in flight for an older path.
    seq.current++
    setPending(true)
    setError(null)
    // Debounced: every keystroke of a typed path would otherwise queue a
    // directory listing (slow on network drives) in the Rust backend.
    typeTimer.current = setTimeout(() => {
      typeTimer.current = null
      navigate(dir)
    }, 150)
  }

  const enter = (path: string): void => {
    cancelTyping()
    setInput('')
    navigate(path)
    inputRef.current?.focus()
  }

  const windowsDialog = (): void => {
    // Close the overlay first: the native dialog is modal and would otherwise
    // sit next to a dead in-app picker.
    const start = current
    const resolve = request.resolve
    useFolderPickerStore.setState({ request: null })
    void pickDirectory(start || undefined).then(resolve, () => resolve(null))
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      settle(null)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, Math.max(visible.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      // Enter on a button is that button's activation, not "select folder".
      const el = e.target as HTMLElement
      if (!pickerOwnsEnter({ tagName: el.tagName, inListbox: el.closest('[role="listbox"]') !== null })) return
      e.preventDefault()
      // Ctrl+Enter selects the folder being shown; Enter steps into the
      // highlighted subfolder (or selects when nothing matches).
      if (e.ctrlKey || visible.length === 0) {
        if (selectable !== null) settle(selectable)
      } else enter(visible[Math.min(active, visible.length - 1)])
    } else if (e.key === 'Backspace' && input === '' && listing?.parent != null) {
      e.preventDefault()
      navigate(listing.parent)
    }
  }

  const quickRow = (path: string, fav: boolean): ReactElement => (
    <div key={path} className="group flex items-center gap-1 rounded-md px-2 py-1 hover:bg-accent">
      <button
        type="button"
        title={path}
        onClick={() => enter(path)}
        onDoubleClick={() => settle(path)}
        className="min-w-0 flex-1 truncate text-left text-xs"
      >
        {folderName(path)}
      </button>
      {fav && (
        <button
          type="button"
          aria-label={`Remove ${folderName(path)} from favorites`}
          onClick={() => toggleFav(path)}
          className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
        >
          <Star className="h-3 w-3 fill-current" />
        </button>
      )}
    </div>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onMouseDown={() => settle(null)}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Choose folder"
        className="flex h-[480px] max-h-[85vh] w-[720px] max-w-[92vw] flex-col overflow-hidden rounded-lg border border-border bg-card text-sm shadow-lg"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Button
            size="sm"
            variant="ghost"
            aria-label="Parent folder"
            disabled={listing?.parent == null}
            onClick={() => listing?.parent != null && enter(listing.parent)}
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
          <span title={current} className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {current === '' ? 'This PC' : current}
          </span>
          <Button
            size="sm"
            variant="ghost"
            aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
            title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
            disabled={current === ''}
            onClick={() => toggleFav(current)}
          >
            <Star className={`h-4 w-4 ${isFavorite ? 'fill-current text-yellow-500' : ''}`} />
          </Button>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="w-48 shrink-0 overflow-y-auto border-r border-border p-1.5">
            <div className="px-2 pb-1 pt-1 text-[11px] font-semibold uppercase text-muted-foreground">Favorites</div>
            {quick.favorites.length === 0
              ? <div className="px-2 pb-2 text-xs text-muted-foreground">Star a folder to pin it here.</div>
              : quick.favorites.map((p) => quickRow(p, true))}
            <div className="px-2 pb-1 pt-3 text-[11px] font-semibold uppercase text-muted-foreground">Recent</div>
            {quick.recents.length === 0
              ? <div className="px-2 text-xs text-muted-foreground">No recent folders.</div>
              : quick.recents.map((p) => quickRow(p, false))}
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="m-2 flex items-center gap-2 rounded-md border border-input bg-background px-3 py-1.5 focus-within:ring-1 focus-within:ring-ring">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
              <input
                ref={inputRef}
                aria-label="Filter or type a path"
                value={input}
                onChange={(e) => onInput(e.target.value)}
                placeholder="Filter, or type a path like C:\Code\"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <div role="listbox" aria-label="Subfolders" className="min-h-0 flex-1 overflow-y-auto px-1.5">
              {error !== null ? (
                <div className="px-3 py-4 text-xs text-destructive">{error}</div>
              ) : visible.length === 0 ? (
                <div className="px-3 py-4 text-xs text-muted-foreground">{listing ? 'No subfolders' : 'Loading…'}</div>
              ) : (
                visible.map((path, i) => (
                  <div
                    key={path}
                    role="option"
                    aria-selected={i === active}
                    onClick={() => enter(path)}
                    onMouseEnter={() => setActive(i)}
                    className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 ${i === active ? 'bg-accent' : ''}`}
                  >
                    {i === active ? <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" /> : <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />}
                    <span className="truncate">{current === '' ? path : folderName(path)}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-3 py-2.5">
          <Button size="sm" variant="ghost" className="mr-auto" onClick={windowsDialog}>
            Windows dialog
          </Button>
          <Button size="sm" variant="outline" onClick={() => settle(null)}>
            Cancel
          </Button>
          <Button size="sm" disabled={selectable === null} onClick={() => selectable !== null && settle(selectable)}>
            Select folder
          </Button>
        </div>
      </div>
    </div>
  )
}
