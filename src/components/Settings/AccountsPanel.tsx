import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { useAgentAccountsStore } from '@/store/agent-accounts-store'
import { useAccountUsageStore } from '@/store/account-usage-store'
import { useAppStore } from '@/store/app-store'
import { getHomeDir } from '@/tauri/dialog'
import { revealInFileManager } from '@/tauri/links'
import { Button } from '@/components/ui/button'
import { accountUsageKey } from '@/lib/account-usage'
import { templateById } from '@/lib/templates'
import type { AgentAccount } from '@/tauri/accounts'
import { AccountCard } from './AccountCard'
import { AddAccountWizard } from './AddAccountWizard'

const AGENTS = ['claude-code', 'codex'] as const

export function AccountsPanel({ onLogin }: { onLogin: () => void }): React.ReactElement {
  const { accounts, error, statuses, refresh, refreshStatus, watchLogin, save, remove } = useAgentAccountsStore()
  const usage = useAccountUsageStore(s => s.byAccount)
  const [adding, setAdding] = useState(false)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | undefined>()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => { void refresh() }, [refresh])
  // Re-check every profile whenever the panel opens or the list changes —
  // logins finished in a pane land here without a manual refresh.
  useEffect(() => {
    for (const agent of AGENTS) void refreshStatus(agent)
    for (const a of accounts) void refreshStatus(a.agentId, a.id)
  }, [accounts, refreshStatus])

  const login = async (agent: AgentAccount['agentId'], accountId?: string): Promise<void> => {
    try {
      const cwd = await getHomeDir()
      useAppStore.getState().createWorkspace({ cwd, terminalCount: 1, agentIds: [agent], accountIds: [accountId], startupCommands: [agent === 'codex' ? 'codex login' : 'claude auth login'] })
      watchLogin(agent, accountId)
      onLogin()
    } catch (error) { setFailure(String(error)) }
  }
  const run = (task: () => Promise<unknown>): void => {
    setBusy(true); setFailure(null)
    void task().catch(error => setFailure(String(error))).finally(() => setBusy(false))
  }
  const card = (agentId: AgentAccount['agentId'], account?: AgentAccount): React.ReactElement => {
    const key = accountUsageKey(agentId, account?.id)
    return <AccountCard key={key} agentName={templateById(agentId).name} name={account?.name ?? 'Default'}
      status={statuses[key]} usage={usage[key]} configDir={account?.configDir}
      onLogin={() => void login(agentId, account?.id)}
      onRename={account && (() => setRenaming({ id: account.id, name: account.name }))}
      onShowFolder={account && (() => void revealInFileManager(account.configDir).catch(e => setFailure(String(e))))}
      onRemove={account && (() => run(() => remove(account.id)))} />
  }

  return <section className="space-y-4">
    <div className="flex items-center justify-between">
      <h2 className="text-lg font-semibold">Accounts</h2>
      {!adding && <Button size="sm" onClick={() => { setAdding(true); setFailure(null) }}><Plus className="h-4 w-4" />Add account</Button>}
    </div>
    {(error || failure) && <p role="alert" className="text-sm text-destructive">{failure ?? error}</p>}
    {adding && <AddAccountWizard existing={accounts} busy={busy} onCancel={() => setAdding(false)} onCreate={input => run(async () => {
      // Log into the profile the write returned. Diffing the reread list
      // could come up empty and silently log into the default account.
      const created = await save(input)
      setAdding(false)
      await login(input.agentId, created.id)
    })} />}
    {renaming && <form className="flex gap-2" onSubmit={e => {
      e.preventDefault()
      const account = accounts.find(a => a.id === renaming.id)
      if (account) run(async () => { await save({ id: account.id, agentId: account.agentId, name: renaming.name.trim(), configDir: account.configDir }); setRenaming(undefined) })
    }}>
      <input aria-label="Account name" autoFocus value={renaming.name} maxLength={80} onChange={e => setRenaming({ ...renaming, name: e.target.value })} className="min-w-0 flex-1 rounded border border-input bg-background p-2 text-sm" />
      <Button type="submit" size="sm" disabled={busy || !renaming.name.trim()}>Save</Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(undefined)}>Cancel</Button>
    </form>}
    {AGENTS.map(agent => <div key={agent} className="space-y-1.5">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{templateById(agent).name}</h3>
      {card(agent)}
      {accounts.filter(a => a.agentId === agent).map(a => card(agent, a))}
    </div>)}
    <p className="text-xs text-muted-foreground">Credentials stay in each CLI's own folder; Swarmterm stores names and folder references only. Removing a profile leaves its folder on disk. Usage: Claude Code via its status line while a pane runs, Codex from its session logs.</p>
  </section>
}
