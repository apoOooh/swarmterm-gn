import { useEffect, useRef, useState } from 'react'
import { Folder, Terminal as ShellIcon, Check, Columns2, Rows2, Radio, X, GitBranch, History, Maximize2, Minimize2 } from 'lucide-react'
import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core'
import { AgentIcon } from '@/components/AgentIcon'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem
} from '@/components/ui/dropdown-menu'
import { TEMPLATES, templateById, isTemplateAvailable, launchMode } from '@/lib/templates'
import { resolvePaneTitle } from '@/lib/pane-title'
import { useAgentAvailabilityStore } from '@/store/agent-availability-store'
import { KNOWN_SHELLS, visibleShells, type ShellId } from '@/lib/terminal-pref'
import { useShellAvailabilityStore } from '@/store/shell-availability-store'
import { resolveHeaderLevel, shortenPath, type HeaderLevel } from '@/lib/header-layout'
import { contextBand, contextUsageTitle, formatContextUsage, type ContextBand } from '@/lib/context-usage'
import { cn } from '@/lib/utils'

interface PaneHeaderProps {
  /** Resolved agent id (leaf override already applied). */
  agentId: string
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
  onSplitRight: () => void
  onSplitDown: () => void
  onClose: () => void
  isZoomed: boolean
  onToggleZoom: () => void
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

/**
 * The per-pane header. Priority-ordered and responsive: the title (agent-set or
 * agent-name fallback) is the star and soaks up free space, while folder / shell
 * / worktree chips collapse to icons as the pane narrows — see
 * `resolveHeaderLevel`. A ResizeObserver on the header row drives the level.
 */
export function PaneHeader(props: PaneHeaderProps): React.ReactElement {
  const { agentId, shellId, resolvedCwd, hasCwdOverride, worktreeBranch, ctxPct } = props
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

  // Measure the header row and resolve which chips render at full detail. Start
  // wide so the first paint isn't over-collapsed before the observer fires.
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [level, setLevel] = useState<HeaderLevel>(() =>
    resolveHeaderLevel(9999, Boolean(worktreeBranch))
  )
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? el.clientWidth
      // Bail out to the same object when the resolved level is unchanged —
      // otherwise every resize tick during a divider drag re-renders the header.
      setLevel((prev) => {
        const next = resolveHeaderLevel(width, Boolean(worktreeBranch))
        return prev.showFolderPath === next.showFolderPath &&
          prev.showShellLabel === next.showShellLabel &&
          prev.worktree === next.worktree
          ? prev
          : next
      })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [worktreeBranch])

  // Compose the dnd activator ref with our measure ref — the header row is both
  // the drag handle and the element we size against.
  const setRootRef = (el: HTMLDivElement | null): void => {
    props.dragHandleRef(el)
    rootRef.current = el
  }

  return (
    <div
      ref={setRootRef}
      {...props.dragAttributes}
      {...props.dragListeners}
      // dnd-kit stamps tabIndex 0 on its drag nodes. Keep the header out of the
      // tab order: it has no keyboard action, and a Tab meant for the shell must
      // never park the focus ring on app chrome (see lib/terminal-focus.ts).
      tabIndex={-1}
      // Double-click on bare header space zooms; controls keep their own clicks.
      onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest('button, [role="menuitem"], input')) props.onToggleZoom() }}
      className="pane-header flex h-7 shrink-0 cursor-grab items-center gap-0.5 border-b border-border bg-card px-1.5 active:cursor-grabbing"
    >
      {/* Agent — pinned far-left identity, never collapses. */}
      <div className="flex items-center" data-no-dnd>
        <DropdownMenu
          onOpenChange={(open) => {
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

      {/* Title — the star. flex-1 soaks free space; truncates last. Draggable. */}
      <span className="min-w-0 flex-1 truncate px-1 text-xs text-foreground" title={titleTooltip}>
        {displayTitle}
      </span>

      {/* Folder + shell — labels collapse to icons as width shrinks. */}
      <div className="flex items-center gap-0.5" data-no-dnd>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-1.5 text-muted-foreground"
              title={`Folder: ${resolvedCwd}`}
              aria-label={`Folder: ${resolvedCwd}`}
            >
              <Folder className="h-3.5 w-3.5 shrink-0" />
              {level.showFolderPath && (
                <span className="max-w-[8rem] truncate text-[11px]">{shortenPath(resolvedCwd)}</span>
              )}
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

        <DropdownMenu
          onOpenChange={(open) => {
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
              className="h-6 gap-1 px-1.5 text-muted-foreground"
              title={`Shell: ${shellLabel}`}
              aria-label={`Shell: ${shellLabel}`}
            >
              <ShellIcon className="h-3.5 w-3.5 shrink-0" />
              {level.showShellLabel && <span className="text-[11px]">{shellLabel}</span>}
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
      </div>

      {/* Worktree — lowest priority: full name → truncated → icon-only → hidden. */}
      {worktreeBranch && level.worktree !== 'hidden' && (
        <span
          title={`Worktree branch: ${worktreeBranch}`}
          className="flex min-w-0 items-center gap-1 rounded bg-accent px-1.5 py-0.5 text-[11px] text-muted-foreground"
        >
          <GitBranch className="h-3 w-3 shrink-0" />
          {level.worktree !== 'icon' && (
            <span className={cn('truncate', level.worktree === 'name-trunc' ? 'max-w-[5rem]' : 'max-w-[10rem]')}>
              {worktreeBranch}
            </span>
          )}
        </span>
      )}

      {/* Context usage — Claude Code's own status-line number mirrored into the
          chrome. Rides the folder-path threshold so narrow panes stay exactly as
          they were; tabular-nums so the width does not jitter every turn. */}
      {ctxPct !== undefined && level.showFolderPath && (
        <span
          title={contextUsageTitle(ctxPct)}
          className={cn(
            'flex shrink-0 items-center rounded bg-accent px-1.5 py-0.5 text-[11px] tabular-nums',
            CTX_BAND_CLASS[contextBand(ctxPct)]
          )}
        >
          {formatContextUsage(ctxPct)}
        </span>
      )}

      {/* Actions — unchanged cluster, far right. */}
      <div className="flex items-center gap-0.5" data-no-dnd>
        {props.broadcastActive && (
          <Button
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
        )}
        <Button variant="ghost" size="icon-sm" title="Split right" aria-label="Split right" onClick={props.onSplitRight}>
          <Columns2 className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon-sm" title="Split down" aria-label="Split down" onClick={props.onSplitDown}>
          <Rows2 className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon-sm" title={props.isZoomed ? 'Restore pane (Ctrl+Shift+Enter)' : 'Maximize pane (Ctrl+Shift+Enter)'} aria-label={props.isZoomed ? 'Restore pane' : 'Maximize pane'} aria-pressed={props.isZoomed} onClick={props.onToggleZoom}>
          {props.isZoomed ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </Button>
        <Button variant="ghost" size="icon-sm" title="Close pane" aria-label="Close pane" onClick={props.onClose}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}
