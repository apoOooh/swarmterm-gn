import type { ReactElement } from 'react'
import { AgentIcon } from '@/components/AgentIcon'
import { templateById } from '@/lib/templates'
import { sessionTimeLabel, type AgentSessionEntry } from '@/lib/agent-sessions'
import { useAgentAccountsStore } from '@/store/agent-accounts-store'
import { accountLabel } from '@/lib/agent-accounts'
import { cn } from '@/lib/utils'

interface SessionRowProps {
  session: AgentSessionEntry
  ticked: boolean
  /** True when the 12-pane cap is reached and this row isn't already ticked. */
  disabled: boolean
  onToggle: () => void
  /** Chosen subscription (SWA-64): `null` = default, undefined = unchanged. */
  target?: string | null
  onTargetChange?: (accountId: string | null) => void
}

/** One resumable-session row — shared between the composer's inline list and
 *  the all-sessions dialog so the two can never drift apart visually. */
export function SessionRow({
  session,
  ticked,
  disabled,
  onToggle,
  target,
  onTargetChange
}: SessionRowProps): ReactElement {
  const accounts = useAgentAccountsStore(s => s.accounts)
  const profiles = accounts.filter(a => a.agentId === session.agentId)
  return (
    <label
      className={cn(
        'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent',
        disabled && 'cursor-not-allowed opacity-50'
      )}
    >
      <input
        type="checkbox"
        checked={ticked}
        disabled={disabled}
        onChange={onToggle}
        className="h-3.5 w-3.5 shrink-0 accent-primary"
      />
      <AgentIcon template={templateById(session.agentId)} className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-sm text-foreground" title={session.title}>
        {session.title}
      </span>
      {(session.agentId === 'claude-code' || session.agentId === 'codex') && (
        ticked && onTargetChange && profiles.length > 0
          // A ticked row picks the subscription it resumes under; another
          // one gets a copy of the session first (the original stays).
          ? <select
              aria-label="Open in subscription"
              title="Open in subscription — the session is copied there if it differs"
              value={(target === undefined ? session.accountId : target ?? undefined) ?? ''}
              onChange={e => onTargetChange(e.target.value === '' ? null : e.target.value)}
              onClick={e => e.stopPropagation()}
              className="max-w-28 truncate rounded border border-input bg-background px-1 text-xs text-foreground"
            >
              <option value="">Default</option>
              {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          : <span className="max-w-24 truncate text-xs text-muted-foreground" title="Account">{accountLabel(session.accountId, accounts)}</span>
      )}
      <span className="shrink-0 text-xs text-muted-foreground">
        {sessionTimeLabel(session.updatedAtMs, Date.now())}
      </span>
    </label>
  )
}
