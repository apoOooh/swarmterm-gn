import { ampManifest } from '@/lib/agent-state/manifests/amp'
import { antigravityManifest } from '@/lib/agent-state/manifests/antigravity'
import { claudeCodeManifest } from '@/lib/agent-state/manifests/claude-code'
import { codexManifest } from '@/lib/agent-state/manifests/codex'
import { copilotManifest } from '@/lib/agent-state/manifests/copilot'
import { cursorManifest } from '@/lib/agent-state/manifests/cursor'
import { geminiManifest } from '@/lib/agent-state/manifests/gemini'
import { opencodeManifest } from '@/lib/agent-state/manifests/opencode'
import { qwenManifest } from '@/lib/agent-state/manifests/qwen'
import { perfMockManifest } from '@/lib/agent-state/manifests/perf-mock'
import type { Manifest } from '@/lib/agent-state/types'
import { PERF_MOCK_AGENT_ID } from '@/lib/templates'

/** Keyed by workspace template id (src/lib/templates.ts), NOT herdr agent id. */
const MANIFESTS: Record<string, Manifest> = {
  'claude-code': claudeCodeManifest,
  codex: codexManifest,
  opencode: opencodeManifest,
  copilot: copilotManifest,
  qwen: qwenManifest,
  amp: ampManifest,
  gemini: geminiManifest,
  cursor: cursorManifest,
  antigravity: antigravityManifest
  // omp: deliberately absent — herdr is hooks-only for it (no screen rules
  // to port); the pane keeps the legacy ActivityDot. See the design spec.
}

/** undefined for plain 'terminal' panes and unknown ids — no detection. */
export function manifestForAgent(agentId: string | undefined): Manifest | undefined {
  // Perf harness pseudo agent: dev builds only, like its template.
  if (agentId === PERF_MOCK_AGENT_ID) return import.meta.env.DEV === true ? perfMockManifest : undefined
  return agentId === undefined ? undefined : MANIFESTS[agentId]
}
