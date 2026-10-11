// Headless integration fixture. All filesystem, clipboard and PTY calls stay in memory.
// This entry is never imported by production main.tsx or included in its bundle.
import { mockIPC, mockWindows, mockConvertFileSrc } from '@tauri-apps/api/mocks'
import { emit } from '@tauri-apps/api/event'
import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/index.css'

interface Entry { path: string; dir?: boolean; content?: string; version?: number }
const files: Record<string, Entry> = {}
function add(path: string, content?: string): void { files[path] = { path, dir: content === undefined, content, version: 1 } }
add('/project'); add('/project/src'); add('/project/src/app.py', 'print("hello")\r\n'); add('/project/README.md', '# Welcome\n\nA **shared** project.\n\n[Source](src/app.py)\n'); add('/project/delete.txt', 'restore me'); add('/worktree'); add('/worktree/README.md', '# Isolated worktree'); add('/project/many')
add('/project/photo.png', 'image fixture')
for (let i = 0; i < 2000; i++) add(`/project/many/file-${i}.ts`, `export const n = ${i}\n`)
const contexts = new Map<string, string>()
const terminals = new Map<string, { cwd: string; channel: unknown }>()
const counters = { created: 0, killed: 0, spawns: [] as Record<string, any>[], writes: [] as string[], unknown: [] as string[], watched: 0, mediaStats: 0, openedMedia: [] as string[], marktext: [] as string[] }
const missingSessions = new Set<string>()
const unavailableAgents = new Set<string>()
const unavailableAccountDirs = new Set<string>()
const accounts: { id: string; agentId: string; name: string; configDir: string }[] = []
const mcpConfigurations: Record<string, Record<string, 'configured' | 'conflict'>> = {}
const mcpWrites: Record<string, any>[] = []
let nativeFiles: string[] = []
let textClipboard = ''
const snapshots: { id: string; path: string; created: number; bytes: number; isDir: boolean; content: string }[] = []
const changes = async (id: string, paths: string[]): Promise<void> => { await emit('files:changed', { contextId: id, paths, gitChanged: true }) }
mockWindows('main'); mockConvertFileSrc('windows')
mockIPC(async (command, raw) => {
  const args = raw as Record<string, any>
  if (command === 'plugin:path|resolve_directory') return '/project'
  if (command === 'create_terminal') { counters.created++; counters.spawns.push({ ...args.options, terminalId: args.id }); terminals.set(args.id, { cwd: args.options.cwd, channel: args.onData }); return { ok: true, pid: counters.created, shell: '/bin/bash' } }
  if (command === 'inspect_saved_workspace') return { rootAvailable: !!files[args.cwd]?.dir, panes: args.panes.map((p: any) => ({ directoryAvailable: !!files[p.cwd]?.dir, sessionAvailable: !missingSessions.has(p.sessionId), accountAvailable: !p.accountId || !unavailableAccountDirs.has(p.accountId) && accounts.some(account => account.id === p.accountId && account.agentId === p.agentId) })) }
  if (command === 'list_agent_accounts') return accounts.map(account => ({ ...account }))
  if (command === 'save_agent_account') { const input = args.account; const account = { ...input, id: input.id ?? crypto.randomUUID(), configDir: input.configDir ?? '/accounts/' + input.name }; const index = accounts.findIndex(a => a.id === account.id); if (index < 0) accounts.push(account); else accounts[index] = account; return account }
  if (command === 'delete_agent_account') { const index = accounts.findIndex(account => account.id === args.id); if (index >= 0) accounts.splice(index, 1); return }
  if (command === 'inspect_account_mcp') { const configured = mcpConfigurations[`${args.agentId}:${args.accountId ?? ''}`] ?? {}; return { version: 1, entries: ['playwright', 'github', 'context7', 'filesystem', 'memory', 'sequential-thinking', 'fetch'].map(id => ({ id, status: configured[id] ?? 'available' })) } }
  if (command === 'configure_account_mcp') {
    const key = `${args.agentId}:${args.accountId ?? ''}`; const configured = mcpConfigurations[key] ??= {}
    if (configured[args.entryId] === 'conflict') throw new Error('Existing configuration left unchanged')
    if (args.entryId === 'filesystem' && (!args.directories.length || args.directories.some((path: string) => !files[path]?.dir))) throw new Error('Filesystem requires existing absolute directories')
    mcpWrites.push({ ...args }); configured[args.entryId] = 'configured'; return
  }
  if (command === 'list_agent_sessions') return []
  if (command === 'kill_terminal') { counters.killed++; terminals.delete(args.id); return }
  if (command === 'plugin:dialog|message') return
  if (command === 'write_terminal') { counters.writes.push(args.data); return }
  if (command === 'resize_terminal' || command === 'report_agent_state') return
  if (command === 'files_open_context') { const t = terminals.get(args.terminalId); if (!t) throw new Error('Terminal is not ready'); const id = t.cwd === '/worktree' ? 'worktree' : 'project'; contexts.set(id, t.cwd); return { id, root: t.cwd } }
  if (command === 'files_watch') { counters.watched++; return }
  if (command === 'files_unwatch') { counters.watched--; return }
  if (command === 'files_request') {
    const q = args.request; const root = contexts.get(q.contextId)
    if (q.type === 'list') return Object.values(files).filter((e) => e.path !== q.path && e.path.slice(0, e.path.lastIndexOf('/')) === q.path).map((e) => ({ name: e.path.split('/').pop(), path: e.path, isDir: !!e.dir, isSymlink: false }))
    if (q.type === 'read') { const e = files[q.path]; if (!e) throw new Error('File missing'); return { content: e.content, version: String(e.version), binary: false, truncated: false, bom: false } }
    if (q.type === 'mediaStat') { counters.mediaStats++; const e = files[q.path]; if (!e) throw new Error('File missing'); return { size: e.content?.length ?? 0, mtimeMs: e.version } }
    if (q.type === 'openMedia') { counters.openedMedia.push(q.path); return }
    if (q.type === 'write') { const e = files[q.path]; if (!e || String(e.version) !== q.expectedVersion) throw new Error('File changed on disk'); e.content = q.content; e.version!++; await changes(q.contextId, [q.path]); return { version: String(e.version) } }
    if (q.type === 'git') return q.contextId === 'project' ? [{ path: 'src/app.py', status: 'M', added: 1, removed: 0 }] : []
    if (q.type === 'create') { const path = `${q.directory}/${q.name}`; if (files[path]) throw new Error('Exists'); add(path, q.isDir ? undefined : ''); await changes(q.contextId, [path]); return path }
    if (q.type === 'rename') { const dest = q.path.slice(0, q.path.lastIndexOf('/') + 1) + q.name; if (files[dest]) throw new Error('Exists'); for (const p of Object.keys(files)) if (p === q.path || p.startsWith(q.path + '/')) { const next = dest + p.slice(q.path.length); files[next] = { ...files[p], path: next }; delete files[p] } await changes(q.contextId, [q.path, dest]); return dest }
    if (q.type === 'remove') { for (const path of q.paths) { const e = files[path]; if (!e) continue; snapshots.unshift({ id: `snapshot-${snapshots.length}`, path, content: e.content ?? '', created: Date.now(), bytes: e.content?.length ?? 0, isDir: !!e.dir }); delete files[path] } await changes(q.contextId, q.paths); return { removed: q.paths, snapshots, warnings: [] } }
    if (q.type === 'history') return snapshots.filter((s) => s.path.startsWith(root + '/'))
    if (q.type === 'restore') { const s = snapshots.find((s) => s.id === q.id)!; const path = files[s.path] ? s.path.replace(/(\.[^./]+)?$/, ' copy$1') : s.path; add(path, s.content); await changes(q.contextId, [path]); return path }
    if (q.type === 'clipboardWrite') { nativeFiles = q.paths; return }
    if (q.type === 'clipboardRead') return nativeFiles
    if (q.type === 'transfer' || q.type === 'clipboardImport') {
      const paths = q.paths ?? nativeFiles; const completed = []
      for (const source of paths) { const name = source.split('/').pop(); let destination = q.directory + '/' + name; if (files[destination]) destination = destination.replace(/(\.[^./]+)?$/, ' copy$1'); files[destination] = { ...files[source], path: destination }; if (q.cut) delete files[source]; completed.push({ source, destination }) }
      await changes(q.contextId, completed.flatMap((c) => [c.source, c.destination])); return { completed, errors: [] }
    }
    if (q.type === 'reveal') return
    if (q.type === 'openMarkText') { counters.marktext.push(q.path); return }
    if (q.type === 'locateMarkText') return 'C:/Users/test/AppData/Local/Programs/marktext/marktext.exe'
    throw new Error(`Unexpected file command ${q.type}`)
  }
  if (command === 'plugin:app|version') return '1.0.4-gn'
  if (command === 'plugin:clipboard-manager|write_text') { textClipboard = args.text; return }
  if (command === 'plugin:clipboard-manager|read_text') return textClipboard
  if (command === 'plugin:notification|is_permission_granted') return true
  if (command.includes('is_maximized') || command.includes('is_fullscreen')) return false
  if (command === 'list_available_shells') return [{ id: 'default', name: 'System default', available: true }]
  if (command === 'list_available_agents') return ['claude-code', 'codex'].map(id => ({ id, available: !unavailableAgents.has(id), sessionHooks: true }))
  if (command === 'git_list_worktrees') return []
  if (command === 'war_room_rooms') return [{ roomId: 'lobby', name: 'Lobby', members: [] }]
  if (command === 'set_claude_statusline') return { installed: false }
  if (command.startsWith('plugin:window|') || command.startsWith('plugin:webview|') || command.startsWith('plugin:app|') || command.startsWith('plugin:store|') || command.startsWith('plugin:opener|')) return
  counters.unknown.push(command)
}, { shouldMockEvents: true })
const { useAppStore } = await import('../../src/store/app-store')
const { useDocumentStore } = await import('../../src/store/document-store')
const { useExplorerStore } = await import('../../src/store/explorer-store')
const { useAppearanceStore } = await import('../../src/store/appearance-store')
const { applyVisualStyle } = await import('../../src/lib/theme-adapter')
applyVisualStyle(useAppearanceStore.getState().style)
if (!new URLSearchParams(location.search).has('welcome')) useAppStore.getState().createWorkspace({ cwd: '/project', terminalCount: 2, agentIds: ['terminal', 'terminal'], paneWorktrees: [null, { path: '/worktree', branch: 'feature' }] })
Object.assign(window, { fixture: { counters, accounts, mcpConfigurations, mcpWrites, files, missingSessions, unavailableAgents, unavailableAccountDirs, emit, useAppStore, useDocumentStore, useExplorerStore, useAppearanceStore,
  change: async (path: string, content: string) => { const e = files[path]; e.content = content; e.version!++; await changes(path.startsWith('/worktree/') ? 'worktree' : 'project', [path]) },
  setNativeFiles: (paths: string[]) => { nativeFiles = paths }, textClipboard: () => textClipboard } })
const { default: App } = await import('../../src/App')
createRoot(document.getElementById('root')!).render(<App />)
