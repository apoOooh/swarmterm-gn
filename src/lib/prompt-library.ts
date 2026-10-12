/**
 * Saved prompts and their dispatch targets (SWA-23).
 *
 * The library holds only what the user explicitly saved — titles and prompt
 * text — in the renderer's local storage. It never captures terminal output
 * and is unrelated to saved workspaces, which deliberately persist no prompts.
 * Dispatch itself is not decided here: an existing pane goes through the
 * one-shot delivery path (holds, generation check), a new pane gets the text
 * as its start argument like a worktree worker.
 */

export interface SavedPrompt {
  id: string
  title: string
  body: string
  updatedAt: number
}

export const MAX_PROMPTS = 200
export const MAX_PROMPT_CHARS = 20_000
const MAX_TITLE_CHARS = 120

/** Agents a prompt can be dispatched to (they accept a prompt as input). */
export const PROMPT_AGENTS: readonly string[] = ['claude-code', 'codex']

export function validatePrompt(p: { title: string; body: string }): string | null {
  const title = p.title.trim()
  if (!title || title.length > MAX_TITLE_CHARS) return `Give the prompt a title (up to ${MAX_TITLE_CHARS} characters).`
  if (!p.body.trim()) return 'The prompt text is empty.'
  if (p.body.length > MAX_PROMPT_CHARS) return `The prompt is too long (max ${MAX_PROMPT_CHARS} characters).`
  return null
}

/** Insert (on top) or replace by id. A new prompt beyond the cap is refused (same list back). */
export function upsertPrompt(list: readonly SavedPrompt[], prompt: SavedPrompt): SavedPrompt[] {
  const clean = { ...prompt, title: prompt.title.trim() }
  const exists = list.some((x) => x.id === prompt.id)
  if (!exists && list.length >= MAX_PROMPTS) return list as SavedPrompt[]
  return [clean, ...list.filter((x) => x.id !== prompt.id)]
}

export function removePrompt(list: readonly SavedPrompt[], id: string): SavedPrompt[] {
  return list.filter((x) => x.id !== id)
}

/** Every whitespace-separated word must occur in title or body. */
export function filterPrompts(list: readonly SavedPrompt[], query: string): SavedPrompt[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...list]
  return list.filter((p) => {
    const hay = `${p.title}\n${p.body}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

export function serializePromptLibrary(list: readonly SavedPrompt[]): string {
  return JSON.stringify({ version: 1, prompts: list })
}

/** Lenient: unknown versions, garbage and invalid entries yield nothing rather than an error. */
export function parsePromptLibrary(raw: string | null): SavedPrompt[] {
  if (!raw) return []
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  const d = data as { version?: unknown; prompts?: unknown }
  if (d?.version !== 1 || !Array.isArray(d.prompts)) return []
  const seen = new Set<string>()
  const out: SavedPrompt[] = []
  for (const x of d.prompts as Partial<SavedPrompt>[]) {
    if (typeof x?.id !== 'string' || typeof x.title !== 'string' || typeof x.body !== 'string') continue
    if (seen.has(x.id) || validatePrompt({ title: x.title, body: x.body }) !== null) continue
    seen.add(x.id)
    out.push({ id: x.id, title: x.title, body: x.body, updatedAt: typeof x.updatedAt === 'number' ? x.updatedAt : 0 })
    if (out.length >= MAX_PROMPTS) break
  }
  return out
}

export interface PaneInfo {
  terminalId: string
  agentId: string
  title: string
  running: boolean
}

export interface DispatchTarget {
  terminalId: string
  label: string
}

/** Running agent panes across all workspaces; plain shells are never a target. */
export function dispatchTargets(
  workspaces: readonly { workspaceName: string; panes: readonly PaneInfo[] }[],
  agentName: (agentId: string) => string
): DispatchTarget[] {
  return workspaces.flatMap((w) =>
    w.panes
      .filter((p) => p.running && PROMPT_AGENTS.includes(p.agentId))
      .map((p) => ({
        terminalId: p.terminalId,
        label: [w.workspaceName, agentName(p.agentId), p.title.trim()].filter(Boolean).join(' · ')
      }))
  )
}
