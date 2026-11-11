import { useEffect, useState, type ReactElement } from 'react'
import { Check, CheckCircle2, CircleAlert, CircleMinus, Copy, ExternalLink, RefreshCw, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { gitBashHint, prerequisiteRows, setupRows, type GitBashHint, type SetupTone } from '@/lib/setup-status'
import { writeClipboard } from '@/tauri/clipboard'
import { openUrl } from '@/tauri/opener'
import { useSetupStatusStore } from '@/store/setup-status-store'
import { useSetupWizardStore } from '@/store/setup-wizard-store'
import { cn } from '@/lib/utils'

const TONE_ICON: Record<SetupTone, typeof CheckCircle2> = {
  ok: CheckCircle2,
  muted: CircleMinus,
  warn: TriangleAlert,
  error: CircleAlert
}

const TONE_CLASS: Record<SetupTone, string> = {
  ok: 'text-emerald-500',
  muted: 'text-muted-foreground',
  warn: 'text-amber-500',
  error: 'text-destructive'
}

/** Git Bash missing: why, where to get it, and the command to copy (never run). */
function GitBashNote({ hint }: { hint: GitBashHint }): ReactElement {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void writeClipboard(hint.command).then(() => setCopied(true), () => setCopied(false))
  }
  return (
    <div data-setup-hint="git-bash" className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      <p className="text-foreground">{hint.text}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code className="rounded bg-muted px-2 py-1 font-mono text-xs text-foreground">{hint.command}</code>
        <Button variant="ghost" size="sm" onClick={copy} className="gap-1 text-muted-foreground">
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void openUrl(hint.link)} className="gap-1 text-muted-foreground">
          <ExternalLink className="h-3.5 w-3.5" />
          git-scm.com
        </Button>
      </div>
    </div>
  )
}

/**
 * Settings → Setup (SWA-83): what Swarmterm wrote into Claude Code's and
 * Codex's configuration and whether it worked. Read-only apart from
 * "Check again", which re-runs the Rust checks (and sets up a CLI that was
 * installed since the app started).
 */
export function SetupPanel(): ReactElement {
  const status = useSetupStatusStore(s => s.status)
  const checking = useSetupStatusStore(s => s.checking)
  const recheck = useSetupStatusStore(s => s.recheck)

  useEffect(() => { void recheck() }, [recheck])

  const rows = status ? setupRows(status) : []
  const bashHint = status ? gitBashHint(status) : null
  const tools = status ? prerequisiteRows(status) : []
  const agents = [...new Set(rows.map(r => r.agent))]

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Setup</h1>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted-foreground">
          Swarmterm adds a few entries to your agent CLIs so panes can report their state, show the status
          line and reach the War Room. Nothing is written for a CLI that is not installed; your own entries
          are kept.
        </p>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => useSetupWizardStore.getState().openAgain()} data-setup-action="wizard">
          Run setup assistant again
        </Button>
      </section>

      <section className="rounded-xl border border-border bg-card/40 p-5 sm:p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Agent integration</h2>
          <Button variant="ghost" size="sm" onClick={() => void recheck()} disabled={checking} className="gap-1 text-muted-foreground">
            <RefreshCw className={cn('h-3.5 w-3.5', checking && 'animate-spin')} />
            Check again
          </Button>
        </div>
        {status === null ? (
          <p className="text-sm text-muted-foreground">Checking…</p>
        ) : (
          <div className="space-y-5">
            {bashHint !== null && <GitBashNote hint={bashHint} />}
            {agents.map(agent => (
              <div key={agent}>
                <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{agent}</h3>
                <ul className="divide-y divide-border rounded-lg border border-border" aria-label={`${agent} integration`}>
                  {rows.filter(r => r.agent === agent).map(row => {
                    const Icon = TONE_ICON[row.tone]
                    return (
                      <li key={row.id} data-setup-item={row.id} data-tone={row.tone} className="flex items-start gap-3 px-3 py-2.5">
                        <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', TONE_CLASS[row.tone])} aria-hidden />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-3">
                            <span className="text-sm text-foreground first-letter:uppercase">{row.item}</span>
                            <span className={cn('text-xs', row.tone === 'error' ? 'text-destructive' : 'text-muted-foreground')}>{row.text}</span>
                          </div>
                          {row.detail !== null && (
                            <p className="mt-1 break-words font-mono text-xs text-muted-foreground">{row.detail}</p>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      {tools.length > 0 && (
        <section className="rounded-xl border border-border bg-card/40 p-5 sm:p-6">
          <h2 className="mb-4 text-sm font-semibold text-foreground">Prerequisites</h2>
          <ul className="divide-y divide-border rounded-lg border border-border" aria-label="Prerequisites">
            {tools.map(tool => {
              const Icon = tool.found ? CheckCircle2 : CircleMinus
              return (
                <li key={tool.id} data-prerequisite={tool.id} data-found={tool.found} className="flex items-start gap-3 px-3 py-2.5">
                  <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', TONE_CLASS[tool.found ? 'ok' : 'muted'])} aria-hidden />
                  <div className="flex min-w-0 flex-1 items-baseline justify-between gap-3">
                    <span className="text-sm text-foreground">{tool.name}</span>
                    <span className={cn('min-w-0 break-all text-right text-xs text-muted-foreground', tool.found && 'font-mono')}>{tool.text}</span>
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </div>
  )
}
