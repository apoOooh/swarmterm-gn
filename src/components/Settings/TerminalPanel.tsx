import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import { Check, Minus, Plus } from 'lucide-react'
import { platformShells, type ShellId, type ShellMeta } from '@/lib/terminal-pref'
import {
  MONO_FONTS,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  LINE_HEIGHT_MIN,
  LINE_HEIGHT_MAX,
  SCROLLBACK_CHOICES,
  customFontStack,
  primaryFamily,
  type TerminalTextPref,
  type WheelZoomMode
} from '@/lib/terminal-text'
import { useTerminalPrefStore } from '@/store/terminal-pref-store'
import { useTerminalTextStore } from '@/store/terminal-text-store'
import { useStatuslineStore } from '@/store/statusline-store'
import { useBuildPriorityStore } from '@/store/build-priority-store'
import type { PriorityLevel, PriorityMode } from '@/lib/build-priority'
import { useEnvPolicyStore } from '@/store/env-policy-store'
import { ignoredAllowEntries, parseAllowList, type EnvFilterMode } from '@/lib/env-policy'
import { ToggleRow } from './NotificationsPanel'
import { useAgentPrefStore } from '@/store/agent-pref-store'
import { useAgentAvailabilityStore } from '@/store/agent-availability-store'
import { setSavedPaneIds } from '@/store/saved-workspaces-store'
import { TEMPLATES, isTemplateAvailable, launchMode } from '@/lib/templates'
import { AgentIcon } from '@/components/AgentIcon'
import { DangerousModeDialog, type PendingDangerousMode } from '@/components/DangerousModeDialog'
import { isDangerousLaunchMode } from '@/lib/launch-mode-safety'
import { useAgentPolicyStore } from '@/store/agent-policy-store'
import { listAvailableShells, type AvailableShell } from '@/tauri/shell'
import {
  getTerminalHostSettings,
  getTerminalHostStatus,
  setTerminalHostSettings,
  type TerminalHostStatus
} from '@/tauri/terminal-host'
import { describeHostStatus } from '@/lib/terminal-host-status'
import {
  getHostStatusSnapshot,
  setHostStatus,
  subscribeHostStatus
} from '@/lib/host-status-store'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** The "Terminal" settings category — pick the shell new panes spawn with. */
export function TerminalPanel(): ReactElement {
  const shellId = useTerminalPrefStore((s) => s.shellId)
  const setShellId = useTerminalPrefStore((s) => s.setShellId)
  const [available, setAvailable] = useState<AvailableShell[] | null>(null)
  const [staleId, setStaleId] = useState<ShellId | null>(null)

  useEffect(() => {
    let cancelled = false
    listAvailableShells()
      .then((list) => {
        if (cancelled) return
        setAvailable(list)
        const match = list.find((s) => s.id === shellId)
        if (!match || !match.available) {
          setStaleId(shellId)
          setShellId('default')
        } else {
          // The persisted shell is valid — drop the banner from any previous run
          // in this session so it doesn't outlive its trigger condition.
          setStaleId(null)
        }
      })
      .catch((err) => {
        if (cancelled) return
        console.error('[TerminalPanel] listAvailableShells failed', err)
        setAvailable([])
      })
    return () => {
      cancelled = true
    }
  }, [shellId, setShellId])

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Terminal
        </h1>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted-foreground">
          Customise the terminal — text rendering, the shell each new pane
          starts with, and the AI provider a split opens.
        </p>
      </section>

      <TextSettings />

      {staleId && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          The shell <span className="font-mono font-semibold">{staleId}</span> isn't
          available anymore. Switched to <span className="font-semibold">Default</span>.
        </div>
      )}

      <section className="rounded-xl border border-border bg-card/40 p-5 sm:p-6">
        <div className="mb-4">
          <h2 className="text-sm font-semibold text-foreground">Shell</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Which shell each new pane starts with. Only affects new panes —
            running terminals keep their current shell.
          </p>
        </div>

        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(280px,1fr))]">
          {/* Only this platform's shells — a greyed "WSL" card on macOS is
              noise, but a greyed "fish — not detected" card is guidance. */}
          {platformShells(
            Object.fromEntries((available ?? []).map((s) => [s.id, s.available]))
          ).map((meta) => {
            const probe = available?.find((s) => s.id === meta.id)
            const detected = probe?.available ?? meta.id === 'default'
            return (
              <ShellCard
                key={meta.id}
                meta={meta}
                detected={detected}
                detectedPath={probe?.detectedPath}
                active={meta.id === shellId}
                onSelect={() => detected && setShellId(meta.id)}
              />
            )
          })}
        </div>
      </section>

      <DefaultAgentSettings />

      <DefaultLaunchModeSettings />

      <AgentSafetySettings />

      <BuildPrioritySettings />
      <EnvironmentSettings />
      <StatusLineSettings />
      <TerminalHostSettings />
    </div>
  )
}

/**
 * Global default AI provider: what the pane header's Split buttons open.
 * A workspace can override it from its navbar menu ("Split opens…").
 */
function DefaultAgentSettings(): ReactElement {
  const defaultAgentId = useAgentPrefStore((s) => s.defaultAgentId)
  const setDefaultAgentId = useAgentPrefStore((s) => s.setDefaultAgentId)
  const availability = useAgentAvailabilityStore((s) => s.availability)

  // Re-probe on open so a CLI installed while the app runs is selectable.
  useEffect(() => {
    void useAgentAvailabilityStore.getState().refresh()
  }, [])

  return (
    <section className="rounded-xl border border-border bg-card/40 p-5 sm:p-6">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-foreground">Default AI provider</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          What a split pane starts with. Workspaces can override this from their
          menu in the sidebar. Alt+click a split button for a plain terminal.
        </p>
      </div>

      <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(180px,1fr))]">
        {TEMPLATES.map((t) => {
          const available = isTemplateAvailable(t, availability)
          const active = t.id === defaultAgentId
          return (
            <button
              key={t.id}
              type="button"
              disabled={!available}
              aria-pressed={active}
              onClick={() => setDefaultAgentId(t.id)}
              className={cn(
                'flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2 text-left transition-colors',
                !available && 'cursor-not-allowed border-pane-border opacity-50',
                available && active && 'border-primary/50 ring-2 ring-primary/15',
                available && !active && 'border-pane-border hover:bg-muted/40'
              )}
            >
              <AgentIcon template={t} className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">{t.name}</span>
                {!available && <span className="block text-[11px] text-muted-foreground/70">Not installed</span>}
              </span>
              {active && <Check aria-hidden className="h-3.5 w-3.5 text-primary" strokeWidth={3} />}
            </button>
          )
        })}
      </div>
    </section>
  )
}

/**
 * Per-provider default launch mode: the permission/sandbox mode a fresh pane
 * of that agent starts in. Running panes keep the mode they spawned with; the
 * pane header's agent menu still switches a single pane.
 */
function DefaultLaunchModeSettings(): ReactElement {
  const prefs = useAgentPrefStore((s) => s.defaultLaunchModes)
  const setDefaultLaunchMode = useAgentPrefStore((s) => s.setDefaultLaunchMode)
  const agents = TEMPLATES.filter((t) => t.launchModes !== undefined && t.launchModes.length > 0)
  // Bypass / YOLO as the default for every new pane is confirmed first.
  const [pending, setPending] = useState<PendingDangerousMode | undefined>(undefined)
  // Settings owns the keyboard (no terminal to return to), so focus goes back
  // to the mode button that opened the dialog instead of falling to <body>.
  const trigger = useRef<HTMLElement | null>(null)
  const choose = (agentId: string, modeId: string, active: boolean, el: HTMLElement): void => {
    if (!active && isDangerousLaunchMode(agentId, modeId)) {
      trigger.current = el
      setPending({ agentId, modeId })
    } else setDefaultLaunchMode(agentId, modeId)
  }
  const close = (): void => {
    setPending(undefined)
    const el = trigger.current
    setTimeout(() => el?.focus(), 0)
  }

  return (
    <section className="rounded-xl border border-border bg-card/40 p-5 sm:p-6">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-foreground">Default launch mode</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          The mode a new pane of each provider starts in. Applies to new panes only;
          switch a running pane from its agent menu.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {agents.map((t) => {
          const activeId = launchMode(t.id, prefs[t.id])?.id
          return (
            <div key={t.id} className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <span className="flex w-36 shrink-0 items-center gap-2.5">
                <AgentIcon template={t} className="h-4 w-4 shrink-0" />
                <span className="truncate text-sm font-medium text-foreground">{t.name}</span>
              </span>
              <div className="flex flex-wrap gap-2">
                {t.launchModes!.map((m) => {
                  const active = m.id === activeId
                  return (
                    <button
                      key={m.id}
                      type="button"
                      aria-pressed={active}
                      onClick={(e) => choose(t.id, m.id, active, e.currentTarget)}
                      className={cn(
                        'flex items-center gap-1.5 rounded-lg border bg-card px-3 py-1.5 text-sm transition-colors',
                        active
                          ? 'border-primary/50 text-foreground ring-2 ring-primary/15'
                          : 'border-pane-border text-muted-foreground hover:bg-muted/40',
                        m.dangerous && 'text-red-500'
                      )}
                    >
                      {m.label}
                      {active && <Check aria-hidden className="h-3.5 w-3.5 text-primary" strokeWidth={3} />}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        Panes started by another agent (worktree.spawn) never start in a red mode: they fall back to this default, or
        to the provider's first mode if this default is red.
      </p>
      <DangerousModeDialog
        pending={pending}
        onCancel={close}
        onConfirm={() => {
          if (pending) setDefaultLaunchMode(pending.agentId, pending.modeId)
          close()
        }}
      />
    </section>
  )
}

/**
 * "Agent safety": what one agent may make other panes do. Stored here,
 * enforced in Rust (agent_policy.rs) so an agent cannot route around it.
 */
function AgentSafetySettings(): ReactElement {
  const policy = useAgentPolicyStore((s) => s.policy)
  const setPolicy = useAgentPolicyStore((s) => s.setPolicy)
  return (
    <section className="rounded-xl border border-border bg-card/40 p-5 sm:p-6">
      <h2 className="text-sm font-semibold text-foreground">Agent safety</h2>
      <div className="mt-4 grid gap-4">
        <ToggleRow
          label="Allow agents to run prompts in other panes"
          description={
            'War Room "execute": an agent pastes a prompt into another pane and runs it. Off: agents can only send ' +
            'messages (probe) that the other agent reads and decides on. Your own sends from the War Room are not affected. ' +
            'Not covered: the task prompt an agent gives a new worker pane it spawns (worktree.spawn), which always starts in a safe mode.'
          }
          checked={policy.allowWarRoomExecute}
          onChange={(on) => setPolicy({ allowWarRoomExecute: on })}
        />
      </div>
    </section>
  )
}

/**
 * The Claude Code status line toggle. Lives under Terminal rather than getting
 * its own category: it is one switch about what agent panes show, not a surface
 * of its own.
 */
function StatusLineSettings(): ReactElement {
  const enabled = useStatuslineStore((s) => s.enabled)
  const setEnabled = useStatuslineStore((s) => s.setEnabled)

  return (
    <section className="rounded-xl border border-border bg-card/40 p-5 sm:p-6">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-foreground">Agent status line</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Shows whether Claude Code reached Swarmterm&rsquo;s MCP server, plus the
          session&rsquo;s context usage, under the prompt in every Claude pane.
        </p>
      </div>

      <div className="flex items-start justify-between gap-3">
        <div>
          <span className="block text-xs font-medium text-muted-foreground">
            Manage Claude Code&rsquo;s status line
          </span>
          <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground/70">
            Writes a <span className="font-mono">statusLine</span> entry to{' '}
            <span className="font-mono">~/.claude/settings.json</span>. An existing
            custom status line is left untouched.
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Toggle Claude Code status line"
          onClick={() => void setEnabled(!enabled)}
          className={cn(
            'relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
            enabled ? 'bg-primary' : 'bg-muted'
          )}
        >
          <span
            aria-hidden
            className={cn(
              'absolute top-0.5 h-4 w-4 rounded-full bg-background transition-transform',
              enabled ? 'left-0.5 translate-x-4' : 'left-0.5'
            )}
          />
        </button>
      </div>
    </section>
  )
}

/** Terminal host status, fetched on mount and refreshed while mounted. */
function useHostStatus(): [
  TerminalHostStatus | null,
  (s: TerminalHostStatus | null) => void
] {
  const status = useSyncExternalStore(subscribeHostStatus, getHostStatusSnapshot)
  return [status, setHostStatus]
}

/**
 * Terminal host (SWA-55, ADR 0001 phase 2): new panes spawn in the separate
 * `swarmterm-host.exe` instead of inside the app. Off by default until
 * panes can survive a restart (phase 3/4); running panes keep their backend.
 */
function TerminalHostSettings(): ReactElement | null {
  const [status, setStatus] = useHostStatus()

  if (!status) return null
  const enabled = status.enabled

  const toggle = async (): Promise<void> => {
    try {
      const current = await getTerminalHostSettings()
      const next = await setTerminalHostSettings({ ...current, enabled: !enabled })
      setSavedPaneIds(next.enabled)
      setStatus(await getTerminalHostStatus())
    } catch (err) {
      console.error('[TerminalPanel] terminal host switch failed', err)
    }
  }

  return (
    <section className="rounded-xl border border-border bg-card/40 p-5 sm:p-6">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-foreground">Terminal host (preview)</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Runs new panes in a separate background process instead of inside
          Swarmterm. Groundwork for keeping terminals alive across a restart;
          today it behaves like the built-in terminals.
        </p>
      </div>

      <div className="flex items-start justify-between gap-3">
        <div>
          <span className="block text-xs font-medium text-muted-foreground">
            Run new panes in the terminal host
          </span>
          <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground/70">
            {describeHostStatus(status)} Open panes keep running where they started.
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Toggle terminal host"
          disabled={!status.supported}
          onClick={() => void toggle()}
          className={cn(
            'relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50',
            enabled ? 'bg-primary' : 'bg-muted'
          )}
        >
          <span
            aria-hidden
            className={cn(
              'absolute top-0.5 h-4 w-4 rounded-full bg-background transition-transform',
              enabled ? 'left-0.5 translate-x-4' : 'left-0.5'
            )}
          />
        </button>
      </div>
    </section>
  )
}

interface ShellCardProps {
  meta: ShellMeta
  detected: boolean
  detectedPath?: string
  active: boolean
  onSelect: () => void
}

function ShellCard({
  meta,
  detected,
  detectedPath,
  active,
  onSelect
}: ShellCardProps): ReactElement {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={!detected}
      aria-pressed={active}
      aria-disabled={!detected}
      className={cn(
        'flex flex-col gap-3 rounded-lg border bg-card p-3 text-left transition-colors',
        !detected && 'cursor-not-allowed opacity-50',
        detected && active && 'border-primary/50 ring-2 ring-primary/15',
        detected && !active && 'border-pane-border hover:border-pane-border/80 hover:bg-muted/40',
        !detected && 'border-pane-border'
      )}
    >
      <div className="relative">
        <ShellPreview promptSample={meta.promptSample} active={active} />
        {active && detected && (
          <span
            aria-hidden
            className="absolute right-2 top-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm"
          >
            <Check className="h-3 w-3" strokeWidth={3} />
          </span>
        )}
      </div>
      <div className="min-w-0 px-0.5">
        <div className="text-sm font-medium text-foreground">{meta.label}</div>
        {detected ? (
          <>
            <div className="mt-0.5 text-xs text-muted-foreground">{meta.family}</div>
            {detectedPath && (
              <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/80">
                {detectedPath}
              </div>
            )}
          </>
        ) : (
          <div className="mt-0.5 text-xs text-muted-foreground/70">Not installed</div>
        )}
      </div>
    </button>
  )
}

interface ShellPreviewProps {
  promptSample: string
  active: boolean
}

function ShellPreview({ promptSample, active }: ShellPreviewProps): ReactElement {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-canvas">
      <div className="flex items-center gap-1.5 border-b border-border bg-muted/40 px-2.5 py-1.5">
        <span className="h-2 w-2 rounded-full bg-muted-foreground/40" />
        <span className="h-2 w-2 rounded-full bg-muted-foreground/40" />
        <span className="h-2 w-2 rounded-full bg-muted-foreground/40" />
        <span className="ml-1.5 font-mono text-[10px] text-muted-foreground/70">shell</span>
      </div>
      <div className="flex flex-col gap-1 px-3 py-3 font-mono text-[10px] leading-tight">
        <div className="text-foreground/85">{promptSample}</div>
        <div className="flex items-center pt-0.5">
          <span className="text-muted-foreground/60">{promptSample.slice(0, 1) || '$'}</span>
          <span
            className={cn(
              'ml-1.5 inline-block h-2.5 w-1.5 bg-foreground/80',
              active && 'animate-pulse'
            )}
            aria-hidden
          />
        </div>
      </div>
    </div>
  )
}

/** The "Text" settings group: font, size, line height, ligatures + preview. */
function TextSettings(): ReactElement {
  const text = useTerminalTextStore((s) => s.text)
  const setFontFamily = useTerminalTextStore((s) => s.setFontFamily)
  const setFontSize = useTerminalTextStore((s) => s.setFontSize)
  const setLineHeight = useTerminalTextStore((s) => s.setLineHeight)
  const setLigatures = useTerminalTextStore((s) => s.setLigatures)
  const setWheelZoom = useTerminalTextStore((s) => s.setWheelZoom)
  const setScrollback = useTerminalTextStore((s) => s.setScrollback)
  const reset = useTerminalTextStore((s) => s.reset)

  const matched = MONO_FONTS.find((f) => f.stack === text.fontFamily)
  const [customMode, setCustomMode] = useState(!matched)
  const [customDraft, setCustomDraft] = useState(matched ? '' : primaryFamily(text.fontFamily))

  const isCustom = customMode || !matched
  const selectValue = isCustom ? 'custom' : matched!.id

  function onSelectFont(id: string): void {
    if (id === 'custom') {
      setCustomMode(true)
      setCustomDraft(primaryFamily(text.fontFamily))
      return
    }
    setCustomMode(false)
    const font = MONO_FONTS.find((f) => f.id === id)
    if (font) setFontFamily(font.stack)
  }

  function onCustomChange(value: string): void {
    // Stay in custom mode while editing — clearing the field is allowed and
    // simply falls back to the system font without yanking the input away.
    setCustomDraft(value)
    setFontFamily(customFontStack(value))
  }

  function onReset(): void {
    setCustomMode(false)
    setCustomDraft('')
    reset()
  }

  return (
    <section className="rounded-xl border border-border bg-card/40 p-5 sm:p-6">
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Text</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Font and rendering for every terminal pane. Applies live to open
            terminals.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onReset} className="shrink-0">
          Reset to default
        </Button>
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <div className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Font</span>
            <select
              value={selectValue}
              onChange={(e) => onSelectFont(e.target.value)}
              className="w-full rounded-md border border-pane-border bg-card px-2.5 py-1.5 text-sm text-foreground"
            >
              {MONO_FONTS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label} · {f.platform}
                  {f.ligatures ? ' · ligatures' : ''}
                </option>
              ))}
              <option value="custom">Custom…</option>
            </select>
          </label>

          {isCustom && (
            <input
              type="text"
              value={customDraft}
              placeholder="Font family name"
              onChange={(e) => onCustomChange(e.target.value)}
              className="w-full rounded-md border border-pane-border bg-card px-2.5 py-1.5 text-sm text-foreground"
            />
          )}

          <Stepper
            label="Size"
            value={`${text.fontSize} px`}
            onDec={() => setFontSize(text.fontSize - 1)}
            onInc={() => setFontSize(text.fontSize + 1)}
            atMin={text.fontSize <= FONT_SIZE_MIN}
            atMax={text.fontSize >= FONT_SIZE_MAX}
          />

          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Ctrl + scroll zoom</span>
            <select
              value={text.wheelZoom}
              onChange={(e) => setWheelZoom(e.target.value as WheelZoomMode)}
              className="w-full rounded-md border border-pane-border bg-card px-2.5 py-1.5 text-sm text-foreground"
            >
              <option value="pane">Pane under the mouse</option>
              <option value="global">All panes (changes Size)</option>
              <option value="off">Off</option>
            </select>
            <span className="mt-1 block text-[11px] leading-snug text-muted-foreground/70">
              Hold Ctrl and scroll over a terminal. Ctrl+0 resets.
            </span>
          </label>

          <Stepper
            label="Line height"
            value={text.lineHeight.toFixed(1)}
            onDec={() => setLineHeight(text.lineHeight - 0.1)}
            onInc={() => setLineHeight(text.lineHeight + 0.1)}
            atMin={text.lineHeight <= LINE_HEIGHT_MIN}
            atMax={text.lineHeight >= LINE_HEIGHT_MAX}
          />

          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Scrollback</span>
            <select
              value={String(text.scrollback)}
              onChange={(e) => setScrollback(Number(e.target.value))}
              className="w-full rounded-md border border-pane-border bg-card px-2.5 py-1.5 text-sm text-foreground"
            >
              {SCROLLBACK_CHOICES.includes(text.scrollback) ? null : (
                <option value={String(text.scrollback)}>{text.scrollback.toLocaleString()} lines</option>
              )}
              {SCROLLBACK_CHOICES.map((n) => (
                <option key={n} value={String(n)}>{n.toLocaleString()} lines</option>
              ))}
            </select>
            <span className="mt-1 block text-[11px] leading-snug text-muted-foreground/70">
              Lines kept per pane. More lines cost more memory in every pane.
            </span>
          </label>

          <div className="flex items-start justify-between gap-3">
            <div>
              <span className="block text-xs font-medium text-muted-foreground">Ligatures</span>
              <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground/70">
                Needs a ligature font (Cascadia Code, JetBrains Mono, Fira Code).
                Joins within same-colour text.
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={text.ligatures}
              aria-label="Toggle ligatures"
              onClick={() => setLigatures(!text.ligatures)}
              className={cn(
                'relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
                text.ligatures ? 'bg-primary' : 'bg-muted'
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'absolute top-0.5 h-4 w-4 rounded-full bg-background transition-transform',
                  text.ligatures ? 'left-0.5 translate-x-4' : 'left-0.5'
                )}
              />
            </button>
          </div>
        </div>

        <TextPreview text={text} />
      </div>
    </section>
  )
}

interface StepperProps {
  label: string
  value: string
  onDec: () => void
  onInc: () => void
  atMin: boolean
  atMax: boolean
}

function Stepper({ label, value, onDec, onInc, atMin, atMax }: StepperProps): ReactElement {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="icon-sm" onClick={onDec} disabled={atMin} aria-label={`Decrease ${label}`}>
          <Minus className="h-3 w-3" />
        </Button>
        <span className="w-14 text-center text-sm tabular-nums text-foreground">{value}</span>
        <Button variant="outline" size="icon-sm" onClick={onInc} disabled={atMax} aria-label={`Increase ${label}`}>
          <Plus className="h-3 w-3" />
        </Button>
      </div>
    </div>
  )
}

const PREVIEW_CODE = 'const ok = (a >= b) => a !== b;'
const PREVIEW_GLYPHS = '// 0O 1lI -> |> == === !='

/** Live sample of the chosen text settings, rendered via inline style. */
function TextPreview({ text }: { text: TerminalTextPref }): ReactElement {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-canvas">
      <div className="flex items-center gap-1.5 border-b border-border bg-muted/40 px-2.5 py-1.5">
        <span className="h-2 w-2 rounded-full bg-muted-foreground/40" />
        <span className="h-2 w-2 rounded-full bg-muted-foreground/40" />
        <span className="h-2 w-2 rounded-full bg-muted-foreground/40" />
        <span className="ml-1.5 font-mono text-[10px] text-muted-foreground/70">preview</span>
      </div>
      <div
        className="flex flex-col gap-1 px-3 py-3"
        style={{
          fontFamily: text.fontFamily,
          fontSize: `${text.fontSize}px`,
          lineHeight: text.lineHeight,
          fontFeatureSettings: text.ligatures ? '"liga" 1, "calt" 1' : 'normal'
        }}
      >
        <span className="text-foreground/85">{PREVIEW_CODE}</span>
        <span className="text-muted-foreground">{PREVIEW_GLYPHS}</span>
      </div>
    </div>
  )
}

const PRIORITY_MODES: { id: PriorityMode; label: string; description: string }[] = [
  {
    id: 'strict',
    label: 'Strict (recommended)',
    description:
      'Everything in a pane, the agent included, runs below normal from the moment it starts; builds and tools an agent starts run lower still. Windows enforces it, so no process in the pane can raise itself back.'
  },
  {
    id: 'agent-normal',
    label: 'Agent at normal',
    description:
      'The shell and the agent keep normal priority; everything the agent starts runs at the build level. Tools in an unrecognised agent may stay normal.'
  },
  { id: 'off', label: 'Off', description: 'No limits: everything runs at normal priority.' }
]

const PRIORITY_LEVELS: { id: PriorityLevel; label: string }[] = [
  { id: 'below-normal', label: 'Below normal' },
  { id: 'idle', label: 'Low (idle)' }
]

const SELECT_CLASS = 'w-full rounded-md border border-pane-border bg-card px-2.5 py-1.5 text-sm text-foreground disabled:opacity-50'

/** "Process priority" — Job Object limits for everything a pane runs (ADR 0005). */
function BuildPrioritySettings(): ReactElement {
  const p = useBuildPriorityStore((s) => s.priority)
  const setPriority = useBuildPriorityStore((s) => s.setPriority)
  const off = p.mode === 'off'
  const mode = PRIORITY_MODES.find((m) => m.id === p.mode) ?? PRIORITY_MODES[0]
  const [capDraft, setCapDraft] = useState<number | null>(null)
  const [hostStatus] = useHostStatus()
  const hostNote = hostStatus?.enabled ? hostStatus.priorityUnsupported : null
  const commitCap = (): void => {
    if (capDraft !== null && capDraft !== p.cpuCap) setPriority({ cpuCap: capDraft })
    setCapDraft(null)
  }
  return (
    <section className="rounded-xl border border-border bg-card/40 p-5 sm:p-6">
      <h2 className="text-sm font-semibold text-foreground">Process priority</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Keeps heavy builds and tools started in a pane from making Windows unresponsive. Applies live to running
        panes. A workspace can opt out from its ⋮ menu.
      </p>
      {hostNote && <p className="mt-2 text-xs text-amber-500">{hostNote}</p>}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Mode</span>
          <select
            value={p.mode}
            onChange={(e) => setPriority({ mode: e.target.value as PriorityMode })}
            className={SELECT_CLASS}
          >
            {PRIORITY_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <span className="mt-1.5 block text-xs text-muted-foreground">{mode.description}</span>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Pane priority (strict)</span>
          <select
            value={p.paneLevel}
            disabled={p.mode !== 'strict'}
            onChange={(e) => setPriority({ paneLevel: e.target.value as PriorityLevel })}
            className={SELECT_CLASS}
          >
            {PRIORITY_LEVELS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Builds and tools an agent starts</span>
          <select
            value={p.buildLevel}
            disabled={off}
            onChange={(e) => setPriority({ buildLevel: e.target.value as PriorityLevel })}
            className={SELECT_CLASS}
          >
            {PRIORITY_LEVELS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <div className="sm:col-span-2">
          <ToggleRow
            label="Cap CPU per pane"
            description="Hard limit on the share of the whole machine one pane may use, even when the CPU is otherwise idle."
            checked={!off && p.cpuCap !== null}
            onChange={(on) => setPriority({ cpuCap: on ? 50 : null })}
          />
          {!off && p.cpuCap !== null && (
            <label className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
              <input
                type="range"
                min={5}
                max={95}
                step={5}
                value={capDraft ?? p.cpuCap}
                // Dragging only moves the draft; the value is committed on
                // release, so one drag is one push to every pane's job.
                onChange={(e) => setCapDraft(Number(e.target.value))}
                onPointerUp={commitCap}
                onKeyUp={commitCap}
                onBlur={commitCap}
                className="flex-1"
                aria-label="CPU cap per pane"
              />
              <span className="w-10 text-right tabular-nums text-foreground">{capDraft ?? p.cpuCap} %</span>
            </label>
          )}
        </div>
      </div>
    </section>
  )
}

const ENV_MODES: { id: EnvFilterMode; label: string; description: string }[] = [
  {
    id: 'default',
    label: 'Hide secrets',
    description: 'Passes everything except names that look like secrets (API keys, tokens, passwords, AWS_*, ANTHROPIC_*, OPENAI_*).'
  },
  {
    id: 'strict',
    label: 'System variables only',
    description: 'Passes only the Windows variables a shell needs (PATH, SystemRoot, TEMP, USERPROFILE, …) plus the list below.'
  }
]

/** "Environment" — what panes and command routines inherit from Swarmterm's own environment. */
function EnvironmentSettings(): ReactElement {
  const policy = useEnvPolicyStore((s) => s.policy)
  const setPolicy = useEnvPolicyStore((s) => s.setPolicy)
  const [allowDraft, setAllowDraft] = useState<string | null>(null)
  const mode = ENV_MODES.find((m) => m.id === policy.mode) ?? ENV_MODES[0]
  // Every edit is stored at once (nothing is lost if Settings closes while
  // the box has focus); the raw text stays as the draft until blur so
  // parsing never rewrites what is being typed.
  const editAllow = (text: string): void => {
    setAllowDraft(text)
    setPolicy({ allow: parseAllowList(text) })
  }
  const ignored = allowDraft === null ? [] : ignoredAllowEntries(allowDraft)
  return (
    <section className="rounded-xl border border-border bg-card/40 p-5 sm:p-6">
      <h2 className="text-sm font-semibold text-foreground">Environment</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        What new panes and command routines inherit from Swarmterm's own environment. Agents keep their own logins;
        running panes keep the environment they started with.
      </p>
      <div className="mt-4 grid gap-4">
        <ToggleRow
          label="Pass secrets from Swarmterm's environment to panes"
          description="Off: API keys, tokens and passwords Swarmterm was started with are withheld from panes."
          checked={policy.passSecrets}
          onChange={(on) => setPolicy({ passSecrets: on })}
        />
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Filter</span>
          <select
            value={policy.mode}
            disabled={policy.passSecrets}
            onChange={(e) => setPolicy({ mode: e.target.value as EnvFilterMode })}
            className={SELECT_CLASS}
          >
            {ENV_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <span className="mt-1.5 block text-xs text-muted-foreground">{mode.description}</span>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Always pass these variables</span>
          <textarea
            value={allowDraft ?? policy.allow.join('\n')}
            disabled={policy.passSecrets}
            onChange={(e) => editAllow(e.target.value)}
            onBlur={() => setAllowDraft(null)}
            rows={3}
            spellCheck={false}
            placeholder={'MY_SERVICE_TOKEN\nHTTP_PROXY\nMY_TOOL_*'}
            className="w-full rounded-md border border-pane-border bg-card px-2.5 py-1.5 font-mono text-xs text-foreground disabled:opacity-50"
            aria-label="Always pass these variables"
          />
          <span className="mt-1.5 block text-xs text-muted-foreground">
            One name per line (or comma-separated), case-insensitive; a trailing * matches a prefix. Add the
            variables an agent logs in with (for example ANTHROPIC_API_KEY) if it does not use its own login.
          </span>
          {ignored.length > 0 && (
            <span className="mt-1 block text-xs text-amber-500">Not variable names, ignored: {ignored.join(', ')}</span>
          )}
        </label>
      </div>
    </section>
  )
}
