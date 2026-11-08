// Renderer-side profile capture for flood.perf.ts (docs/perf-profiling.md).
// Active only when PERF_PROFILE is set (cpu | trace | mem) by
// `flood.ps1 -Profile`; raw files go to PERF_PROFILE_DIR and are summarized
// by scripts/perf/profile-summary.mjs. Every capture perturbs the run, so
// these numbers never go into A/B tables.
import type { Browser, CDPSession, Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type ProfileMode = 'cpu' | 'trace' | 'mem'

type ProcInfo = { type: string; id: number; cpuTime: number }

async function processInfo(b: CDPSession): Promise<ProcInfo[]> {
  // Browser-target only; cpuTime is cumulative seconds per process.
  const r: any = await b.send('SystemInfo.getProcessInfo' as any).catch(() => ({ processInfo: [] }))
  return r.processInfo ?? []
}

function cpuByType(before: ProcInfo[], after: ProcInfo[], seconds: number): Record<string, { pids: number; cpuS: number; avgCores: number }> {
  // A pid born mid-run counts its whole (near-zero at birth) cumulative time;
  // a pid that exited mid-run is missing from `after` and drops out. Both are
  // small for renderer/gpu/browser, which live for the whole run.
  const prev = new Map(before.map(p => [p.id, p.cpuTime]))
  const out: Record<string, { pids: number; cpuS: number; avgCores: number }> = {}
  for (const p of after) {
    const row = out[p.type] ??= { pids: 0, cpuS: 0, avgCores: 0 }
    row.pids++
    row.cpuS += p.cpuTime - (prev.get(p.id) ?? 0)
  }
  for (const row of Object.values(out)) row.avgCores = seconds > 0 ? row.cpuS / seconds : 0
  return out
}

/** Starts the captures for `mode`; the returned function stops them and writes the files. */
export async function startProfile(browser: Browser, page: Page, mode: ProfileMode, dir: string): Promise<() => Promise<void>> {
  mkdirSync(dir, { recursive: true })
  const cdp = await page.context().newCDPSession(page)
  const bcdp = await browser.newBrowserCDPSession()
  await cdp.send('Performance.enable')
  const metrics0 = await cdp.send('Performance.getMetrics')
  const proc0 = await processInfo(bcdp)
  const t0 = Date.now()

  // Long Animation Frames with script attribution (Chromium 123+). Buffered
  // entries before this point belong to setup and are dropped.
  await page.evaluate(() => {
    const w = window as any
    w.__perfLoaf = []
    try {
      w.__perfLoafObs?.disconnect()
      w.__perfLoafObs = new PerformanceObserver(list => {
        for (const e of list.getEntries() as any[]) {
          w.__perfLoaf.push({
            start: e.startTime, duration: e.duration, blocking: e.blockingDuration,
            scripts: (e.scripts ?? []).map((s: any) => ({ src: s.sourceURL, fn: s.sourceFunctionName, invoker: s.invoker, duration: s.duration, forcedLayout: s.forcedStyleAndLayoutDuration }))
          })
        }
      })
      w.__perfLoafObs.observe({ type: 'long-animation-frame', buffered: false })
    } catch { w.__perfLoaf = null }
  })

  if (mode === 'cpu') {
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', { interval: 1000 })
    await cdp.send('Profiler.start')
  } else if (mode === 'mem') {
    await cdp.send('HeapProfiler.enable')
    await cdp.send('HeapProfiler.startSampling', { samplingInterval: 32768 })
  }
  let tracing: Promise<void> | undefined
  let endTrace: (() => void) | undefined
  if (mode === 'trace') {
    // One bounded window: a full-run trace of a flood is GBs.
    const secs = Math.min(30, Math.max(5, Number(process.env.PERF_PROFILE_TRACE_S ?? '15')))
    await browser.startTracing(page, { path: join(dir, 'trace.json'), screenshots: false, categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'v8.execute', 'disabled-by-default-v8.cpu_profiler', 'gpu', 'ipc', 'toplevel'] })
    // Covers only the first `secs` of a longer scenario; a shorter one stops
    // it early in the returned stop function.
    tracing = new Promise<void>(r => { endTrace = r; setTimeout(r, secs * 1000) }).then(async () => { await browser.stopTracing() })
  }

  return async () => {
    const seconds = (Date.now() - t0) / 1000
    endTrace?.()
    if (tracing) await tracing
    if (mode === 'cpu') {
      const { profile } = await cdp.send('Profiler.stop')
      writeFileSync(join(dir, 'renderer.cpuprofile'), JSON.stringify(profile))
    } else if (mode === 'mem') {
      const { profile } = await cdp.send('HeapProfiler.stopSampling')
      writeFileSync(join(dir, 'renderer.heapprofile'), JSON.stringify(profile))
    }
    const loaf = await page.evaluate(() => { const w = window as any; w.__perfLoafObs?.disconnect(); return w.__perfLoaf })
    const metrics1 = await cdp.send('Performance.getMetrics')
    const proc1 = await processInfo(bcdp)
    const m = (x: { metrics: { name: string; value: number }[] }) => Object.fromEntries(x.metrics.map(e => [e.name, e.value]))
    writeFileSync(join(dir, 'renderer.json'), JSON.stringify({
      mode, seconds,
      metrics: { start: m(metrics0), end: m(metrics1) },
      processCpu: cpuByType(proc0, proc1, seconds),
      loaf: loaf ?? 'unsupported'
    }, null, 1))
    await cdp.detach().catch(() => {})
    await bcdp.detach().catch(() => {})
  }
}
