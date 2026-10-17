import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useModalFocus } from '@/components/ui/use-modal-focus'
import { threadItems, threadTime } from '@/lib/thread-view'
import { readAgentThread, type AgentThread } from '@/tauri/sessions'
import { cn } from '@/lib/utils'
import { latestRequest } from '@/lib/listener-cleanup'

interface ThreadDialogProps {
  open: boolean
  onClose: () => void
  terminalId: string
  agentId: string
  agentName: string
  accountId?: string
  sessionId?: string
}

/**
 * Read-only conversation of the pane's agent session (SWA-25), read from the
 * CLI's own session file. Deliberately no input of any kind: nothing here
 * types into the pane, answers a prompt or approves a tool — the pane stays
 * the only place that drives the agent. Loaded on open and on Refresh only;
 * the file may be written concurrently, so a read is a snapshot.
 * role="dialog" is what overlay-watch and terminal-focus key on.
 */
export function ThreadDialog(props: ThreadDialogProps): React.ReactElement | null {
  const { open, onClose, terminalId, agentId, accountId, sessionId } = props
  const [thread, setThread] = useState<AgentThread | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [showTools, setShowTools] = useState(false)
  const list = useRef<HTMLDivElement>(null)
  const root = useModalFocus(open, onClose, terminalId)

  // Only the newest read may land: a slow response for a previous session (or
  // one arriving after close/unmount) must not overwrite the current view.
  const requests = useRef(latestRequest())
  useEffect(() => () => requests.current.dispose(), [])

  const load = useCallback(() => {
    if (!sessionId) return
    const current = requests.current.begin()
    setLoading(true)
    readAgentThread(agentId, sessionId, accountId)
      .then((t) => { if (current()) setThread(t) })
      .catch(() => { if (current()) setThread({ found: false, truncated: false, messages: [] }) })
      .finally(() => { if (current()) setLoading(false) })
  }, [agentId, accountId, sessionId])

  useEffect(() => {
    if (!open) {
      requests.current.dispose()
      return
    }
    setThread(undefined)
    load()
  }, [open, load])

  // Newest at the bottom, like the pane itself.
  useEffect(() => {
    if (thread && list.current) list.current.scrollTop = list.current.scrollHeight
  }, [thread, showTools])

  const items = useMemo(() => threadItems(thread?.messages ?? [], showTools), [thread, showTools])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onMouseDown={onClose}>
      <div
        ref={root}
        role="dialog"
        aria-modal="true"
        aria-label="Conversation thread"
        className="theme-elevated flex h-[680px] max-h-[90vh] w-[820px] max-w-[94vw] flex-col gap-2 overflow-hidden rounded-lg border border-border bg-card p-3 text-sm text-foreground shadow-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <div className="font-medium">Conversation · {props.agentName}</div>
          <div className="truncate text-xs text-muted-foreground" title={sessionId}>
            read-only · session {sessionId?.slice(0, 8)}
          </div>
          <label className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
            <input type="checkbox" checked={showTools} onChange={(e) => setShowTools(e.target.checked)} />
            Show tool steps
          </label>
        </div>
        {thread?.truncated && (
          <div className="text-xs text-[#E5C07B]">Long session: only the most recent part is shown.</div>
        )}
        <div ref={list} aria-label="Thread messages" className="flex-1 space-y-2 overflow-y-auto rounded border border-border p-2">
          {thread === undefined && loading && <div className="text-xs text-muted-foreground">Loading…</div>}
          {thread && !thread.found && (
            <div className="text-xs text-muted-foreground">The session file was not found (yet). It appears after the first exchange.</div>
          )}
          {thread?.found && items.length === 0 && <div className="text-xs text-muted-foreground">No messages yet.</div>}
          {items.map((item, i) =>
            item.kind === 'tools' ? (
              <div key={i} className="text-xs text-muted-foreground" title={item.steps.join('\n')}>
                {item.steps.length === 1 ? item.steps[0] : `${item.steps.length} tool steps: ${item.steps.filter((s) => s.startsWith('→')).map((s) => s.slice(2)).join(', ')}`}
              </div>
            ) : (
              <div
                key={i}
                data-role={item.role}
                className={cn('rounded p-2', item.role === 'user' ? 'ml-10 bg-accent/60' : 'mr-10 bg-muted/40')}
              >
                <div className="mb-0.5 text-[11px] text-muted-foreground">
                  {item.role === 'user' ? 'You' : props.agentName} {threadTime(item.at)}
                </div>
                <div className="whitespace-pre-wrap break-words select-text">{item.text}</div>
              </div>
            )
          )}
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={loading} onClick={load}>
            Refresh
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  )
}
