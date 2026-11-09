import { useEffect, type ReactElement } from 'react'
import { CheckCircle2, CircleAlert, CircleMinus, RefreshCw, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { setupRows, type SetupTone } from '@/lib/setup-status'
import { useSetupStatusStore } from '@/store/setup-status-store'
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
    </div>
  )
}
