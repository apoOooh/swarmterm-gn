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
}

/** One resumable-session row — shared between the composer's inline list and
 *  the all-sessions dialog so the two can never drift apart visually. */
export function SessionRow({
  session,
  ticked,
  disabled,
  onToggle
}: SessionRowProps): ReactElement {
  const accounts = useAgentAccountsStore(s => s.accounts)
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
      {(session.agentId === 'claude-code' || session.agentId === 'codex') && <span className="max-w-24 truncate text-xs text-muted-foreground" title="Account">{accountLabel(session.accountId, accounts)}</span>}
      <span className="shrink-0 text-xs text-muted-foreground">
        {sessionTimeLabel(session.updatedAtMs, Date.now())}
      </span>
    </label>
  )
}
