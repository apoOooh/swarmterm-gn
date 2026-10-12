import { useCallback, useEffect, useState } from 'react'
import { setSwarmtermMcp, swarmtermMcpProfiles, type SwarmtermMcpProfile } from '@/tauri/swarmterm-mcp'

const AGENT_NAMES: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', qwen: 'Qwen Code', opencode: 'OpenCode' }

const rowKey = (p: SwarmtermMcpProfile): string => `${p.agentId}:${p.accountId ?? 'default'}`

/** One switch per agent × account for Swarmterm's own MCP server (War Room,
 *  browser, worktree tools). Details stay collapsed; the catalogue below is
 *  separate. Off removes only Swarmterm's entry and keeps it from returning. */
export function SwarmtermMcpSwitches(): React.ReactElement {
  const [profiles, setProfiles] = useState<SwarmtermMcpProfile[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(async () => {
    try { setProfiles(await swarmtermMcpProfiles()) } catch (e) { setError(String(e)) }
  }, [])
  useEffect(() => { void reload() }, [reload])
  const toggle = async (p: SwarmtermMcpProfile): Promise<void> => {
    setBusy(rowKey(p)); setError(null)
    try { await setSwarmtermMcp(p.agentId, p.accountId, !p.enabled); await reload() }
    catch (e) { setError(String(e)) }
    finally { setBusy(null) }
  }
  return <section className="space-y-3" data-swarmterm-mcp>
    <h2 className="text-lg font-semibold">Swarmterm MCP</h2>
    <p className="text-sm text-muted-foreground">Connects agents to the War Room and Swarmterm's tools. New panes connect automatically; restart a running pane after switching.</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {profiles === null ? <p className="text-sm text-muted-foreground">Loading…</p> : <ul className="divide-y divide-border rounded border border-border">
      {profiles.map(p => {
        const key = rowKey(p)
        return <li key={key} className="p-2" data-mcp-profile={key}>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm">{AGENT_NAMES[p.agentId] ?? p.agentId} · {p.accountName ?? 'Default'}</span>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              {p.entry === 'foreign' ? 'Own entry kept' : p.enabled ? 'On' : 'Off'}
              <input type="checkbox" role="switch" aria-label={`Swarmterm MCP for ${AGENT_NAMES[p.agentId] ?? p.agentId} ${p.accountName ?? 'Default'}`} checked={p.enabled} disabled={busy !== null} onChange={() => void toggle(p)} />
            </label>
          </div>
          <details className="mt-1 text-xs text-muted-foreground">
            <summary className="cursor-pointer">Details</summary>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
              <dt>Config</dt><dd className="break-all">{p.configPath}</dd>
              <dt>Server</dt><dd className="break-all">{p.url ?? 'not running'}</dd>
              <dt>Entry</dt><dd>{p.entry === 'ours' ? 'written by Swarmterm' : p.entry === 'foreign' ? 'a different "swarmterm" server is configured — Swarmterm leaves it untouched' : p.entry === 'perPane' ? 'passed to each new pane; no configuration file is written' : 'not present'}</dd>
            </dl>
          </details>
        </li>
      })}
    </ul>}
  </section>
}
