import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { Check, CheckCircle2, CircleMinus, Copy, ExternalLink, FolderSearch, RefreshCw, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { editionFeatures } from '@/lib/edition'
import { setupRows } from '@/lib/setup-status'
import {
  WIZARD_LAYOUTS,
  WIZARD_STEPS,
  agentChecklist,
  applyVoiceChoice,
  keyVarRows,
  passKeyVar,
  prerequisiteChecklist,
  startableAgents,
  voiceChoices,
  wizardAgentIds,
  workspaceFolderProblem,
  type VoiceChoice,
  type WizardStep
} from '@/lib/setup-wizard'
import { writeClipboard } from '@/tauri/clipboard'
import { openUrl } from '@/tauri/opener'
import { getHomeDir } from '@/tauri/dialog'
import { getApiKeyVars } from '@/tauri/setup'
import { getVoiceSettings, setVoiceSettings } from '@/tauri/voice'
import { useAgentAvailabilityStore } from '@/store/agent-availability-store'
import { useAppStore } from '@/store/app-store'
import { useEnvPolicyStore } from '@/store/env-policy-store'
import { pickFolder } from '@/store/folder-picker-store'
import { useEdition, usePolicyStore } from '@/store/policy-store'
import { useRecentsStore } from '@/store/recents-store'
import { useSetupStatusStore } from '@/store/setup-status-store'
import { useSetupWizardStore } from '@/store/setup-wizard-store'
import type { CategoryId } from '@/components/Settings/SettingsView'

const STEP_TITLE: Record<WizardStep, string> = {
  prerequisites: 'Tools and agents',
  signin: 'Sign-in',
  voice: 'Voice',
  workspace: 'First workspace'
}

/** A command to copy (D6: never run from the app) and the vendor link. */
function InstallActions({ command, link }: { command: string | null; link: string }): ReactElement {
  const [copied, setCopied] = useState(false)
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2">
      {command !== null && (
        <>
          <code className="rounded bg-muted px-2 py-0.5 font-mono text-xs text-foreground">{command}</code>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-muted-foreground"
            onClick={() => void writeClipboard(command).then(() => setCopied(true), () => setCopied(false))}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </>
      )}
      <Button variant="ghost" size="sm" className="h-7 gap-1 text-muted-foreground" onClick={() => void openUrl(link)}>
        <ExternalLink className="h-3.5 w-3.5" />
        Download page
      </Button>
    </div>
  )
}

function Row({ ok, optional, title, children, testId }: { ok: boolean; optional?: boolean; title: string; children?: ReactNode; testId: string }): ReactElement {
  const Icon = ok ? CheckCircle2 : optional ? CircleMinus : TriangleAlert
  return (
    <li data-wizard-item={testId} data-found={ok} className="flex items-start gap-3 px-3 py-2.5">
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', ok ? 'text-emerald-500' : optional ? 'text-muted-foreground' : 'text-amber-500')} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm text-foreground">{title}</span>
          <span className="text-xs text-muted-foreground">{ok ? 'Found' : optional ? 'Optional' : 'Not found'}</span>
        </div>
        {children}
      </div>
    </li>
  )
}

function PrerequisitesStep(): ReactElement {
  const status = useSetupStatusStore(s => s.status)
  const checking = useSetupStatusStore(s => s.checking)
  const recheck = useSetupStatusStore(s => s.recheck)
  const availability = useAgentAvailabilityStore(s => s.availability)
  const refreshAgents = useAgentAvailabilityStore(s => s.refresh)
  const again = (): void => { void recheck(); void refreshAgents() }
  useEffect(again, [recheck, refreshAgents])

  if (status === null) return <p className="text-sm text-muted-foreground">Checking…</p>
  const tools = prerequisiteChecklist(status)
  const agents = agentChecklist(availability, status)
  const integration = setupRows(status)
  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-prose text-sm text-muted-foreground">
          Swarmterm runs the agent CLIs you already have. Anything missing can be installed with the command shown —
          copy it into a terminal of your choice, then press <span className="text-foreground">Check again</span>.
          Swarmterm never installs anything itself.
        </p>
        <Button variant="ghost" size="sm" onClick={again} disabled={checking} className="shrink-0 gap-1 text-muted-foreground">
          <RefreshCw className={cn('h-3.5 w-3.5', checking && 'animate-spin')} />
          Check again
        </Button>
      </div>
      <section>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Tools</h3>
        <ul className="divide-y divide-border rounded-lg border border-border">
          {tools.map(t => (
            <Row key={t.id} testId={t.id} ok={t.found} optional={t.optional} title={t.name}>
              {!t.found && (
                <>
                  <p className="mt-1 text-xs text-muted-foreground">{t.why}</p>
                  <InstallActions command={t.command} link={t.link} />
                </>
              )}
            </Row>
          ))}
        </ul>
      </section>
      <section>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Agents</h3>
        <ul className="divide-y divide-border rounded-lg border border-border">
          {agents.map(a => {
            const rows = integration.filter(r => r.agent === a.name)
            return (
              <Row key={a.id} testId={a.id} ok={a.installed} optional title={a.name}>
                {a.installed ? (
                  <>
                    {rows.length > 0 && (
                      <p className="mt-1 text-xs text-muted-foreground">{rows.map(r => `${r.item}: ${r.text}`).join(' · ')}</p>
                    )}
                    {a.note !== null && <p className="mt-1 text-xs text-muted-foreground">{a.note}</p>}
                  </>
                ) : (
                  <>
                    <p className="mt-1 text-xs text-muted-foreground">{a.why}{a.command === null && a.id !== 'claude-code' ? ' Needs Node.js (npm) first.' : ''}</p>
                    <InstallActions command={a.command} link={a.link} />
                  </>
                )}
              </Row>
            )
          })}
        </ul>
      </section>
    </div>
  )
}

function SigninStep(): ReactElement {
  const [vars, setVars] = useState<string[] | null>(null)
  const policy = useEnvPolicyStore(s => s.policy)
  const setPolicy = useEnvPolicyStore(s => s.setPolicy)
  const admin = usePolicyStore(s => s.policy)
  useEffect(() => {
    void usePolicyStore.getState().load()
    void getApiKeyVars().then(setVars, () => setVars([]))
  }, [])
  const rows = vars === null ? [] : keyVarRows(vars, policy, admin)
  return (
    <div className="space-y-4 text-sm">
      <p className="max-w-prose text-muted-foreground">
        Each agent signs in on its first start in a pane, with its own login (Claude Code: <code>/login</code>,
        Codex and OpenCode ask by themselves). That is the recommended way; nothing to do here.
      </p>
      {rows.length > 0 && (
        <section>
          <p className="mb-2 max-w-prose text-muted-foreground">
            You have API key variables set. Swarmterm holds secrets back from panes by default, so an agent will not
            see them unless you pass them on. Only the name is stored, never the value.
          </p>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {rows.map(r => (
              <li key={r.name} data-wizard-key={r.name} data-passed={r.passed} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <code className="font-mono text-xs text-foreground">{r.name}</code>
                {r.passed ? (
                  <span className="text-xs text-emerald-500">Passed to panes</span>
                ) : r.locked ? (
                  <span className="text-xs text-muted-foreground">Managed by your administrator</span>
                ) : (
                  <Button variant="ghost" size="sm" onClick={() => setPolicy({ allow: passKeyVar(policy, r.name).allow })}>
                    Pass to panes
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function VoiceStep({ choice, onChoice }: { choice: VoiceChoice; onChoice: (c: VoiceChoice) => void }): ReactElement {
  const edition = useEdition()
  const admin = usePolicyStore(s => s.policy)
  const features = editionFeatures(edition)
  const options = voiceChoices({
    modelDownload: features.modelDownload && !admin.disableModelDownload,
    companion: features.companion && !admin.disableCompanion
  })
  return (
    <div className="space-y-3 text-sm" role="radiogroup" aria-label="Voice">
      <p className="max-w-prose text-muted-foreground">Dictate into the focused pane. Off unless you choose otherwise.</p>
      {options.map(o => (
        <label key={o.id} data-wizard-voice={o.id} className={cn('flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5', choice === o.id ? 'border-primary bg-primary/5' : 'border-border')}>
          <input type="radio" name="wizard-voice" checked={choice === o.id} onChange={() => onChoice(o.id)} className="mt-1" />
          <span>
            <span className="block text-foreground">{o.label}</span>
            <span className="block text-xs text-muted-foreground">{o.text}</span>
          </span>
        </label>
      ))}
    </div>
  )
}

interface WorkspaceDraft { folder: string; count: number; agent: string }

function WorkspaceStep({ draft, onDraft, home }: { draft: WorkspaceDraft; onDraft: (d: WorkspaceDraft) => void; home: string | null }): ReactElement {
  const availability = useAgentAvailabilityStore(s => s.availability)
  const agents = startableAgents(availability)
  const problem = workspaceFolderProblem(draft.folder, home)
  useEffect(() => {
    if (!agents.some(a => a.id === draft.agent)) onDraft({ ...draft, agent: agents[0].id })
  }, [agents, draft, onDraft])
  return (
    <div className="space-y-4 text-sm">
      <div>
        <label htmlFor="wizard-folder" className="mb-1.5 block font-medium text-foreground">Project folder</label>
        <div className="flex items-center gap-2 rounded-md border border-border px-2 py-1">
          <input
            id="wizard-folder"
            value={draft.folder}
            onChange={(e) => onDraft({ ...draft, folder: e.target.value })}
            placeholder="Choose a folder…"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <Button variant="ghost" size="sm" onClick={() => void pickFolder(draft.folder).then(p => { if (p) onDraft({ ...draft, folder: p }) })}>
            <FolderSearch className="h-4 w-4" />
            Browse
          </Button>
        </div>
        {problem === 'broad' && (
          <p className="mt-1.5 text-xs text-amber-500" data-testid="wizard-broad-folder">
            This is your whole user folder or a drive. Pick a project folder: Swarmterm watches every file below it,
            and agents will ask you to trust all of it.
          </p>
        )}
      </div>
      <div>
        <span className="mb-1.5 block font-medium text-foreground">Panes</span>
        <div className="flex gap-2" role="radiogroup" aria-label="Panes">
          {WIZARD_LAYOUTS.map(n => (
            <Button key={n} variant={draft.count === n ? 'default' : 'outline'} size="sm" onClick={() => onDraft({ ...draft, count: n })} aria-pressed={draft.count === n}>
              {n}
            </Button>
          ))}
        </div>
      </div>
      <div>
        <label htmlFor="wizard-agent" className="mb-1.5 block font-medium text-foreground">Agent in every pane</label>
        <select
          id="wizard-agent"
          value={draft.agent}
          onChange={(e) => onDraft({ ...draft, agent: e.target.value })}
          className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
        >
          {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <p className="mt-1.5 text-xs text-muted-foreground">Only agents that start on this PC are listed.</p>
      </div>
    </div>
  )
}

/**
 * The setup assistant (SWA-83 phase 2): four steps over a dimmed backdrop,
 * rendered like Settings (role=dialog, so native previews hide and app
 * shortcuts stand down; no `data-focus-return`). On a new install it covers
 * Welcome; it never blocks autostart, reattach or the `keep` report, which
 * run underneath.
 */
export function SetupWizard({ onOpenSettings }: { onOpenSettings: (tab: CategoryId) => void }): ReactElement {
  const origin = useSetupWizardStore(s => s.origin)
  const finish = useSetupWizardStore(s => s.finish)
  const close = useSetupWizardStore(s => s.close)
  const [index, setIndex] = useState(0)
  const [voice, setVoice] = useState<VoiceChoice>('off')
  const [draft, setDraft] = useState<WorkspaceDraft>({ folder: '', count: 1, agent: 'terminal' })
  const [home, setHome] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const step = WIZARD_STEPS[index]

  useEffect(() => { void getHomeDir().then(setHome, () => setHome(null)) }, [])
  useEffect(() => {
    // A re-run starts from the current voice setting rather than "off".
    if (origin !== 'settings') return
    void getVoiceSettings().then(s => setVoice(!s.enabled ? 'off' : s.builtinEnabled ? 'builtin' : 'buzzkey'), () => {})
  }, [origin])

  // A first run is closed only by Skip or Finish; a re-run like Settings.
  useEffect(() => {
    if (origin !== 'settings') return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); close() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [origin, close])

  const saveVoice = async (): Promise<void> => {
    try {
      await setVoiceSettings(applyVoiceChoice(await getVoiceSettings(), voice))
    } catch (e) {
      console.warn('setup wizard: voice not saved', e)
    }
  }

  const next = async (): Promise<void> => {
    if (step === 'voice') await saveVoice()
    setIndex(i => Math.min(i + 1, WIZARD_STEPS.length - 1))
  }

  const complete = async (create: boolean): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      if (create) {
        const cwd = draft.folder.trim()
        useRecentsStore.getState().add(cwd)
        useAppStore.getState().createWorkspace({ cwd, terminalCount: draft.count, agentIds: wizardAgentIds(draft.count, draft.agent) })
      }
      await finish('done')
    } finally {
      setBusy(false)
    }
  }

  const canCreate = workspaceFolderProblem(draft.folder, home) !== 'empty'

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Set up Swarmterm"
        data-setup-wizard={step}
        className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
      >
        <header className="border-b border-border px-6 py-4">
          <h2 className="text-lg font-semibold text-foreground">Set up Swarmterm</h2>
          <ol className="mt-3 flex gap-4 text-xs" aria-label="Steps">
            {WIZARD_STEPS.map((s, i) => (
              <li key={s} aria-current={i === index ? 'step' : undefined} className={cn(i === index ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                {i + 1}. {STEP_TITLE[s]}
              </li>
            ))}
          </ol>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {step === 'prerequisites' && <PrerequisitesStep />}
          {step === 'signin' && <SigninStep />}
          {step === 'voice' && <VoiceStep choice={voice} onChoice={setVoice} />}
          {step === 'workspace' && <WorkspaceStep draft={draft} onDraft={setDraft} home={home} />}
        </div>

        <footer className="border-t border-border px-6 py-3">
          {step === 'workspace' && (
            <p className="mb-2 text-xs text-muted-foreground">
              Shells, launch modes and workspace defaults keep their standard values;{' '}
              <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => onOpenSettings('workspaces')}>
                change them in Settings
              </button>.
            </p>
          )}
          <div className="flex items-center justify-between gap-2">
            <Button variant="ghost" size="sm" onClick={() => void finish('skipped')} data-wizard-action="skip">
              Skip setup
            </Button>
            <div className="flex gap-2">
              {index > 0 && (
                <Button variant="outline" size="sm" onClick={() => setIndex(i => i - 1)} data-wizard-action="back">Back</Button>
              )}
              {step !== 'workspace' ? (
                <Button size="sm" onClick={() => void next()} data-wizard-action="next">Next</Button>
              ) : (
                <>
                  <Button variant="outline" size="sm" onClick={() => void complete(false)} disabled={busy} data-wizard-action="finish">
                    Finish without workspace
                  </Button>
                  <Button size="sm" onClick={() => void complete(true)} disabled={busy || !canCreate} data-wizard-action="create">
                    Create workspace
                  </Button>
                </>
              )}
            </div>
          </div>
        </footer>
      </div>
    </div>
  )
}
