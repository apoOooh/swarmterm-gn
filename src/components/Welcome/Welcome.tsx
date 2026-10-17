import { useEffect, useState, type ReactElement } from 'react'
import { Folder, FolderSearch, X } from 'lucide-react'
import {
  TEMPLATES,
  DEFAULT_TEMPLATE_ID,
  isTemplateAvailable,
  templateById
} from '@/lib/templates'
import { TERMINAL_COUNTS, layoutSummary } from '@/lib/layout-tree'
import { allocateAgents } from '@/lib/agent-allocation'
import { useAgentAvailabilityStore } from '@/store/agent-availability-store'
import { useAgentAccountsStore } from '@/store/agent-accounts-store'
import { allocateAccounts, type AccountSelection } from '@/lib/agent-accounts'
import { useAppStore } from '@/store/app-store'
import { useAgentPrefStore } from '@/store/agent-pref-store'
import { AgentIcon } from '@/components/AgentIcon'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { getHomeDir } from '@/tauri/dialog'
import { pickFolder } from '@/store/folder-picker-store'
import { listWorktrees, createWorktree, ensureRepoWithCommit } from '@/tauri/git'
import { listAgentSessions } from '@/tauri/sessions'
import { planWorktreeBranches, provisionWorktrees } from '@/lib/worktree-naming'
import { folderName, VISIBLE_RECENT_ROWS } from '@/lib/recent-folders'
import { useRecentsStore } from '@/store/recents-store'
import { visibleSlice, hiddenCount } from '@/lib/list-paging'
import {
  mergeSessions,
  sessionKey,
  filterSessions,
  sessionTabCounts,
  SESSION_FILTER_TABS,
  VISIBLE_SESSION_ROWS,
  type AgentSessionEntry,
  type SessionFilter
} from '@/lib/agent-sessions'
import { LayoutPreview } from './LayoutPreview'
import { RecentsDialog } from './RecentsDialog'
import { SessionRow } from './SessionRow'
import { retargetResumePanes, type SessionTargets } from '@/lib/session-transfer'
import { transferAgentSession } from '@/tauri/sessions'
import { useNotificationCenterStore } from '@/store/notification-center-store'
import { SessionsDialog } from './SessionsDialog'
import { SavedWorkspaceCard } from './SavedWorkspaceCard'
import { AgentCountEditor } from './AgentCountEditor'
import { useSavedWorkspacesStore } from '@/store/saved-workspaces-store'
import { useWorkspacePresetsStore } from '@/store/workspace-presets-store'
import { findTemplateByName, fitPresetToCap, withAvailableAgents, withKnownAccounts, type WorkspacePreset } from '@/lib/workspace-presets'

/**
 * Welcome page shown while creating a workspace (or when none exist). A
 * two-panel composer: left column picks a working folder and shows recent
 * folders; right column sets the terminal count via tiles, lets the user
 * assign AI agent quantities via steppers, shows a live layout preview, and
 * has the Create button. Creating a workspace closes Welcome via the store.
 */
export function Welcome(): ReactElement {
  const createWorkspace = useAppStore((s) => s.createWorkspace)
  const folder = useAppStore((s) => s.welcomeFolder)
  const setFolder = useAppStore((s) => s.setWelcomeFolder)
  const recents = useRecentsStore((s) => s.recents)
  const addRecentFolder = useRecentsStore((s) => s.add)
  const removeRecentFolder = useRecentsStore((s) => s.remove)
  const availability = useAgentAvailabilityStore((s) => s.availability)
  const savedWorkspaces = useSavedWorkspacesStore(s => s.entries)
  const codexSessionHooks = useAgentAvailabilityStore(s => s.codexSessionHooks)

  const accounts = useAgentAccountsStore(s => s.accounts)
  const defaults = useWorkspacePresetsStore((s) => s.defaults)
  const templates = useWorkspacePresetsStore((s) => s.templates)
  // The composer starts from the user's workspace defaults (Settings → Workspaces).
  const [initial] = useState(() => useWorkspacePresetsStore.getState().defaults)
  const [templateId, setTemplateId] = useState('')
  const [accountSelections, setAccountSelections] = useState<Record<string, AccountSelection>>(initial.accountSelections)
  const [terminalCount, setTerminalCount] = useState<number>(initial.terminalCount)
  // '' ⇒ follow the Settings default (no per-workspace override).
  const [splitAgent, setSplitAgent] = useState<string>(initial.splitAgent)
  const globalSplitAgent = useAgentPrefStore((s) => s.defaultAgentId)
  // Optimistic seed: the default agents stay assigned until the probe says they're not installed.
  const [counts, setCounts] = useState<Record<string, number>>(initial.agentCounts)

  const [isolateWorktrees, setIsolateWorktrees] = useState(initial.isolateWorktrees)
  // Inline "Save as template" prompt; null ⇒ closed.
  const [templateName, setTemplateName] = useState<string | null>(null)
  const [savedNotice, setSavedNotice] = useState('')
  const [isGitRepo, setIsGitRepo] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const [sessions, setSessions] = useState<AgentSessionEntry[]>([])
  const [tickedSessions, setTickedSessions] = useState<ReadonlySet<string>>(new Set())
  // "Open in" choice per ticked session (SWA-64); see lib/session-transfer.
  const [sessionTargets, setSessionTargets] = useState<SessionTargets>({})
  const setSessionTarget = (key: string, accountId: string | null): void =>
    setSessionTargets(prev => ({ ...prev, [key]: accountId }))
  const [sessionFilter, setSessionFilter] = useState<SessionFilter>('all')
  const [sessionsDialogOpen, setSessionsDialogOpen] = useState(false)
  // Recents are global, not per-folder, so unlike sessionsDialogOpen this is
  // deliberately NOT reset by the folder-change effect below.
  const [recentsDialogOpen, setRecentsDialogOpen] = useState(false)

  // Pre-fill the default folder (or the home directory) on mount, unless a
  // folder is already chosen.
  useEffect(() => {
    if (useAppStore.getState().welcomeFolder !== '') return
    if (initial.folder.trim() !== '') {
      setFolder(initial.folder.trim())
      return
    }
    void getHomeDir().then((home) => {
      if (useAppStore.getState().welcomeFolder === '') setFolder(home)
    }).catch((e) => console.warn('Welcome: home directory unavailable, leaving folder empty:', e))
  }, [setFolder, initial.folder])

  // Re-probe installed agent CLIs every time Welcome mounts so a CLI installed
  // while the app runs is picked up without a restart.
  useEffect(() => {
    void useAgentAvailabilityStore.getState().refresh()
    // A default saved with a since-deleted account would select nothing;
    // fall back to the default account once the profiles are known.
    void useAgentAccountsStore.getState().refresh().then(() => {
      const { accounts: known, error } = useAgentAccountsStore.getState()
      if (error === null) setAccountSelections((prev) => withKnownAccounts(prev, new Set(known.map((a) => a.id))))
    })
  }, [])

  function isAvailable(agentId: string): boolean {
    return isTemplateAvailable(templateById(agentId), availability)
  }

  // Picking "Defaults" or a template replaces every composer choice; an
  // empty template folder keeps the folder already chosen.
  const applyTemplate = (id: string): void => {
    setTemplateId(id)
    const picked = id === '' ? defaults : templates.find((t) => t.id === id)
    if (!picked) return
    // Ticked resume sessions already take slots: shrink the template to fit
    // the 12-pane cap rather than letting it breach it.
    const preset = fitPresetToCap(withAvailableAgents(picked, isAvailable), resumePanes.length)
    setTerminalCount(preset.terminalCount)
    setCounts(preset.agentCounts)
    setAccountSelections(withKnownAccounts(preset.accountSelections, new Set(accounts.map((a) => a.id))))
    setIsolateWorktrees(preset.isolateWorktrees)
    setSplitAgent(preset.splitAgent)
    if (preset.folder.trim() !== '') setFolder(preset.folder.trim())
  }

  const currentPreset = (): WorkspacePreset => ({
    folder: trimmedFolder,
    terminalCount,
    agentCounts: liveCounts,
    accountSelections,
    isolateWorktrees,
    splitAgent
  })

  const flashNotice = (text: string): void => {
    setSavedNotice(text)
    window.setTimeout(() => setSavedNotice(''), 2500)
  }

  const saveAsDefault = (): void => {
    useWorkspacePresetsStore.getState().setDefaults(currentPreset())
    flashNotice('Saved as default')
  }

  const existingTemplate = templateName === null ? undefined : findTemplateByName(templates, templateName)

  const saveTemplate = (): void => {
    const name = (templateName ?? '').trim()
    if (name === '') return
    const store = useWorkspacePresetsStore.getState()
    if (existingTemplate) {
      store.updateTemplate(existingTemplate.id, existingTemplate.name, currentPreset())
      setTemplateId(existingTemplate.id)
    } else {
      setTemplateId(store.addTemplate(name, currentPreset()))
    }
    setTemplateName(null)
    flashNotice(`Template “${name}” saved`)
  }

  // Ordered agent ids — drives both the layout preview and createWorkspace.
  // Templates appear in TEMPLATES order, unassigned slots fill with 'terminal'.
  // Agents the probe has found missing never spawn and are never saved: only
  // installed agents have a row, and the next count edit drops hidden counts.
  const liveCounts = withAvailableAgents({ ...initial, agentCounts: counts }, isAvailable).agentCounts
  const agentIds = allocateAgents(terminalCount, liveCounts)

  const trimmedFolder = folder.trim()
  const canCreate = trimmedFolder !== ''

  // Probe whether the chosen folder is inside a git repo. list returns []
  // for non-repos and for the home-dir guard.
  useEffect(() => {
    if (trimmedFolder === '') {
      setIsGitRepo(false)
      return
    }
    let cancelled = false
    setIsGitRepo(false)
    const timer = window.setTimeout(() => { void listWorktrees(trimmedFolder)
      .then((trees) => {
        if (cancelled) return
        // A repo with an unborn HEAD (fresh `git init`, zero commits) lists
        // its main worktree with an all-zero head. `git worktree add` cannot
        // check out from an unborn HEAD, so we disable this feature until
        // the repo has at least one commit.
        const main = trees.find((t) => t.isMain)
        const unborn = main !== undefined && /^0+$/.test(main.head)
        setIsGitRepo(trees.length > 0 && !unborn)
      })
      .catch(() => {
        if (!cancelled) {
          setIsGitRepo(false)
        }
      }) }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [trimmedFolder])

  // Resume suggestions for the chosen folder. Fail-open: any error or a
  // slow scan just means the section doesn't render — Create is never gated.
  useEffect(() => {
    setSessions([])
    setTickedSessions(new Set())
    // A filter chosen for one project is meaningless for the next — and so
    // is a dialog left open over the next folder's list.
    setSessionFilter('all')
    setSessionsDialogOpen(false)
    if (trimmedFolder === '') return
    let cancelled = false
    // A full CLI history scan is expensive, especially across account profiles.
    // Wait until folder editing settles; obsolete timers never start native work.
    const timer = window.setTimeout(() => { void listAgentSessions(trimmedFolder)
      .then((entries) => {
        if (!cancelled) setSessions(mergeSessions(entries, availability))
      })
      .catch(() => {
        if (!cancelled) setSessions([])
      }) }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [trimmedFolder, availability, accounts])

  const browse = async (): Promise<void> => {
    const picked = await pickFolder(trimmedFolder)
    if (picked) setFolder(picked)
  }

  const resumePanes = retargetResumePanes(sessions.filter((e) => tickedSessions.has(sessionKey(e))), sessionTargets, sessionKey)
    .map((e) => ({ agentId: e.agentId, sessionId: e.sessionId, cwd: e.cwd, accountId: e.accountId, moved: 'fromAccountId' in e, fromAccountId: e.fromAccountId }))
  // Ticks are kept against the FULL sessions list (above) so a selection made
  // under one filter still counts once the user switches tabs.
  const tabCounts = sessionTabCounts(sessions)
  const filteredSessions = filterSessions(sessions, sessionFilter)
  const visibleSessions = visibleSlice(filteredSessions, false, VISIBLE_SESSION_ROWS)

  const toggleSession = (key: string): void => {
    setTickedSessions((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const totalPaneCount = terminalCount + resumePanes.length
  const maxTiles = TERMINAL_COUNTS[TERMINAL_COUNTS.length - 1] // 12
  const canTickMore = totalPaneCount < maxTiles

  const submit = async (): Promise<void> => {
    // isSubmitting guards against a second Create click (or a duplicate
    // Ctrl+Enter) firing while worktree provisioning is still in flight —
    // without it, a slow `git worktree add` could be kicked off twice for
    // the same plan, racing two workspaces into existence.
    if (!canCreate || isSubmitting) return
    setIsSubmitting(true)
    try {
      addRecentFolder(trimmedFolder)

      const isolate = isolateWorktrees
      let paneWorktrees: ({ path: string; branch: string } | null)[] | undefined

      if (isolate) {
        try {
          // Auto-initialize git if folder is not a repo and has no commits
          await ensureRepoWithCommit(trimmedFolder)
        } catch (err) {
          setIsSubmitting(false)
          console.error('failed to initialize git repo:', err)
          return
        }

        // Provision isolation BEFORE the workspace exists: leaves are born inside
        // their worktrees, so no pane ever runs on the main checkout by accident
        // (v2 spec — the toggle is a guarantee, not a suggestion to the agent).
        const plan = planWorktreeBranches(agentIds)
        paneWorktrees = await provisionWorktrees(plan, (name) =>
          createWorktree(trimmedFolder, name)
        )
      }

      // Copy each session into its chosen subscription before the pane
      // resumes it there. A failed copy keeps that pane on its original
      // subscription (the conversation is never dropped) and says so.
      const failed: string[] = []
      const panesToResume = await Promise.all(resumePanes.map(async ({ moved, fromAccountId, ...pane }) => {
        if (!moved) return pane
        try {
          await transferAgentSession(pane.agentId, pane.sessionId, fromAccountId, pane.accountId)
          return pane
        } catch (error) {
          failed.push(String(error))
          return { ...pane, accountId: fromAccountId }
        }
      }))
      // Welcome closes once the workspace exists, so report in the bell.
      if (failed.length > 0) {
        useNotificationCenterStore.getState().add({ kind: 'backend', terminalId: '', title: `Some sessions stayed on their original subscription: ${failed.join('; ')}`, detail: '', at: Date.now() })
      }

      createWorkspace({
        cwd: trimmedFolder,
        terminalCount,
        agentIds,
        accountIds: allocateAccounts(agentIds, accounts, accountSelections),
        worktreeMode: isolate,
        paneWorktrees,
        resumePanes: panesToResume.length > 0 ? panesToResume : undefined,
        defaultAgentId: splitAgent === '' ? undefined : splitAgent
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  // Document-level Ctrl/⌘+Enter shortcut — fires even when nothing in the
  // composer has focus (nothing is focused on first mount). Re-registered
  // whenever inputs change to avoid stale-closure bugs.
  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        void submit()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [trimmedFolder, terminalCount, counts, isolateWorktrees, isGitRepo, isSubmitting, tickedSessions, sessions, accounts, accountSelections]) // eslint-disable-line react-hooks/exhaustive-deps

  // Build caption: "4 panes · 2×2 · 2 AI agents · 2 Terminals"
  const aiCount = agentIds.filter((id) => id !== DEFAULT_TEMPLATE_ID).length
  const termCount = agentIds.length - aiCount
  const aiClause =
    aiCount > 0 ? ` · ${aiCount} ${aiCount === 1 ? 'AI agent' : 'AI agents'}` : ''
  const termClause = ` · ${termCount} ${termCount === 1 ? 'Terminal' : 'Terminals'}`
  const resumedClause = resumePanes.length > 0 ? ` · ${resumePanes.length} resumed` : ''
  const caption = `${layoutSummary(totalPaneCount)}${aiClause}${termClause}${resumedClause}`

  const visibleRecents = visibleSlice(recents, false, VISIBLE_RECENT_ROWS)

  return (
    <div className="mx-auto flex min-h-full max-w-5xl flex-col justify-center px-10 py-6">
      <header className="mb-4">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Swarmterm</h1>
        <p className="mt-1 text-base text-muted-foreground">Run many terminals, side by side.</p>
      </header>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
        {/* LEFT: COMPOSE — working folder + recent folders */}
        <section className="flex min-h-0 min-w-0 flex-col rounded-xl border border-border bg-card p-4">
          <h2 className="mb-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Compose
          </h2>

          {/* Working folder */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-foreground">
              Working folder
            </label>
            <div className="flex items-center gap-2 rounded-lg border border-input bg-background px-3 py-2 focus-within:ring-1 focus-within:ring-ring">
              <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
              <input
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                placeholder="Choose a folder…"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
              <Button variant="ghost" size="sm" onClick={() => void browse()}>
                <FolderSearch className="h-4 w-4" />
                Browse
              </Button>
            </div>
          </div>

          {savedWorkspaces.length > 0 && <section aria-label="Saved workspaces" className="mt-5">
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Saved workspaces</h3>
            <div className="max-h-80 space-y-2 overflow-y-auto">{savedWorkspaces.map(workspace => <SavedWorkspaceCard key={workspace.id} workspace={workspace} />)}</div>
          </section>}
          {availability.codex === true && <p className="mt-3 text-xs text-muted-foreground">{codexSessionHooks
            ? 'To save Codex conversations, review and trust the Swarmterm session hooks in /hooks. Send a message after trusting them.'
            : 'Update Codex CLI to a version with session hooks to save new conversations. Workspace layouts are saved now.'}</p>}

          {/* Recent folders — inline list capped at VISIBLE_RECENT_ROWS;
              "Show all" opens the searchable pick-one dialog over the full
              list (the title-bar search dropdown stays for quick picks). */}
          {visibleRecents.length > 0 && (
            <div className="mt-5">
              <p className="mb-2 shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Recent
              </p>
              <div className="space-y-0.5">
                {visibleRecents.map((path) => (
                  <div
                    key={path}
                    role="button"
                    tabIndex={0}
                    onClick={() => setFolder(path)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setFolder(path)
                      }
                    }}
                    className="group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent"
                  >
                    <span
                      title={folderName(path)}
                      className="min-w-0 max-w-[50%] shrink-0 truncate text-sm font-medium text-foreground"
                    >
                      {folderName(path)}
                    </span>
                    <span
                      title={path}
                      className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                    >
                      {path}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        removeRecentFolder(path)
                      }}
                      aria-label={`Remove ${folderName(path)} from recents`}
                      className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground group-hover:opacity-100"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
              {hiddenCount(recents.length, false, VISIBLE_RECENT_ROWS) > 0 && (
                <button
                  type="button"
                  onClick={() => setRecentsDialogOpen(true)}
                  className="mx-auto mt-1 block text-xs text-muted-foreground hover:text-foreground"
                >
                  Show all ({recents.length})
                </button>
              )}
            </div>
          )}

          {/* Resume sessions — recorded by the agent CLIs themselves for this
              folder; ticking one appends a pane that re-enters that session.
              Sits last (after Recent) since it's per-folder and often empty;
              tabs filter the list by agent, ticks always count against the
              full unfiltered list. */}
          {sessions.length > 0 && (
            <div className="mt-5">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Resume sessions
                </p>
                {tickedSessions.size > 0 && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {tickedSessions.size} selected
                  </span>
                )}
              </div>
              <div className="mb-2 flex flex-wrap gap-1">
                {SESSION_FILTER_TABS.map((tab) => {
                  const count = tabCounts[tab] ?? 0
                  const active = sessionFilter === tab
                  const empty = tab !== 'all' && count === 0
                  return (
                    <button
                      key={tab}
                      type="button"
                      aria-pressed={active}
                      disabled={empty}
                      onClick={() => setSessionFilter(tab)}
                      className={cn(
                        'flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs',
                        // Matches the terminal-count tile buttons' selected/idle
                        // treatment (ring+accent, not the brief's default primary)
                        // so the two pill families read as one control language.
                        active
                          ? 'border-ring bg-accent text-foreground ring-1 ring-ring'
                          : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
                        empty && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted-foreground'
                      )}
                    >
                      {tab !== 'all' && (
                        <AgentIcon template={templateById(tab)} className="h-3 w-3 shrink-0" />
                      )}
                      {tab === 'all' ? 'All' : templateById(tab).name} ({count})
                    </button>
                  )
                })}
              </div>
              <div className="space-y-0.5">
                {visibleSessions.map((s) => {
                  const key = sessionKey(s)
                  const ticked = tickedSessions.has(key)
                  return (
                    <SessionRow
                      key={key}
                      session={s}
                      ticked={ticked}
                      disabled={!ticked && !canTickMore}
                      onToggle={() => toggleSession(key)}
                      target={sessionTargets[key]}
                      onTargetChange={(accountId) => setSessionTarget(key, accountId)}
                    />
                  )
                })}
              </div>
              {hiddenCount(filteredSessions.length, false, VISIBLE_SESSION_ROWS) > 0 && (
                <button
                  type="button"
                  onClick={() => setSessionsDialogOpen(true)}
                  className="mx-auto mt-1 block text-xs text-muted-foreground hover:text-foreground"
                >
                  Show all ({filteredSessions.length})
                </button>
              )}
            </div>
          )}
        </section>

        {/* RIGHT: TERMINALS — tile count selector + AI agent steppers + live preview + create */}
        <section className="flex min-h-0 min-w-0 flex-col rounded-xl border border-border bg-card p-4">
          <h2 className="mb-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Terminals
          </h2>

          {/* Template / defaults picker */}
          {templates.length > 0 && (
            <label className="mb-4 flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-foreground">Template</span>
              <select
                aria-label="Workspace template"
                value={templateId}
                onChange={(e) => applyTemplate(e.target.value)}
                className="h-8 min-w-0 max-w-[60%] rounded-md border border-pane-border bg-card px-2 text-sm text-foreground"
              >
                <option value="">Defaults</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
          )}

          <AgentCountEditor
            terminalCount={terminalCount}
            setTerminalCount={setTerminalCount}
            counts={counts}
            setCounts={setCounts}
            accountSelections={accountSelections}
            setAccountSelections={setAccountSelections}
            extraPanes={resumePanes.length}
          />

          {/* Live preview — fixed, bounded height so the panel stays compact and
              the whole Welcome fits the window without scrolling; the grid scales
              down within this box at high pane counts. */}
          <div className="mb-3">
            <p className="mb-1.5 text-xs text-muted-foreground">Preview</p>
            <div className="h-[120px]">
              <LayoutPreview
                terminalCount={totalPaneCount}
                agents={[...agentIds, ...resumePanes.map((p) => p.agentId)]}
              />
            </div>
          </div>

          {/* Caption */}
          <p className="mb-4 text-center text-xs tabular-nums text-muted-foreground">{caption}</p>

          {/* Worktree isolation — enables the MCP worktree tools per workspace */}
          <label
            className={cn(
              'mb-3 flex cursor-pointer items-start gap-2',
              !isGitRepo && 'cursor-not-allowed opacity-50'
            )}
            title={isGitRepo ? undefined : 'Will auto-initialize git when you create'}
          >
            <input
              type="checkbox"
              disabled={false}
              checked={isolateWorktrees}
              onChange={(e) => setIsolateWorktrees(e.target.checked)}
              className="mt-0.5 accent-current"
            />
            <span>
              <span className="block text-sm font-medium text-foreground">
                Isolate features in git worktrees
              </span>
              <span className="block text-xs text-muted-foreground">
                Each agent pane starts in its own worktree and branch.
              </span>
            </span>
          </label>

          {/* Per-workspace default for the pane header's Split buttons */}
          <label className="mb-3 flex items-center justify-between gap-3">
            <span>
              <span className="block text-sm font-medium text-foreground">Split opens</span>
              <span className="block text-xs text-muted-foreground">
                What a new split pane starts with in this workspace.
              </span>
            </span>
            <select
              value={splitAgent}
              onChange={(e) => setSplitAgent(e.target.value)}
              className="h-8 rounded-md border border-pane-border bg-card px-2 text-sm text-foreground"
            >
              <option value="">Settings default ({templateById(globalSplitAgent).name})</option>
              {TEMPLATES.filter((t) => isTemplateAvailable(t, availability) || t.id === splitAgent).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {isTemplateAvailable(t, availability) ? '' : ' (not installed)'}
                </option>
              ))}
            </select>
          </label>

          {/* Save the composer's choices for next time */}
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <Button variant="outline" size="sm" onClick={saveAsDefault} title="Start every new workspace with these choices">
              Save as default
            </Button>
            <Button variant="outline" size="sm" onClick={() => setTemplateName(templateName === null ? '' : null)}>
              Save as template…
            </Button>
            {savedNotice !== '' && <span role="status" className="text-xs text-muted-foreground">{savedNotice}</span>}
          </div>
          {templateName !== null && (
            <form
              className="mb-3 flex items-center gap-1.5"
              onSubmit={(e) => { e.preventDefault(); saveTemplate() }}
            >
              <input
                autoFocus
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setTemplateName(null) } }}
                placeholder="Template name"
                aria-label="Template name"
                spellCheck={false}
                className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm outline-none focus:ring-1 focus:ring-ring"
              />
              <Button type="submit" size="sm" disabled={templateName.trim() === ''}>
                {existingTemplate ? 'Overwrite' : 'Save'}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setTemplateName(null)}>
                Cancel
              </Button>
            </form>
          )}

          {/* Create workspace button */}
          <div className="mt-auto">
            <Button
              className="w-full"
              onClick={() => void submit()}
              disabled={!canCreate || isSubmitting}
            >
              {isSubmitting ? 'Creating worktrees…' : 'Create workspace'}
            </Button>
            <p className="mt-2 text-center text-xs text-muted-foreground">
              {canCreate ? 'Press ⌘↵ / Ctrl+↵ to create' : 'Choose a working folder to continue'}
            </p>
          </div>
        </section>
      </div>

      <SessionsDialog
        open={sessionsDialogOpen}
        onClose={() => setSessionsDialogOpen(false)}
        sessions={sessions}
        tickedKeys={tickedSessions}
        onToggle={toggleSession}
        targets={sessionTargets}
        onTargetChange={setSessionTarget}
        canTickMore={canTickMore}
        slotsLeft={maxTiles - totalPaneCount}
      />

      <RecentsDialog
        open={recentsDialogOpen}
        onClose={() => setRecentsDialogOpen(false)}
        onPick={setFolder}
      />
    </div>
  )
}
