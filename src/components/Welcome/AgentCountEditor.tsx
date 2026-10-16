import type { Dispatch, ReactElement, SetStateAction } from 'react'
import { Minus, Plus } from 'lucide-react'
import { TEMPLATES, isTemplateAvailable, templateById } from '@/lib/templates'
import { TERMINAL_COUNTS } from '@/lib/layout-tree'
import { clampCounts } from '@/lib/agent-allocation'
import type { AccountSelection } from '@/lib/agent-accounts'
import { useAgentAvailabilityStore } from '@/store/agent-availability-store'
import { useAgentAccountsStore } from '@/store/agent-accounts-store'
import { AgentIcon } from '@/components/AgentIcon'
import { cn } from '@/lib/utils'

/** Templates that run an AI agent CLI. Plain Terminal (command: null) is
 *  excluded here because it fills the remainder automatically via allocateAgents. */
const CODING_TEMPLATES = TEMPLATES.filter((t) => t.command !== null)

interface AgentCountEditorProps {
  terminalCount: number
  setTerminalCount: (n: number) => void
  counts: Record<string, number>
  setCounts: Dispatch<SetStateAction<Record<string, number>>>
  accountSelections: Record<string, AccountSelection>
  setAccountSelections: Dispatch<SetStateAction<Record<string, AccountSelection>>>
  /** Panes added on top of terminalCount (resumed sessions) — they count toward the 12 cap. */
  extraPanes?: number
}

/**
 * "How many terminals?" tiles plus one stepper row per AI agent. Shared by the
 * new-workspace composer and the workspace defaults / templates editor.
 */
export function AgentCountEditor({
  terminalCount,
  setTerminalCount,
  counts,
  setCounts: setRawCounts,
  accountSelections,
  setAccountSelections,
  extraPanes = 0
}: AgentCountEditorProps): ReactElement {
  const availability = useAgentAvailabilityStore((s) => s.availability)
  const accounts = useAgentAccountsStore((s) => s.accounts)
  // Uninstalled agents have no row, so their counts must not take slots,
  // block the stepper cap, or survive the next edit invisibly.
  const visibleOnly = (c: Record<string, number>): Record<string, number> =>
    Object.fromEntries(Object.entries(c).filter(([id]) => isTemplateAvailable(templateById(id), availability)))
  const totalAssigned = Object.values(visibleOnly(counts)).reduce((a, b) => a + b, 0)
  const setCounts = (next: SetStateAction<Record<string, number>>): void =>
    setRawCounts((prev) => {
      const visible = visibleOnly(prev)
      return typeof next === 'function' ? next(visible) : next
    })
  const maxTiles = TERMINAL_COUNTS[TERMINAL_COUNTS.length - 1] // 12

  const changeTerminalCount = (next: number): void => {
    setTerminalCount(next)
    // Clamp assigned counts so they never exceed the new terminal total.
    setCounts((c) => clampCounts(c, next))
  }

  return (
    <>
      {/* How many terminals? */}
      <div className="mb-4">
        <p className="mb-2 text-sm font-medium text-foreground">How many terminals?</p>
        <div className="flex flex-wrap gap-1.5">
          {TERMINAL_COUNTS.map((count) => {
            const selected = count === terminalCount
            // Both sides of the 12-pane cap are enforced at the control that
            // would breach it (this tile picker, and the session checkboxes
            // via canTickMore) — so the total pane count can never exceed
            // maxTiles and createWorkspace never needs its own clamp.
            const disabled = count + extraPanes > maxTiles
            return (
              <button
                key={count}
                type="button"
                onClick={() => changeTerminalCount(count)}
                aria-pressed={selected}
                disabled={disabled}
                className={cn(
                  'flex h-9 min-w-[2.25rem] items-center justify-center rounded-md border px-2 text-sm font-medium transition-colors',
                  selected
                    ? 'border-ring bg-accent text-foreground ring-1 ring-ring'
                    : 'border-border text-muted-foreground hover:border-ring/50 hover:bg-accent/40 hover:text-foreground',
                  disabled && 'cursor-not-allowed opacity-40'
                )}
              >
                {count}
              </button>
            )
          })}
        </div>
      </div>

      {/* AI agents — one stepper row per coding template; plain Terminal
          fills the remaining slots automatically via allocateAgents. */}
      <div className="mb-4">
        <div className="mb-1.5 flex items-center justify-between">
          <p className="text-sm font-medium text-foreground">AI agents</p>
          <span className="text-xs text-muted-foreground">
            used {totalAssigned} / {terminalCount}
          </span>
        </div>
        {/* The roster outgrew the dialog: cap the list and scroll —
            max-h-64 ≈ 9 stepper rows at the common window size. */}
        <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
          {/* Only installed agents are offered; a CLI still being probed counts
              as installed until the probe says otherwise. */}
          {CODING_TEMPLATES.filter((t) => isTemplateAvailable(t, availability)).map((t) => {
            const count = counts[t.id] ?? 0
            // Full when every slot is allocated; block adding more until
            // the user either increases the terminal count or reduces another agent.
            const atCapacity = totalAssigned >= terminalCount
            return (
              <div key={t.id} className="flex items-center gap-2">
                <AgentIcon template={t} className="h-4 w-4 shrink-0" />
                <span className="flex-1 text-sm text-foreground">{t.name}</span>
                {(t.id === 'claude-code' || t.id === 'codex') && <select aria-label={`${t.name} account`} className="max-w-36 rounded border border-input bg-background px-1 text-xs" value={accountSelections[t.id]?.mode === 'round-robin' ? '__round-robin__' : (accountSelections[t.id] as { accountId?: string } | undefined)?.accountId ?? ''} onChange={event => setAccountSelections(previous => ({ ...previous, [t.id]: event.target.value === '__round-robin__' ? { mode: 'round-robin' } : { mode: 'fixed', accountId: event.target.value || undefined } }))}>
                  <option value="">Default account</option>
                  {accounts.filter(account => account.agentId === t.id).map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
                  <option value="__round-robin__">Round robin</option>
                </select>}

                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      aria-label={`Remove one ${t.name}`}
                      disabled={count === 0}
                      onClick={() =>
                        setCounts((prev) => {
                          const next = { ...prev }
                          const n = (next[t.id] ?? 0) - 1
                          if (n <= 0) delete next[t.id]
                          else next[t.id] = n
                          return next
                        })
                      }
                      className={cn(
                        'flex h-6 w-6 items-center justify-center rounded border border-border text-muted-foreground transition-colors',
                        count === 0
                          ? 'cursor-not-allowed opacity-40'
                          : 'hover:border-ring/50 hover:bg-accent/40 hover:text-foreground'
                      )}
                    >
                      <Minus className="h-3 w-3" />
                    </button>
                    <input
                      type="number"
                      inputMode="numeric"
                      value={count}
                      min={0}
                      aria-label={`${t.name} count`}
                      onChange={(e) => {
                        const parsed = parseInt(e.target.value, 10)
                        const newVal = isNaN(parsed) ? 0 : parsed
                        const remaining = terminalCount - totalAssigned
                        const maxForThis = count + Math.max(0, remaining)
                        const clamped = Math.max(0, Math.min(newVal, maxForThis))
                        setCounts((prev) => {
                          const next = { ...prev }
                          if (clamped <= 0) delete next[t.id]
                          else next[t.id] = clamped
                          return next
                        })
                      }}
                      className="w-[3ch] rounded border border-input bg-background px-1 text-center text-sm tabular-nums text-foreground outline-none focus:ring-1 focus:ring-ring [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                    <button
                      type="button"
                      aria-label={`Add one ${t.name}`}
                      disabled={atCapacity}
                      onClick={() =>
                        setCounts((prev) => ({ ...prev, [t.id]: (prev[t.id] ?? 0) + 1 }))
                      }
                      className={cn(
                        'flex h-6 w-6 items-center justify-center rounded border border-border text-muted-foreground transition-colors',
                        atCapacity
                          ? 'cursor-not-allowed opacity-40'
                          : 'hover:border-ring/50 hover:bg-accent/40 hover:text-foreground'
                      )}
                    >
                      <Plus className="h-3 w-3" />
                    </button>
                  </div>
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}
