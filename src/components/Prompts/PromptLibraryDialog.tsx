import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@/components/ui/button'
import { useModalFocus } from '@/components/ui/use-modal-focus'
import { dispatchTargets, filterPrompts, type SavedPrompt } from '@/lib/prompt-library'
import { deliverSavedPrompt } from '@/lib/prompt-delivery'
import { handoffTargets } from '@/lib/handoff-flow'
import { recognisedPanes } from '@/lib/pane-selectors'
import { HOLD_REASON_COPY } from '@/lib/notification-center'
import { DEFAULT_TEMPLATE_ID, templateById } from '@/lib/templates'
import { collectLeaves } from '@/lib/layout-tree'
import { planWorktreeBranches, provisionWorktrees } from '@/lib/worktree-naming'
import { getTerminalGeneration, getTerminalStatus } from '@/lib/terminal-registry'
import { createWorktree } from '@/tauri/git'
import { listAvailableAgents } from '@/tauri/agents'
import { useAgentAccountsStore } from '@/store/agent-accounts-store'
import { useAgentStateStore } from '@/store/agent-state-store'
import { selectFocusedTerminalId, useAppStore } from '@/store/app-store'
import { useNotificationCenterStore } from '@/store/notification-center-store'
import { usePromptLibraryStore } from '@/store/prompt-library-store'
import { useTerminalTitleStore } from '@/store/terminal-title-store'

const field = 'rounded border border-input bg-background p-1.5 text-sm text-foreground'
const NEW_PANE = '__new__'

type Draft = { id: string | null; title: string; body: string }
const EMPTY: Draft = { id: null, title: '', body: '' }

/**
 * Prompt library and dispatch (SWA-23). The text in the editor is what gets
 * sent — saved or not. Two ways out, both explicit button presses:
 * - an existing agent pane: the handoff's one-shot delivery (held while the
 *   user types or the agent works, never into a plain shell, never retried);
 * - a new Claude Code / Codex pane next to the focused one, optionally in a
 *   fresh git worktree, started with the prompt as its argument.
 * The outcome lands in the notification bell, so closing the dialog early
 * loses nothing. role="dialog" is what overlay-watch and terminal-focus key on.
 */
export function PromptLibraryDialog(): React.ReactElement | null {
  const open = usePromptLibraryStore((s) => s.open)
  const prompts = usePromptLibraryStore((s) => s.prompts)
  const error = usePromptLibraryStore((s) => s.error)
  const workspaces = useAppStore((s) => s.workspaces)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const titles = useTerminalTitleStore((s) => s.titles)
  const accounts = useAgentAccountsStore((s) => s.accounts)
  // Per-pane "agent recognised" flags, not the whole `byId`: state flips
  // (working ↔ idle) leave these booleans unchanged, so they no longer
  // re-render the dialog — and while closed it subscribes to nothing at all.
  const recognised = useAgentStateStore(useShallow((s) => recognisedPanes(s.byId, open)))
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [target, setTarget] = useState<string>('')
  const [agentKey, setAgentKey] = useState<string>('')
  const [inWorktree, setInWorktree] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [available, setAvailable] = useState<ReadonlySet<string> | undefined>()

  const close = (): void => usePromptLibraryStore.getState().setOpen(false)
  const root = useModalFocus(open, close, open ? selectFocusedTerminalId(useAppStore.getState()) : undefined)

  useEffect(() => {
    if (!open) return
    setStatus(null)
    setConfirmDelete(false)
    let alive = true
    listAvailableAgents()
      .then((list) => alive && setAvailable(new Set(list.filter((a) => a.available).map((a) => a.id))))
      .catch(() => alive && setAvailable(new Set()))
    return () => {
      alive = false
    }
  }, [open])

  const paneTargets = useMemo(
    () =>
      dispatchTargets(
        workspaces.map((w) => ({
          workspaceName: w.name,
          panes: collectLeaves(w.layout).map((l) => ({
            terminalId: l.terminalId,
            agentId: l.agentId ?? DEFAULT_TEMPLATE_ID,
            title: titles[l.terminalId] ?? '',
            // Same bar as the delivery: a live pty whose agent was recognised.
            // Subscribing to agent state also refreshes the list as agents start.
            running:
              getTerminalStatus(l.terminalId).kind === 'running' &&
              recognised[l.terminalId] === true
          }))
        })),
        (id) => templateById(id).name
      ),
    // `open` is a dependency on purpose: pty status is read live, not subscribed.
    [workspaces, titles, recognised, open]
  )
  const agentTargets = available ? handoffTargets(accounts, available) : []
  const key = (t: { agentId: string; accountId?: string }): string => `${t.agentId}:${t.accountId ?? ''}`
  const chosenAgent = agentTargets.find((t) => key(t) === agentKey) ?? agentTargets[0]
  const effectiveTarget = target === NEW_PANE || paneTargets.some((t) => t.terminalId === target) ? target : (paneTargets[0]?.terminalId ?? NEW_PANE)
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId)

  if (!open) return null
  const shown = filterPrompts(prompts, query)

  const pick = (p: SavedPrompt): void => {
    setDraft({ id: p.id, title: p.title, body: p.body })
    setConfirmDelete(false)
  }
  const save = (): void => {
    const id = draft.id ?? crypto.randomUUID()
    if (usePromptLibraryStore.getState().save({ id, title: draft.title, body: draft.body, updatedAt: Date.now() })) {
      setDraft({ ...draft, id })
      setStatus('Saved.')
    }
  }
  const remove = (): void => {
    if (!draft.id) return
    if (!confirmDelete) return setConfirmDelete(true)
    usePromptLibraryStore.getState().remove(draft.id)
    setDraft(EMPTY)
    setConfirmDelete(false)
  }

  const notify = (terminalId: string, title: string): void =>
    useNotificationCenterStore.getState().add({
      kind: 'prompt',
      terminalId,
      title,
      detail: useTerminalTitleStore.getState().titles[terminalId] ?? draft.title,
      at: Date.now()
    })

  const sendToPane = (terminalId: string): void => {
    const text = draft.body
    setStatus('Waiting for the pane to be free…')
    deliverSavedPrompt(terminalId, getTerminalGeneration(terminalId), text, {
      held: (reason) => reason && setStatus(`Held: ${HOLD_REASON_COPY[reason]}`),
      delivered: () => {
        setStatus('Prompt sent.')
        notify(terminalId, 'Prompt sent')
      },
      pasted: (reason) => {
        setStatus(`Pasted, not submitted: ${reason}`)
        notify(terminalId, `Prompt pasted, not submitted: ${reason}`)
      },
      failed: (err) => {
        setStatus(`Not sent: ${err}`)
        notify(terminalId, `Prompt not sent: ${err}`)
      }
    })
  }

  const startPane = async (): Promise<void> => {
    if (!chosenAgent || !activeWorkspace) return
    setBusy(true)
    try {
      let worktree: { path: string; branch: string } | undefined
      if (inWorktree) {
        const [made] = await provisionWorktrees(planWorktreeBranches([chosenAgent.agentId]), (name) =>
          createWorktree(activeWorkspace.cwd, name)
        )
        // Isolation was asked for: never fall back to the main checkout silently.
        if (!made) {
          setStatus('Could not create a git worktree here (is the folder a git repository with a commit?). Nothing was started.')
          return
        }
        worktree = made
      }
      const id = useAppStore.getState().promptPane({ agentId: chosenAgent.agentId, accountId: chosenAgent.accountId, prompt: draft.body, worktree })
      if (id === undefined) setStatus('No open workspace to add the pane to.')
      else {
        setStatus(worktree ? `Started in ${worktree.branch}.` : 'Started.')
        close()
      }
    } finally {
      setBusy(false)
    }
  }

  const dispatch = (): void => {
    if (!draft.body.trim()) return setStatus('The prompt text is empty.')
    if (effectiveTarget === NEW_PANE) void startPane()
    else sendToPane(effectiveTarget)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onMouseDown={close}>
      <div
        ref={root}
        role="dialog"
        aria-modal="true"
        aria-label="Prompt library"
        className="theme-elevated flex h-[620px] max-h-[90vh] w-[900px] max-w-[94vw] gap-3 overflow-hidden rounded-lg border border-border bg-card p-3 text-sm text-foreground shadow-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex w-64 shrink-0 flex-col gap-2">
          <div className="font-medium">Prompts</div>
          <input aria-label="Filter prompts" placeholder="Filter…" className={field} value={query} onChange={(e) => setQuery(e.target.value)} />
          <div role="listbox" aria-label="Saved prompts" className="flex-1 overflow-y-auto rounded border border-border">
            {shown.length === 0 && <div className="p-2 text-xs text-muted-foreground">{prompts.length === 0 ? 'No saved prompts yet.' : 'No match.'}</div>}
            {shown.map((p) => (
              <div
                key={p.id}
                role="option"
                aria-selected={p.id === draft.id}
                tabIndex={0}
                onClick={() => pick(p)}
                onKeyDown={(e) => e.key === 'Enter' && pick(p)}
                className={`cursor-pointer truncate px-2 py-1 text-xs hover:bg-accent ${p.id === draft.id ? 'bg-accent' : ''}`}
                title={p.title}
              >
                {p.title}
              </div>
            ))}
          </div>
          <Button size="sm" variant="ghost" onClick={() => { setDraft(EMPTY); setConfirmDelete(false) }}>
            New prompt
          </Button>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <input aria-label="Prompt title" placeholder="Title" className={field} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          <textarea
            aria-label="Prompt text"
            placeholder="Prompt text"
            className={`${field} flex-1 resize-none font-mono text-xs`}
            value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={save}>
              Save
            </Button>
            {draft.id && (
              <Button size="sm" variant="ghost" onClick={remove}>
                {confirmDelete ? 'Confirm delete' : 'Delete'}
              </Button>
            )}
          </div>
          {error && <div className="text-xs text-[#F14C4C]">{error}</div>}

          <div className="mt-1 flex flex-col gap-2 border-t border-border pt-2">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Send to
              <select aria-label="Dispatch target" className={field} value={effectiveTarget} onChange={(e) => setTarget(e.target.value)}>
                {paneTargets.map((t) => (
                  <option key={t.terminalId} value={t.terminalId}>
                    {t.label}
                  </option>
                ))}
                <option value={NEW_PANE}>New pane next to the focused one…</option>
              </select>
            </label>
            {effectiveTarget === NEW_PANE && (
              <div className="flex flex-wrap items-center gap-3">
                <select aria-label="New pane agent" className={field} value={chosenAgent ? key(chosenAgent) : ''} onChange={(e) => setAgentKey(e.target.value)}>
                  {agentTargets.map((t) => (
                    <option key={key(t)} value={key(t)}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-1 text-xs text-muted-foreground">
                  <input type="checkbox" checked={inWorktree} onChange={(e) => setInWorktree(e.target.checked)} />
                  In a new git worktree
                </label>
                {available && agentTargets.length === 0 && <span className="text-xs text-[#E5C07B]">No Claude Code or Codex CLI found.</span>}
                {!activeWorkspace && <span className="text-xs text-[#E5C07B]">Open a workspace first.</span>}
              </div>
            )}
            <div className="flex items-center gap-2">
              <div role="status" className="flex-1 truncate text-xs text-muted-foreground" title={status ?? ''}>
                {status}
              </div>
              <Button
                size="sm"
                disabled={busy || !draft.body.trim() || (effectiveTarget === NEW_PANE && (!chosenAgent || !activeWorkspace))}
                onClick={dispatch}
              >
                {effectiveTarget === NEW_PANE ? 'Start pane' : 'Send'}
              </Button>
              <Button size="sm" variant="ghost" onClick={close}>
                Close
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
