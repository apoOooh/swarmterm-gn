import { useCallback, useEffect, useRef, useState } from 'react'
import { Folder, Terminal as ShellIcon, Check, Columns2, Rows2, Radio, X, GitBranch, History, Maximize2, Minimize2, Archive, PictureInPicture2, ClipboardList, MessagesSquare, MoreHorizontal, Mic, Loader2 } from 'lucide-react'
import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core'
import { AgentIcon } from '@/components/AgentIcon'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem
} from '@/components/ui/dropdown-menu'
import { DEFAULT_TEMPLATE_ID, TEMPLATES, templateById, isTemplateAvailable, launchMode } from '@/lib/templates'
import { resolvePaneTitle } from '@/lib/pane-title'
import { useAgentAvailabilityStore } from '@/store/agent-availability-store'
import { KNOWN_SHELLS, visibleShells, type ShellId } from '@/lib/terminal-pref'
import { useShellAvailabilityStore } from '@/store/shell-availability-store'
import { resolveHeaderLevel, resolveHeaderOverflow, shortenPath, type HeaderOverflowItem } from '@/lib/header-layout'
import { applyHeaderLayout } from '@/lib/header-layout-pref'
import { useHeaderLayoutStore } from '@/store/header-layout-store'
import { contextBand, contextUsageTitle, formatContextUsage, type ContextBand } from '@/lib/context-usage'
import { useAgentAccountsStore } from '@/store/agent-accounts-store'
import { accountLabel } from '@/lib/agent-accounts'
import { cn } from '@/lib/utils'
import type { ConnectionStatus } from '@/lib/war-room-connection'
import { useFloatMove } from '@/components/Workspace/FloatingPane'

interface PaneHeaderProps {
  /** Resolved agent id (leaf override already applied). */
  agentId: string
  accountId?: string
  onAccountChange?: (accountId?: string) => void
  /** Resolved shell id (leaf override already applied). */
  shellId: ShellId
  /** Resolved cwd, shown in the folder tooltip + collapsed label. */
  resolvedCwd: string
  /** Whether this pane has its own cwd override (enables "Use workspace folder"). */
  hasCwdOverride: boolean
  /** Agent-set title (via the terminal.set_title MCP tool); falls back to the agent name. */
  agentTitle?: string
  onAgentChange: (id: string) => void
  /** Launch mode id of this pane; absent ⇒ the agent's default mode. */
  launchModeId?: string
  /** Switch the launch mode — respawns the agent, continuing its session. */
  onLaunchModeChange: (id: string) => void
  /** Respawn into the agent's session picker to take over an older chat. */
  onPickSession: () => void
  onShellChange: (id: ShellId) => void
  onChoosePath: () => void
  onResetPath: () => void
  /** `plain` = Alt held: open a plain shell instead of the default agent. */
  onSplitRight: (plain: boolean) => void
  onSplitDown: (plain: boolean) => void
  /** Name of the agent a split opens (resolved default), for the tooltip. */
  splitAgentName: string
  onClose: () => void
  /** Open the handoff brief preview for this pane (SWA-21). */
  onHandoff: () => void
  /** Open the read-only conversation view (SWA-25); absent ⇒ no button. */
  onThread?: () => void
  /** Park the pane in the workspace drawer (hidden, kept running). */
  onDrawer: () => void
  /**
   * Built-in speech (SWA-38); absent ⇒ no button (Voice off, no model).
   * `phase` is this pane's dictation phase, `idle` when it has none.
   */
  dictation?: { phase: 'idle' | 'recording' | 'transcribing'; onToggle: () => void }
  isZoomed: boolean
  /** While zoomed: how many other panes are hidden behind this one. */
  zoomHiddenCount?: number
  onToggleZoom: () => void
  /** Whether the pane floats above the split view (lib/floating-panes.ts). */
  isFloating: boolean
  onToggleFloat: () => void
  /** Whether broadcast mode is armed for this workspace. */
  broadcastActive: boolean
  /** Whether this pane is in the broadcast group. */
  isBroadcastMember: boolean
  /** Toggle this pane's membership in the broadcast group. */
  onToggleBroadcast: () => void
  /** dnd-kit draggable wiring — makes the header bar the grab handle for swap-DnD. */
  dragHandleRef: (element: HTMLElement | null) => void
  dragListeners: DraggableSyntheticListeners
  dragAttributes: DraggableAttributes
  /** Branch of the bound git worktree, shown as a chip; absent for normal panes. */
  worktreeBranch?: string
  /** Context-window % from Claude Code's status line (S15); absent ⇒ no chip. */
  ctxPct?: number
  /** War Room connection of this pane; absent ⇒ not in a room, no chip. */
  warRoom?: ConnectionStatus | null
}

// Band → colour. Amber is VS Code Dark Modern `editorWarning.foreground`, red is
// the StateDot / AttentionBadge danger red, so the chip speaks the same colour
// language as the rest of the chrome AND as the in-pane status line, whose
// `render.rs::ctx_color` flips at the very same 70 / 90 thresholds — one number
// must never show two verdicts.
const CTX_BAND_CLASS: Record<ContextBand, string> = {
  normal: 'text-muted-foreground',
  warn: 'text-[#CCA700]',
  danger: 'text-[#F14C4C]'
}

// Width estimates for the overflow resolver. Measuring every child would mean a
// layout pass per resize tick; these are close enough for a 28px row whose title
// soaks up the slack (`icon-sm` is 24px + the 2px `gap-0.5`).
const ICON_PX = 26
const CHAR_PX = 6.5
const TITLE_MIN_PX = 56
// Hover intent: open after a short dwell so sweeping the mouse across the
// workspace doesn't flash every header; close with a grace period so moving
// from the row into the dropped panel (or a menu) doesn't snap it shut.
const OPEN_DELAY_MS = 150
const CLOSE_DELAY_MS = 200

interface HeaderItem extends HeaderOverflowItem {
  /** `inPanel` = rendered inside the expanded second row (full labels). */
  render: (inPanel: boolean) => React.ReactNode
}

/**
 * The per-pane header. Core items (by default agent + mode, title, folder;
 * user-configurable in Settings → Title bar) plus zoom and close are pinned and
 * always render; everything else is collapsible and is dropped from the end of
 * the user's order when the row runs out of room — see
 * `resolveHeaderOverflow`. Hidden items aren't gone: a ⋯ chip marks them, and
 * hovering the header (or clicking ⋯) drops a wrapping second row over the
 * terminal that shows them. A ResizeObserver on the header row drives it.
 */
export function PaneHeader(props: PaneHeaderProps): React.ReactElement {
  const floatMove = useFloatMove()
  const { agentId, shellId, resolvedCwd, hasCwdOverride, worktreeBranch, ctxPct } = props
  const accounts = useAgentAccountsStore(s => s.accounts)
  const hiddenCount = props.zoomHiddenCount ?? 0
  const layoutOrder = useHeaderLayoutStore(s => s.order)
  const layoutCore = useHeaderLayoutStore(s => s.core)
  const layoutOverflow = useHeaderLayoutStore(s => s.overflow)
  const layoutOff = useHeaderLayoutStore(s => s.off)
  const agent = templateById(agentId)
  const mode = launchMode(agentId, props.launchModeId)
  const agentLabel = agent.name
  const shellLabel = KNOWN_SHELLS.find((s) => s.id === shellId)?.label ?? KNOWN_SHELLS[0].label
  const availability = useAgentAvailabilityStore((s) => s.availability)
  const shellAvailability = useShellAvailabilityStore((s) => s.availability)
  const shells = visibleShells(shellAvailability)

  // Title: agent-supplied wins; otherwise the agent name so the slot is never
  // blank. Tooltip carries the full title + full branch (both may be truncated).
  const displayTitle = resolvePaneTitle(agentId, props.agentTitle)
  const titleTooltip = worktreeBranch ? `${displayTitle} — ${worktreeBranch}` : displayTitle

  // Measure the header row. Start wide so the first paint isn't over-collapsed
  // before the observer fires; bucket to 8px so a divider drag doesn't
  // re-render the header on every pixel.
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(9999)
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? el.clientWidth
      setWidth(Math.floor(w / 8) * 8)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const level = resolveHeaderLevel(width, Boolean(worktreeBranch))

  // ── Expand state ──────────────────────────────────────────────────────────
  // `hover` follows the pointer; `pinned` is the ⋯ click (sticky until Escape /
  // outside click / ⋯ again). A menu opened from the header portals outside it,
  // so the pointer "leaves" — `menuOpen` keeps the panel up meanwhile.
  const [hover, setHover] = useState(false)
  const [pinned, setPinned] = useState(false)
  // Opened from the keyboard: the panel then owns focus (`data-keyboard-owner`)
  // instead of App's focus-return pulling it straight back to the terminal.
  const [viaKeyboard, setViaKeyboard] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const clearTimer = (): void => { window.clearTimeout(timer.current) }
  useEffect(() => clearTimer, [])
  const moreRef = useRef<HTMLButtonElement | null>(null)
  const onPointerEnter = (e: React.PointerEvent): void => {
    clearTimer()
    // A button held down = another pane is being dragged across this header;
    // dropping the panel then would cover the drop target.
    if (e.buttons !== 0) return
    if (!hover) timer.current = window.setTimeout(() => setHover(true), OPEN_DELAY_MS)
  }
  const onPointerLeave = (): void => {
    clearTimer()
    timer.current = window.setTimeout(() => setHover(false), CLOSE_DELAY_MS)
  }
  const trackMenu = useCallback((open: boolean): void => {
    setMenuOpen(open)
    if (!open) setHover(rootRef.current?.matches(':hover') ?? false)
  }, [])

  useEffect(() => {
    if (!pinned) return
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node
      // Radix menus portal to <body>; a click inside one is not "outside".
      if (rootRef.current?.contains(t) || (t as Element).closest?.('[role="menu"]')) return
      setPinned(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const active = document.activeElement
      // Esc typed into a terminal (vim, an agent TUI) belongs to the pty, not us.
      if (active?.closest('.xterm')) return
      // Focus sitting in the panel would drop to <body> once it goes inert —
      // hand it back to ⋯, where the keyboard path started.
      if (active && panelRef.current?.contains(active)) moreRef.current?.focus()
      setPinned(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [pinned])

  // Compose the dnd activator ref with our measure ref — the header row is both
  // the drag handle and the element we size against.
  const setRootRef = (el: HTMLDivElement | null): void => {
    props.dragHandleRef(el)
    rootRef.current = el
  }

  // ── Items ─────────────────────────────────────────────────────────────────
  // Built in the default order; `applyHeaderLayout` below re-sorts them and
  // sets pinned/priority from the user's Settings → Title bar preference.
  const items: HeaderItem[] = []
  const iconButton = (
    id: string,
    priority: number,
    node: React.ReactNode,
    pinnedItem = false,
    width = ICON_PX
  ): void => { items.push({ id, priority, pinned: pinnedItem, width, render: () => node }) }

  items.push({
    id: 'agent',
    priority: 0,
    pinned: true,
    width: ICON_PX + (mode ? mode.id.length * CHAR_PX + 6 : 0),
    render: () => (
      <div key="agent" className="flex shrink-0 items-center" data-no-dnd>
        <DropdownMenu
          onOpenChange={(open) => {
            trackMenu(open)
            if (open) void useAgentAvailabilityStore.getState().refresh()
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" title={`Agent: ${agentLabel}`} aria-label={`Agent: ${agentLabel}`}>
              <AgentIcon template={agent} className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          {/* 11 roster rows can outgrow a short window — cap to Radix's
              measured available height and scroll the rest. */}
          <DropdownMenuContent
            align="start"
            className="max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto"
          >
            {TEMPLATES.map((t) => {
              const available = isTemplateAvailable(t, availability)
              return (
                <DropdownMenuItem key={t.id} disabled={!available} onSelect={() => props.onAgentChange(t.id)}>
                  <Check aria-hidden="true" className={cn('h-3.5 w-3.5', t.id === agentId ? 'opacity-100' : 'opacity-0')} />
                  <AgentIcon template={t} className="h-4 w-4 shrink-0" />
                  <span>{t.name}</span>
                  {!available && (
                    <span className="ml-auto pl-3 text-xs text-muted-foreground">Not installed</span>
                  )}
                </DropdownMenuItem>
              )
            })}
            {agent.launchModes !== undefined && mode !== undefined && (
              <>
                <div role="separator" className="my-1 h-px bg-border" />
                <div className="px-2 py-1 text-xs text-muted-foreground">Mode (restarts, keeps session)</div>
                {agent.launchModes.map((m) => (
                  <DropdownMenuItem key={m.id} onSelect={() => props.onLaunchModeChange(m.id)}>
                    <Check aria-hidden="true" className={cn('h-3.5 w-3.5', m.id === mode.id ? 'opacity-100' : 'opacity-0')} />
                    <span>{m.label}</span>
                  </DropdownMenuItem>
                ))}
              </>
            )}
            {agent.continueCommand !== undefined && (
              <DropdownMenuItem onSelect={props.onPickSession}>
                <History aria-hidden="true" className="h-3.5 w-3.5" />
                <span>Resume previous chat…</span>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {mode !== undefined && (
          <span className="px-0.5 text-[10px] uppercase text-muted-foreground" title={`Mode: ${mode.label}`}>
            {mode.id}
          </span>
        )}
      </div>
    )
  })

  if (agentId === 'claude-code' || agentId === 'codex') {
    const label = accountLabel(props.accountId, accounts)
    items.push({
      id: 'account',
      priority: 5,
      width: Math.min(label.length * CHAR_PX, 96) + 12,
      render: () => (
        <DropdownMenu key="account" onOpenChange={trackMenu}>
          <DropdownMenuTrigger asChild><button data-no-dnd className="max-w-24 shrink-0 truncate rounded border border-border px-1 text-[10px] text-muted-foreground" title={`Subscription: ${label} — click to switch; the conversation moves with the pane`} aria-label={`Account: ${label}`}>{label}</button></DropdownMenuTrigger>
          <DropdownMenuContent><DropdownMenuItem onSelect={() => props.onAccountChange?.(undefined)}>Default</DropdownMenuItem>{accounts.filter(account => account.agentId === agentId).map(account => <DropdownMenuItem key={account.id} onSelect={() => props.onAccountChange?.(account.id)}>{account.name}</DropdownMenuItem>)}</DropdownMenuContent>
        </DropdownMenu>
      )
    })
  }

  // Title — the star. flex-1 soaks free space; truncates last. Draggable.
  items.push({
    id: 'title',
    priority: 0,
    pinned: true,
    width: TITLE_MIN_PX,
    render: () => (
      <span key="title" className="min-w-6 flex-1 truncate px-1 text-xs text-foreground" title={titleTooltip}>
        {displayTitle}
      </span>
    )
  })

  // Folder — pinned: knowing which project a pane is in matters at any width.
  // The label shrinks harder in narrow panes instead of disappearing.
  const folderLabel = shortenPath(resolvedCwd)
  const narrowFolder = width < 260
  items.push({
    id: 'folder',
    priority: 0,
    pinned: true,
    width: 30 + Math.min(folderLabel.length * CHAR_PX, narrowFolder ? 80 : 128),
    render: () => (
      <DropdownMenu key="folder" onOpenChange={trackMenu}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            data-no-dnd
            className="h-6 min-w-6 shrink gap-1 px-1.5 text-muted-foreground"
            title={`Folder: ${resolvedCwd}`}
            aria-label={`Folder: ${resolvedCwd}`}
          >
            <Folder className="h-3.5 w-3.5 shrink-0" />
            <span className={cn('min-w-0 truncate text-[11px]', narrowFolder ? 'max-w-[5rem]' : 'max-w-[8rem]')}>{folderLabel}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={props.onChoosePath}>
            <Folder className="h-3.5 w-3.5" />
            <span>Choose folder…</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={props.onResetPath} disabled={!hasCwdOverride}>
            <Check aria-hidden="true" className="h-3.5 w-3.5 opacity-0" />
            <span>Use workspace folder</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )
  })

  items.push({
    id: 'shell',
    priority: 1,
    width: ICON_PX + (level.showShellLabel ? shellLabel.length * CHAR_PX + 6 : 0),
    render: (inPanel) => (
      <DropdownMenu
        key="shell"
        onOpenChange={(open) => {
          trackMenu(open)
          // Re-probe on open so a shell installed while the app runs (brew
          // install fish) shows up without a restart — same contract as the
          // agent menu above.
          if (open) void useShellAvailabilityStore.getState().refresh()
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            data-no-dnd
            className="h-6 shrink-0 gap-1 px-1.5 text-muted-foreground"
            title={`Shell: ${shellLabel}`}
            aria-label={`Shell: ${shellLabel}`}
          >
            <ShellIcon className="h-3.5 w-3.5 shrink-0" />
            {(inPanel || level.showShellLabel) && <span className="text-[11px]">{shellLabel}</span>}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {/* Only shells the backend probe found on THIS machine — the
              catalog is cross-platform, the menu must not be. */}
          {shells.map((s) => (
            <DropdownMenuItem key={s.id} onSelect={() => props.onShellChange(s.id)}>
              <Check aria-hidden="true" className={cn('h-3.5 w-3.5', s.id === shellId ? 'opacity-100' : 'opacity-0')} />
              <span>{s.label}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  })

  if (props.warRoom) {
    const warRoom = props.warRoom
    items.push({
      id: 'war-room',
      priority: 4,
      width: 10,
      render: (inPanel) => (
        <span key="war-room" className={cn('flex shrink-0 items-center gap-1', inPanel && 'px-1.5 text-[11px] text-muted-foreground')}>
          <span
            data-warroom-status={warRoom.kind}
            title={`War Room: ${warRoom.label}. ${warRoom.reason}`}
            aria-label={`War Room: ${warRoom.label}`}
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full',
              warRoom.kind === 'connected' && 'bg-emerald-500',
              warRoom.kind === 'waiting' && 'bg-amber-400',
              warRoom.kind === 'error' && 'bg-destructive'
            )}
          />
          {inPanel && <span>War Room: {warRoom.label}</span>}
        </span>
      )
    })
  }

  // Worktree — degrades full name → truncated → icon-only before it hides.
  if (worktreeBranch && level.worktree !== 'hidden') {
    const wt = level.worktree
    items.push({
      id: 'worktree',
      priority: 2,
      width: 24 + (wt === 'icon' ? 0 : Math.min(worktreeBranch.length * CHAR_PX, wt === 'name-trunc' ? 80 : 160)),
      render: (inPanel) => (
        <span
          key="worktree"
          title={`Worktree branch: ${worktreeBranch}`}
          className="flex min-w-0 shrink-0 items-center gap-1 rounded bg-accent px-1.5 py-0.5 text-[11px] text-muted-foreground"
        >
          <GitBranch className="h-3 w-3 shrink-0" />
          {(inPanel || wt !== 'icon') && (
            <span className={cn('truncate', inPanel ? 'max-w-[16rem]' : wt === 'name-trunc' ? 'max-w-[5rem]' : 'max-w-[10rem]')}>
              {worktreeBranch}
            </span>
          )}
        </span>
      )
    })
  }

  // Context usage — Claude Code's own status-line number mirrored into the
  // chrome; tabular-nums so the width does not jitter every turn.
  if (ctxPct !== undefined) {
    items.push({
      id: 'ctx',
      priority: 3,
      width: 44,
      render: () => (
        <span
          key="ctx"
          title={contextUsageTitle(ctxPct)}
          className={cn(
            'flex shrink-0 items-center rounded bg-accent px-1.5 py-0.5 text-[11px] tabular-nums',
            CTX_BAND_CLASS[contextBand(ctxPct)]
          )}
        >
          {formatContextUsage(ctxPct)}
        </span>
      )
    })
  }

  if (props.broadcastActive) {
    iconButton('broadcast', 6, (
      <Button
        key="broadcast"
        variant="ghost"
        size="icon-sm"
        aria-label="Toggle broadcast membership"
        aria-pressed={props.isBroadcastMember}
        title={
          props.isBroadcastMember
            ? 'In broadcast group — click to remove'
            : 'Add to broadcast group'
        }
        onClick={props.onToggleBroadcast}
        className={cn(props.isBroadcastMember && 'text-broadcast')}
      >
        <Radio className="h-3.5 w-3.5" />
      </Button>
    ))
  }
  if (props.dictation) {
    const { phase, onToggle } = props.dictation
    const label = phase === 'recording' ? 'Stop dictation and insert' : phase === 'transcribing' ? 'Transcribing…' : 'Dictate into this pane'
    iconButton('dictate', 13, (
      <Button
        key="dictate"
        variant="ghost"
        size="icon-sm"
        title={`${label} (Ctrl+Shift+Space)`}
        aria-label={label}
        aria-pressed={phase === 'recording'}
        disabled={phase === 'transcribing'}
        // The click must leave the keyboard on the terminal: Rust pins the
        // pane that owns it when recording starts.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onToggle}
        className={cn(phase === 'recording' && 'text-[#ef4444] hover:text-[#ef4444]')}
      >
        {phase === 'transcribing'
          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
          : <Mic className={cn('h-3.5 w-3.5', phase === 'recording' && 'animate-pulse')} />}
      </Button>
    ))
  }
  if (props.onThread) {
    iconButton('thread', 7, (
      <Button key="thread" variant="ghost" size="icon-sm" title="Conversation — read-only view of this session" aria-label="Conversation thread" onClick={props.onThread}>
        <MessagesSquare className="h-3.5 w-3.5" />
      </Button>
    ))
  }
  iconButton('handoff', 8, (
    <Button key="handoff" variant="ghost" size="icon-sm" title="Handoff brief — preview and copy, nothing is sent" aria-label="Handoff brief" onClick={props.onHandoff}>
      <ClipboardList className="h-3.5 w-3.5" />
    </Button>
  ))
  iconButton('split-right', 9, (
    <Button key="split-right" variant="ghost" size="icon-sm" title={splitTitle('Split right', props.splitAgentName)} aria-label="Split right" onClick={(e) => props.onSplitRight(e.altKey)}>
      <Columns2 className="h-3.5 w-3.5" />
    </Button>
  ))
  iconButton('split-down', 10, (
    <Button key="split-down" variant="ghost" size="icon-sm" title={splitTitle('Split down', props.splitAgentName)} aria-label="Split down" onClick={(e) => props.onSplitDown(e.altKey)}>
      <Rows2 className="h-3.5 w-3.5" />
    </Button>
  ))
  iconButton('float', 11, (
    <Button key="float" variant="ghost" size="icon-sm" title={props.isFloating ? 'Dock pane back into the layout' : 'Float pane — drag the header to move it freely'} aria-label={props.isFloating ? 'Dock pane' : 'Float pane'} aria-pressed={props.isFloating} onClick={props.onToggleFloat}>
      <PictureInPicture2 className="h-3.5 w-3.5" />
    </Button>
  ))
  iconButton('drawer', 12, (
    <Button key="drawer" variant="ghost" size="icon-sm" title="Move to drawer — keeps running (Ctrl+Shift+D)" aria-label="Move to drawer" onClick={props.onDrawer}>
      <Archive className="h-3.5 w-3.5" />
    </Button>
  ))
  // Zoom + close — pinned at the far right, after the ⋯ chip.
  iconButton('zoom', 0, (
    <Button
      key="zoom"
      variant="ghost"
      size={props.isZoomed && hiddenCount > 0 ? 'sm' : 'icon-sm'}
      title={props.isZoomed
        ? `Restore pane${hiddenCount > 0 ? ` — ${hiddenCount} other pane${hiddenCount === 1 ? '' : 's'} hidden` : ''} (Ctrl+Shift+Enter)`
        : 'Maximize pane (Ctrl+Shift+Enter)'}
      aria-label={props.isZoomed ? 'Restore pane' : 'Maximize pane'}
      aria-pressed={props.isZoomed}
      onClick={props.onToggleZoom}
      // Zoomed: the way out is the one coloured control in the header.
      className={cn(props.isZoomed && 'h-6 gap-1 px-1.5 bg-zoom/15 text-zoom hover:bg-zoom/25 hover:text-zoom')}
    >
      {props.isZoomed ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
      {props.isZoomed && hiddenCount > 0 && <span className="text-[10px] font-semibold tabular-nums">+{hiddenCount}</span>}
    </Button>
  ), true, ICON_PX + (props.isZoomed && hiddenCount > 0 ? String(hiddenCount).length * CHAR_PX + 14 : 0))
  iconButton('close', 0, (
    <Button key="close" variant="ghost" size="icon-sm" title="Close pane" aria-label="Close pane" onClick={props.onClose}>
      <X className="h-3.5 w-3.5" />
    </Button>
  ), true)

  const laidOut = applyHeaderLayout(items, { order: layoutOrder, core: layoutCore, overflow: layoutOverflow, off: layoutOff })
  const { visible, hidden } = resolveHeaderOverflow(width, laidOut)
  const byId = new Map(laidOut.map(i => [i.id, i]))
  const visibleSet = new Set(visible)
  const rowItems = laidOut.filter(i => visibleSet.has(i.id) && i.id !== 'zoom' && i.id !== 'close')
  const hasHidden = hidden.length > 0
  const expanded = hasHidden && (hover || pinned || menuOpen)

  // When the set of hidden items changes, a menu opened from the panel may have
  // unmounted without reporting its close, and a pin outlives the ⋯ that set
  // it. Drop both so a later overflow never reopens the panel on its own.
  const hiddenKey = hidden.join(',')
  useEffect(() => { setMenuOpen(false) }, [hiddenKey])
  useEffect(() => { if (!hasHidden) setPinned(false) }, [hasHidden])
  useEffect(() => { if (!pinned) setViaKeyboard(false) }, [pinned])

  // Keyboard path: ⋯ via Enter/Space pins the panel open and moves focus into it.
  const onMoreClick = (e: React.MouseEvent): void => {
    const next = !pinned
    setPinned(next)
    if (!next) setHover(false)
    setViaKeyboard(next && e.detail === 0)
    if (next && e.detail === 0) {
      // The keyboard click would also reach App's window click listener, whose
      // deferred focus return can land after a quick Esc handed the focus back
      // to ⋯ — and pull it into the terminal. The panel owns the keyboard now.
      e.stopPropagation()
      requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>('button')?.focus())
    }
  }

  return (
    <div
      ref={setRootRef}
      {...(floatMove ? {} : props.dragAttributes)}
      // Floating: bare header space moves the window freely instead of
      // starting a dock drag; controls keep their own clicks. One spread, not
      // an explicit onPointerDown after the listeners: a later prop wins even
      // when undefined, which silently removed dnd-kit's pointer sensor from
      // every docked header (no pane could be dragged).
      {...(floatMove ? {
        onPointerDown: (e: React.PointerEvent) => {
          if (!(e.target as HTMLElement).closest('button, [role="menuitem"], input, [data-header-overflow]')) floatMove(e)
        }
      } : props.dragListeners)}
      // dnd-kit stamps tabIndex 0 on its drag nodes. Keep the header out of the
      // tab order: it has no keyboard action, and a Tab meant for the shell must
      // never park the focus ring on app chrome (see lib/terminal-focus.ts).
      tabIndex={-1}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      // Double-click on bare header space zooms; controls keep their own clicks.
      onDoubleClick={(e) => {
        const t = e.target as HTMLElement
        if (!t.closest('button, [role="menuitem"], input, [data-header-overflow]')) props.onToggleZoom()
      }}
      className={cn(
        'pane-header relative flex h-7 shrink-0 cursor-grab items-center gap-0.5 border-b border-border bg-card px-1.5 active:cursor-grabbing',
        // Zoomed: violet bottom border, so "the others are behind this one"
        // is visible without hunting for the restore icon.
        props.isZoomed && 'border-b-zoom',
        // Lift above the terminal body (and its z-10 overlays) while the
        // second row hangs over it.
        expanded && 'z-30'
      )}
    >
      {rowItems.map(i => i.render(false))}

      <div className="flex shrink-0 items-center gap-0.5" data-no-dnd>
        {hasHidden && (
          <Button
            variant="ghost"
            size="icon-sm"
            title={`${hidden.length} more — hover the header or click to show`}
            ref={moreRef}
            aria-label="Show hidden controls"
            aria-expanded={expanded}
            onClick={onMoreClick}
            className={cn('text-muted-foreground', expanded && 'bg-accent text-foreground')}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        )}
        {byId.get('zoom')?.render(false)}
        {byId.get('close')?.render(false)}
      </div>

      {hasHidden && (
        <div
          ref={panelRef}
          data-no-dnd
          data-header-overflow
          data-keyboard-owner={expanded && viaKeyboard ? '' : undefined}
          role="toolbar"
          aria-label="Hidden pane controls"
          aria-hidden={!expanded}
          // `cursor-default` — this row is not a drag handle like the header.
          className={cn(
            'absolute inset-x-0 top-full flex cursor-default flex-wrap items-center gap-0.5 border-b border-border bg-card px-1.5 py-1 shadow-md',
            'origin-top transition-[opacity,transform] duration-100 ease-out',
            expanded ? 'opacity-100' : 'pointer-events-none -translate-y-1 opacity-0'
          )}
        >
          {/* Rendered even while closed so open menus anchored here survive
              the fade; `inert` keeps the hidden copy out of tab order. */}
          <div className="contents" inert={!expanded}>
            {hidden.map(id => byId.get(id)?.render(true))}
          </div>
        </div>
      )}
    </div>
  )
}

/** Split tooltip: names the agent a split opens, and the Alt escape hatch
 *  only when there is something to escape from. */
function splitTitle(action: string, agentName: string): string {
  return agentName === templateById(DEFAULT_TEMPLATE_ID).name
    ? action
    : `${action} (${agentName}) — Alt+click: plain terminal`
}
