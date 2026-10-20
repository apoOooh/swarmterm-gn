/**
 * Detection rules for the perf harness's pseudo agent (`perf-mock-agent`,
 * src/lib/templates.ts): scripts/perf/agent-stream.mjs in `--mock` mode sets
 * its OSC 0 title to `perf-mock working` or `perf-mock idle` on every phase
 * change and about once a second. Dev builds only (see manifests/index.ts).
 */
import type { Manifest } from '@/lib/agent-state/types'

export const perfMockManifest: Manifest = {
  id: 'perf-mock-agent',
  herdrVersion: 'perf-mock',
  rules: [
    {
      id: 'osc_title_working',
      state: 'working',
      priority: 1050,
      region: 'osc_title',
      visibleWorking: true,
      contains: ['perf-mock working']
    },
    {
      id: 'osc_title_idle',
      state: 'idle',
      priority: 50,
      region: 'osc_title',
      visibleIdle: true,
      contains: ['perf-mock idle']
    }
  ]
}
