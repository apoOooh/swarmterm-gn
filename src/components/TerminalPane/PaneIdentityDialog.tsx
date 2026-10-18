import { useEffect, useState, type ReactElement, type UIEvent } from 'react'
import { createPortal } from 'react-dom'
import { collectLeaves } from '@/lib/layout-tree'
import { MAX_PANE_NAME } from '@/lib/pane-address'
import { PANE_COLORS, browseIconNames, isEmojiIcon, paneHeaderTintStyle, sanitizePaneIcon, searchIconNames, visibleRows } from '@/lib/pane-identity'
import { resolvePaneTitle } from '@/lib/pane-title'
import { DEFAULT_TEMPLATE_ID } from '@/lib/templates'
import { cn } from '@/lib/utils'
import { selectActiveWorkspace, useAppStore } from '@/store/app-store'
import { usePaneIdentityDialogStore } from '@/store/pane-identity-dialog-store'
import { useTerminalTitleStore } from '@/store/terminal-title-store'
import { useModalFocus } from '@/components/ui/use-modal-focus'
import { ALL_ICON_NAMES, PaneIdentityIcon } from './PaneIdentityIcon'

/** Icon grid geometry: 10 columns of h-7 buttons with a gap-1 (4px). */
const GRID_COLUMNS = 10
const GRID_ROW_PX = 32
const GRID_HEIGHT_PX = 192

/**
 * Edits a pane's identity — name, icon, color — in one place. Mounted once in
 * App; every entry point opens it through usePaneIdentityDialogStore. Saving
 * never respawns the pane (identity is cosmetic).
 */
export function PaneIdentityDialog(): ReactElement | null {
  const leafId = usePaneIdentityDialogStore((s) => s.leafId)
  const close = usePaneIdentityDialogStore((s) => s.close)
  const leaf = useAppStore((s) => {
    const ws = selectActiveWorkspace(s)
    return leafId && ws ? collectLeaves(ws.layout).find((l) => l.id === leafId) : undefined
  })
  const agentTitle = useTerminalTitleStore((s) => (leaf ? s.titles[leaf.terminalId] : undefined))
  const [name, setName] = useState('')
  const [icon, setIcon] = useState<string | undefined>()
  const [emoji, setEmoji] = useState('')
  const [color, setColor] = useState<string | undefined>()
  const [headerTint, setHeaderTint] = useState(false)
  const [iconQuery, setIconQuery] = useState('')
  const open = leaf !== undefined
  const root = useModalFocus(open, close, leaf?.terminalId)

  // Seed the draft from the pane each time the dialog opens on it.
  useEffect(() => {
    if (!leaf) return
    setName(leaf.name ?? '')
    setIcon(leaf.icon)
    setEmoji(isEmojiIcon(leaf.icon) ? leaf.icon ?? '' : '')
    setIconQuery('')
    setColor(leaf.color)
    setHeaderTint(leaf.headerTint === true)
    // Reseed only on open / target change, not on every layout update.
  }, [leafId, open])

  // The target vanished (workspace switched, pane closed): drop the request,
  // or the dialog would pop up again when its workspace comes back.
  useEffect(() => {
    if (leafId !== null && !leaf) close()
  }, [leafId, leaf, close])

  if (!leaf) return null
  const autoTitle = resolvePaneTitle(leaf.agentId ?? DEFAULT_TEMPLATE_ID, agentTitle)
  const emojiValid = emoji.trim() === '' || isEmojiIcon(emoji)
  // Empty search: every icon, suggestions first (and the pane's current icon
  // on top). A search narrows the same scrollable grid to its matches.
  const shownIcons: readonly string[] = iconQuery.trim()
    ? searchIconNames(ALL_ICON_NAMES, iconQuery, ALL_ICON_NAMES.length)
    : browseIconNames(ALL_ICON_NAMES, leaf.icon)
  const pickIcon = (id: string): void => { setIcon(icon === id ? undefined : id); setEmoji('') }

  const save = (): void => {
    useAppStore.getState().setPaneIdentity(leaf.id, { name, icon, color, headerTint })
    close()
  }
  const clear = (): void => {
    useAppStore.getState().setPaneIdentity(leaf.id, {})
    close()
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}
    >
      <div
        ref={root}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pane-identity-title"
        className="theme-elevated w-[420px] max-w-[90vw] rounded-lg border border-border bg-card p-4 text-foreground"
        onKeyDown={(e) => e.stopPropagation()}
      >
        <h2 id="pane-identity-title" className="text-sm font-semibold">Pane identity</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Give this pane a name and icon so you can tell at a glance who does what. The agent's own title stays visible next to it.
        </p>
        <form onSubmit={(e) => { e.preventDefault(); if (emojiValid) save() }}>
          {/* Preview — exactly what the pane header will show. */}
          <div
            className="mt-3 flex min-w-0 items-center gap-1.5 rounded border border-border bg-card px-2 py-1 text-xs"
            style={paneHeaderTintStyle(color, headerTint)}
          >
            {icon && <PaneIdentityIcon icon={icon} color={color} />}
            {name.trim() && <span className="truncate font-semibold">{name.trim()}</span>}
            {name.trim() && <span className="text-muted-foreground">·</span>}
            <span className="truncate text-muted-foreground">{autoTitle}</span>
          </div>

          <label htmlFor="pane-identity-name" className="mt-3 block text-xs font-medium">Name</label>
          <input
            id="pane-identity-name"
            value={name}
            maxLength={MAX_PANE_NAME}
            placeholder="e.g. Reviewer"
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded border border-input bg-background px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-ring"
          />

          <div className="mt-3 flex items-center justify-between gap-2">
            <p className="text-xs font-medium">Icon</p>
            <input
              value={iconQuery}
              onChange={(e) => setIconQuery(e.target.value)}
              onKeyDown={(e) => {
                // Enter picks the best match instead of saving the dialog.
                if (e.key === 'Enter') {
                  e.preventDefault()
                  if (shownIcons[0] && iconQuery.trim()) pickIcon(shownIcons[0])
                }
              }}
              placeholder={`Search ${ALL_ICON_NAMES.length} icons…`}
              aria-label="Search icons"
              spellCheck={false}
              className="w-44 rounded border border-input bg-background px-2 py-0.5 text-xs outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          {iconQuery.trim() !== '' && shownIcons.length === 0 && (
            <p className="mt-1 text-xs text-muted-foreground">No icon matches “{iconQuery.trim()}”.</p>
          )}
          <IconGrid key={iconQuery.trim()} icons={shownIcons} selected={icon} color={color} onPick={pickIcon} />
          <p className="mt-1 text-[11px] text-muted-foreground">
            {iconQuery.trim() ? `${shownIcons.length} matching icons` : `${shownIcons.length} icons — suggestions first, then A–Z`}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <label htmlFor="pane-identity-emoji" className="text-xs text-muted-foreground">or an emoji</label>
            <input
              id="pane-identity-emoji"
              value={emoji}
              maxLength={16}
              placeholder="🔍"
              aria-invalid={!emojiValid}
              onChange={(e) => {
                setEmoji(e.target.value)
                if (isEmojiIcon(e.target.value)) setIcon(sanitizePaneIcon(e.target.value))
                else if (e.target.value.trim() === '' && isEmojiIcon(icon)) setIcon(undefined)
              }}
              className={cn('w-16 rounded border bg-background px-2 py-0.5 text-center text-sm outline-none focus:ring-1 focus:ring-ring', emojiValid ? 'border-input' : 'border-destructive')}
            />
            {!emojiValid && <span className="text-xs text-destructive">One emoji only</span>}
          </div>

          <p className="mt-3 text-xs font-medium">Color</p>
          <div role="radiogroup" aria-label="Color" className="mt-1 flex flex-wrap gap-1.5">
            <button
              type="button"
              role="radio"
              aria-checked={color === undefined}
              aria-label="No color"
              title="No color"
              onClick={() => setColor(undefined)}
              className={cn('h-5 w-5 rounded-full border border-border bg-background', color === undefined && 'ring-2 ring-ring ring-offset-1 ring-offset-card')}
            />
            {PANE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color === c}
                aria-label={c}
                title={c}
                onClick={() => setColor(c)}
                style={{ backgroundColor: c }}
                className={cn('h-5 w-5 rounded-full', color === c && 'ring-2 ring-ring ring-offset-1 ring-offset-card')}
              />
            ))}
          </div>
          <label className={cn('mt-2 flex items-center gap-2 text-xs', color === undefined && 'opacity-50')}>
            <input
              type="checkbox"
              checked={headerTint && color !== undefined}
              disabled={color === undefined}
              onChange={(e) => setHeaderTint(e.target.checked)}
            />
            Tint the top bar with this color
          </label>

          <div className="mt-4 flex items-center justify-between gap-2">
            <button type="button" onClick={clear} className="rounded px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
              Clear identity
            </button>
            <div className="flex gap-2">
              <button type="button" onClick={close} className="rounded px-3 py-1.5 text-xs hover:bg-accent">Cancel</button>
              <button type="submit" disabled={!emojiValid} className="rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50">Save</button>
            </div>
          </div>
        </form>
      </div>
    </div>,
    document.body
  )
}

interface IconGridProps {
  icons: readonly string[]
  selected: string | undefined
  color: string | undefined
  onPick: (id: string) => void
}

/**
 * Scrollable icon grid that mounts only the rows near the viewport: the full
 * list is ~2000 icons and each non-suggested one loads its own chunk, so
 * rendering all of them would fetch the whole set on open. A spacer keeps
 * the scrollbar sized to the full list. Keyed by the query in the parent, so
 * a new search starts at the top.
 */
function IconGrid({ icons, selected, color, onPick }: IconGridProps): ReactElement {
  const [scrollTop, setScrollTop] = useState(0)
  const rowCount = Math.ceil(icons.length / GRID_COLUMNS)
  const { first, last } = visibleRows(scrollTop, GRID_HEIGHT_PX, GRID_ROW_PX, rowCount)
  const slice = icons.slice(first * GRID_COLUMNS, (last + 1) * GRID_COLUMNS)
  return (
    <div
      role="radiogroup"
      aria-label="Icon"
      onScroll={(e: UIEvent<HTMLDivElement>) => setScrollTop(e.currentTarget.scrollTop)}
      className="mt-1 overflow-y-auto rounded border border-border"
      style={{ height: GRID_HEIGHT_PX }}
    >
      <div style={{ height: rowCount * GRID_ROW_PX, position: 'relative' }}>
        <div
          className="absolute inset-x-0 grid grid-cols-10 gap-1 px-1"
          style={{ top: first * GRID_ROW_PX, paddingTop: 2 }}
        >
          {slice.map((id) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={selected === id}
              aria-label={id}
              title={id}
              onClick={() => onPick(id)}
              className={cn('flex h-7 items-center justify-center rounded hover:bg-accent', selected === id && 'bg-accent ring-1 ring-ring')}
            >
              <PaneIdentityIcon icon={id} color={selected === id ? color : undefined} className="h-4 w-4" />
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
