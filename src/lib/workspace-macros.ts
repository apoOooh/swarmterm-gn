import { APP_ACTIONS, type BuiltinActionId } from './app-actions'
export type MacroStep = { type: 'action'; actionId: BuiltinActionId } | { type: 'workspace'; agentIds: string[]; cwd?: string; accounts: 'default' | 'round-robin' }
export interface WorkspaceMacro { id: string; name: string; steps: MacroStep[] }
export function cleanMacro(m: WorkspaceMacro): WorkspaceMacro {
  return { id:m.id, name:m.name.trim(), steps:m.steps.map(s=>s.type==='action'?{type:'action',actionId:s.actionId}:{type:'workspace',agentIds:[...s.agentIds],accounts:s.accounts,...(s.cwd?{cwd:s.cwd}:{})}) }
}
/** Macros express app actions and workspace recipes; no shell text is executed. */
export function validateMacro(value: unknown): value is WorkspaceMacro {
  if (!value || typeof value !== 'object') return false
  const m = value as WorkspaceMacro
  return typeof m.id === 'string' && /^macro:[0-9a-f-]{36}$/i.test(m.id) && typeof m.name === 'string' && m.name.trim().length > 0 && m.name.length <= 80 && Array.isArray(m.steps) && m.steps.length > 0 && m.steps.length <= 16 && m.steps.every(s => {
    if (!s || typeof s !== 'object') return false
    if (s.type === 'action') return APP_ACTIONS.some(a => a.id === s.actionId && a.macro)
    return s.type === 'workspace' && Array.isArray(s.agentIds) && s.agentIds.length > 0 && s.agentIds.length <= 12 && s.agentIds.every(a => ['terminal','claude-code','codex'].includes(a)) && (s.cwd === undefined || typeof s.cwd === 'string' && s.cwd.length <= 32768) && ['default','round-robin'].includes(s.accounts)
  })
}
export function readShortcutSettings(raw: string | null): { bindings: Record<string,string>; macros: WorkspaceMacro[] } {
  try {
    const value = JSON.parse(raw ?? '{}')
    if (value.version !== 1) return { bindings: {}, macros: [] }
    const macros: WorkspaceMacro[] = [], seen = new Set<string>()
    for (const macro of Array.isArray(value.macros) ? value.macros.slice(0,24) : []) if (validateMacro(macro) && !seen.has(macro.id)) { seen.add(macro.id); macros.push(cleanMacro(macro)) }
    const bindings: Record<string,string> = {}
    const ids = new Set([...APP_ACTIONS.map(a => a.id), ...macros.map(m => m.id)])
    if (value.bindings && typeof value.bindings === 'object' && !Array.isArray(value.bindings)) for (const [id,binding] of Object.entries(value.bindings)) if (ids.has(id) && typeof binding === 'string') bindings[id] = binding
    return { bindings, macros }
  } catch { return { bindings: {}, macros: [] } }
}
