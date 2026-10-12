import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { pickFolder } from '@/store/folder-picker-store'
import { nextAccountName } from '@/lib/account-status'
import { templateById } from '@/lib/templates'
import type { AgentAccount } from '@/tauri/accounts'

const PROVIDERS: { id: AgentAccount['agentId']; hint: string }[] = [
  { id: 'claude-code', hint: 'Anthropic · Claude Pro / Max' },
  { id: 'codex', hint: 'OpenAI · ChatGPT Plus / Pro' }
]

/**
 * Two steps: pick the provider, then name it and log in. The login itself
 * runs in a terminal pane (the CLIs' own flow), which closes Settings — so
 * the "waiting for login" part is the store's background watch, not this view.
 */
export function AddAccountWizard({ existing, busy, onCancel, onCreate }: {
  existing: AgentAccount[]
  busy: boolean
  onCancel: () => void
  onCreate: (input: { agentId: AgentAccount['agentId']; name: string; configDir?: string }) => void
}): React.ReactElement {
  const [agentId, setAgentId] = useState<AgentAccount['agentId'] | undefined>()
  const [name, setName] = useState('')
  const [configDir, setConfigDir] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const choose = (id: AgentAccount['agentId']): void => {
    setAgentId(id)
    setName(nextAccountName(templateById(id).name, existing.filter(a => a.agentId === id).map(a => a.name)))
  }
  if (!agentId) {
    return <div className="space-y-3 rounded border border-border p-4">
      <h3 className="text-sm font-medium">Add account — choose a provider</h3>
      <div className="grid grid-cols-2 gap-2">
        {PROVIDERS.map(p => <button key={p.id} type="button" onClick={() => choose(p.id)}
          className="rounded border border-border p-3 text-left hover:border-primary hover:bg-accent">
          <div className="text-sm font-medium">{templateById(p.id).name}</div>
          <div className="text-xs text-muted-foreground">{p.hint}</div>
        </button>)}
      </div>
      <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
    </div>
  }
  return <form className="space-y-3 rounded border border-border p-4" onSubmit={event => {
    event.preventDefault()
    onCreate({ agentId, name: name.trim(), configDir: configDir.trim() || undefined })
  }}>
    <h3 className="text-sm font-medium">Add {templateById(agentId).name} account</h3>
    <label className="block text-sm">Name<input aria-label="Account name" autoFocus value={name} maxLength={80} onChange={e => setName(e.target.value)} className="mt-1 block w-full rounded border border-input bg-background p-2" required /></label>
    <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setAdvanced(v => !v)}>{advanced ? '▾' : '▸'} Advanced</button>
    {advanced && <label className="block text-sm">Configuration folder<div className="mt-1 flex gap-2"><input aria-label="Account configuration folder" value={configDir} onChange={e => setConfigDir(e.target.value)} placeholder="Isolated folder, created automatically" className="min-w-0 flex-1 rounded border border-input bg-background p-2" /><Button type="button" variant="outline" onClick={() => void pickFolder().then(path => { if (path) setConfigDir(path) })}>Browse</Button></div></label>}
    <p className="text-xs text-muted-foreground">A terminal opens with the {templateById(agentId).name} login. Finish it there — the account shows up as connected here.</p>
    <div className="flex gap-2">
      <Button type="submit" disabled={busy || !name.trim()}>Continue &amp; log in</Button>
      <Button type="button" variant="ghost" onClick={() => setAgentId(undefined)}>Back</Button>
    </div>
  </form>
}
