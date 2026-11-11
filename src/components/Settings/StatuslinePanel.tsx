import type { ReactElement } from 'react'
import { StatuslinePicker } from '@/components/Statusline/StatuslinePicker'

/**
 * Settings → Status line (SWA-92): its own category because template,
 * scheme, vibrance and preview are more than one switch under Terminal.
 */
export function StatuslinePanel(): ReactElement {
  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Status line</h1>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted-foreground">
          What Claude Code shows under the prompt in every Claude pane. Swarmterm writes one{' '}
          <span className="font-mono">statusLine</span> entry to{' '}
          <span className="font-mono">~/.claude/settings.json</span>; an existing custom status line is
          left untouched. Changes apply on the next refresh, the line wraps to the pane width.
        </p>
      </section>

      <section className="rounded-xl border border-border bg-card/40 p-5 sm:p-6">
        <h2 className="mb-4 text-sm font-semibold text-foreground">Claude Code</h2>
        <StatuslinePicker />
      </section>
    </div>
  )
}
