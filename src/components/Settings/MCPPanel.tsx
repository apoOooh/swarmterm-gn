import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { MCP_CATALOG, MCP_CATALOG_VERSION } from '@/lib/mcp-catalog'
import { useAgentAccountsStore } from '@/store/agent-accounts-store'
import { configureAccountMcp, inspectAccountMcp, type CatalogStatus } from '@/tauri/mcp-catalog'
import { pickDirectory } from '@/tauri/dialog'
import { openUrl } from '@/tauri/opener'

export function MCPPanel(): React.ReactElement {
  const { accounts, error: accountError, refresh } = useAgentAccountsStore()
  const [selection, setSelection] = useState('claude-code:')
  const [status, setStatus] = useState<CatalogStatus | null>(null)
  const [directoryText, setDirectoryText] = useState('')
  const directories = directoryText.split('\n').map(path => path.trim()).filter(Boolean)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [agentId, accountId] = selection.split(':')
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    let cancelled = false
    setStatus(null); setError(null); setNotice(null)
    void inspectAccountMcp(agentId, accountId || undefined).then(result => { if (!cancelled) setStatus(result) }).catch(error => { if (!cancelled) setError(String(error)) })
    return () => { cancelled = true }
  }, [agentId, accountId])
  const add = async (entryId: string): Promise<void> => {
    setBusy(true); setError(null); setNotice(null)
    try {
      await configureAccountMcp(agentId, accountId || undefined, entryId, entryId === 'filesystem' ? directories : [])
      setStatus(await inspectAccountMcp(agentId, accountId || undefined))
      setNotice('Configuration added. Start a new pane for this account to load it. Complete any authentication in the agent CLI.')
    } catch (error) { setError(String(error)) }
    finally { setBusy(false) }
  }
  return <section className="space-y-5">
    <h2 className="text-lg font-semibold">MCP catalogue</h2>
    <p className="text-sm text-muted-foreground">Add reviewed server definitions to an account's CLI configuration. Existing servers remain intact. Packages may download when the CLI starts them; authentication and credentials stay with the CLI.</p>
    <label className="block text-sm">Account<select aria-label="MCP account" value={selection} disabled={busy} onChange={event => setSelection(event.target.value)} className="mt-1 block w-full rounded border border-input bg-background p-2">
      <option value="claude-code:">Claude Code · Default</option><option value="codex:">Codex · Default</option>
      {accounts.map(account => <option key={account.id} value={`${account.agentId}:${account.id}`}>{account.agentId === 'codex' ? 'Codex' : 'Claude Code'} · {account.name}</option>)}
    </select></label>
    {(error || accountError) && <p role="alert" className="text-sm text-destructive">{error ?? accountError}</p>}
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    <div className="space-y-3">{MCP_CATALOG.map(entry => {
      const current = status?.entries.find(item => item.id === entry.id)?.status
      return <article key={entry.id} className="space-y-2 rounded border border-border p-3" data-mcp-entry={entry.id}>
        <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">{entry.name}</h3><Button variant="outline" disabled={busy || !status || current !== 'available' || !!entry.directories && !directories.length} onClick={() => void add(entry.id)}>{current === 'configured' ? 'Configured' : current === 'conflict' ? 'Existing configuration' : 'Add configuration'}</Button></div>
        <p className="text-sm text-muted-foreground">{entry.description}</p><p className="text-xs text-muted-foreground">{entry.requirement}</p>
        {entry.directories && <div className="space-y-2">
          <label className="block text-xs">Allowed directories (one per line)<textarea aria-label="Filesystem allowed directories" value={directoryText} disabled={busy} onChange={event => setDirectoryText(event.target.value)} className="mt-1 block min-h-16 w-full rounded border border-input bg-background p-2" /></label>
          <Button variant="ghost" disabled={busy} onClick={() => void pickDirectory().then(path => { if (path) setDirectoryText(current => current.split('\n').includes(path) ? current : `${current}${current && !current.endsWith('\n') ? '\n' : ''}${path}`) }).catch(error => setError(String(error)))}>Choose directory</Button>
        </div>}
        {current === 'conflict' && <p className="text-xs text-muted-foreground">This server name already has a different definition. Manage it in the agent CLI; Swarmterm will preserve it.</p>}
        <button type="button" onClick={() => void openUrl(entry.documentationUrl).catch(error => setError(String(error)))} className="text-xs text-primary underline">Official documentation</button>
      </article>
    })}</div>
    <p className="text-xs text-muted-foreground">Catalogue version {MCP_CATALOG_VERSION}. Configured means the definition exists, not that the server is connected. Use the agent CLI to authenticate, check connectivity or remove servers.</p>
  </section>
}
