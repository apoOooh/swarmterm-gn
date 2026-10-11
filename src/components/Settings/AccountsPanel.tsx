import { useEffect, useState } from 'react'
import { useAgentAccountsStore } from '@/store/agent-accounts-store'
import { useAppStore } from '@/store/app-store'
import { getHomeDir, pickDirectory } from '@/tauri/dialog'
import { Button } from '@/components/ui/button'
import { templateById } from '@/lib/templates'
import type { AgentAccount } from '@/tauri/accounts'

export function AccountsPanel({ onLogin }: { onLogin: () => void }): React.ReactElement {
  const { accounts, error, refresh, save, remove } = useAgentAccountsStore()
  const [editing, setEditing] = useState<string | undefined>()
  const [agentId, setAgentId] = useState<AgentAccount['agentId']>('claude-code')
  const [name, setName] = useState('')
  const [configDir, setConfigDir] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  useEffect(() => { void refresh() }, [refresh])
  const reset = (): void => { setEditing(undefined); setName(''); setConfigDir(''); setFailure(null) }
  const login = async (agent: AgentAccount['agentId'], accountId?: string): Promise<void> => {
    try {
      const cwd = await getHomeDir()
      useAppStore.getState().createWorkspace({ cwd, terminalCount: 1, agentIds: [agent], accountIds: [accountId], startupCommands: [agent === 'codex' ? 'codex login' : 'claude auth login'] })
      onLogin()
    } catch (error) { setFailure(String(error)) }
  }
  return <section className="space-y-5">
    <h2 className="text-lg font-semibold">Accounts</h2>
    <p className="text-sm text-muted-foreground">Keep separate Claude Code and Codex logins in isolated CLI configuration folders. Credentials stay in the CLI's own configuration. Swarmterm stores profile names and folder references.</p>
    {(error || failure) && <p role="alert" className="text-sm text-destructive">{failure ?? error}</p>}
    <div className="space-y-2">
      {(['claude-code', 'codex'] as const).map(agent => <div key={agent} className="flex items-center justify-between rounded border border-border p-3">
        <span className="text-sm">{templateById(agent).name} · Default</span>
        <Button variant="outline" onClick={() => void login(agent)}>Log in</Button>
      </div>)}
      {accounts.map(account => <div key={account.id} className="rounded border border-border p-3">
        <div className="flex items-center gap-2">
          <span className="flex-1 text-sm font-medium">{templateById(account.agentId).name} · {account.name}</span>
          <Button variant="outline" onClick={() => void login(account.agentId, account.id)}>Log in</Button>
          <Button variant="ghost" onClick={() => { setEditing(account.id); setAgentId(account.agentId); setName(account.name); setConfigDir(account.configDir); setFailure(null) }}>Edit</Button>
          <Button variant="ghost" disabled={busy} onClick={() => { setBusy(true); void remove(account.id).then(() => { if (editing === account.id) reset() }).catch(error => setFailure(String(error))).finally(() => setBusy(false)) }}>Remove</Button>
        </div>
        <p className="mt-1 break-all text-xs text-muted-foreground">{account.configDir}</p>
      </div>)}
    </div>
    <form className="space-y-3 border-t border-border pt-4" onSubmit={event => {
      event.preventDefault(); setBusy(true); setFailure(null)
      void save({ id: editing, agentId, name: name.trim(), configDir: configDir.trim() || undefined }).then(reset).catch(error => setFailure(String(error))).finally(() => setBusy(false))
    }}>
      <h3 className="text-sm font-medium">{editing ? 'Edit account profile' : 'Add account profile'}</h3>
      <label className="block text-sm">Agent<select aria-label="Account agent" value={agentId} disabled={!!editing} onChange={event => setAgentId(event.target.value as AgentAccount['agentId'])} className="mt-1 block w-full rounded border border-input bg-background p-2"><option value="claude-code">Claude Code</option><option value="codex">Codex</option></select></label>
      <label className="block text-sm">Name<input aria-label="Account name" value={name} maxLength={80} onChange={event => setName(event.target.value)} className="mt-1 block w-full rounded border border-input bg-background p-2" required /></label>
      <label className="block text-sm">Configuration folder (optional)<div className="mt-1 flex gap-2"><input aria-label="Account configuration folder" value={configDir} onChange={event => setConfigDir(event.target.value)} placeholder="Create an isolated folder automatically" className="min-w-0 flex-1 rounded border border-input bg-background p-2" /><Button type="button" variant="outline" onClick={() => void pickDirectory().then(path => { if (path) setConfigDir(path) })}>Browse</Button></div></label>
      <p className="text-xs text-muted-foreground">Removing a profile leaves its configuration and credentials on disk. Existing panes keep running. Saved panes whose profile was removed start fresh with the default account.</p>
      <div className="flex gap-2"><Button disabled={busy || !name.trim()} type="submit">{editing ? 'Save profile' : 'Add profile'}</Button>{editing && <Button type="button" variant="ghost" onClick={reset}>Cancel</Button>}</div>
    </form>
  </section>
}
