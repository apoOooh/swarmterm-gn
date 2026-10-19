// Perf flood driver (Phase 0 of the perf plan). Run ONLY through
// scripts/perf/flood.ps1: it starts an isolated dev instance with WebView2
// remote debugging on, generates the data files and samples process CPU and
// memory while this spec drives the real app over CDP.
//
// Inputs (env): PERF_CDP (http://127.0.0.1:9333), PERF_SCENARIO (a|b|c),
// PERF_FLOOD (flooding panes), PERF_IDLE (idle panes), PERF_FILE (data file),
// PERF_LINES (sequence lines in the file, scenario a/c), PERF_CWD,
// PERF_OUT (result JSON), PERF_TRACE (optional Chromium trace path),
// PERF_TIMEOUT_S (max flood duration).
import { chromium, test, type Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'

const env = (k: string, d?: string): string => {
  const v = process.env[k] ?? d
  if (v === undefined) throw new Error(`missing ${k}`)
  return v
}

test('flood', async () => {
  const scenario = env('PERF_SCENARIO')
  const flood = Number(env('PERF_FLOOD'))
  const idle = Number(env('PERF_IDLE'))
  const file = env('PERF_FILE')
  const lines = Number(env('PERF_LINES', '0'))
  const timeoutS = Number(env('PERF_TIMEOUT_S', '600'))
  // The visible workspace holds at most 12 panes; the probed idle pane must be in it.
  if (flood > 11) throw new Error('PERF_FLOOD must be <= 11')
  const browser = await chromium.connectOverCDP(env('PERF_CDP'))
  const page = findMain(browser.contexts().flatMap(c => c.pages()))
  await page.waitForFunction(() => document.querySelector('#root')?.childElementCount)

  // Window must be visible: a hidden or minimised WebView throttles rAF,
  // which would make the frame times meaningless.
  if (await page.evaluate(() => document.visibilityState) !== 'visible') throw new Error('dev window is not visible; un-minimise it')
  await closePerfWorkspaces(page)
  await installProbes(page)
  const ids = await createPanes(page, env('PERF_CWD'), flood + idle)
  const floodIds = ids.slice(0, flood)
  const idleId = ids[flood]
  // Wait for every shell prompt, so startup output is not counted as flood.
  await page.waitForFunction(async (all) => {
    const reg = await import('/src/lib/terminal-registry.ts' as string)
    return all.every((id: string) => /[>$#]\s*$/.test(reg.readTerminalText(id, 3)))
  }, ids, { timeout: 120_000, polling: 500 })
  await page.waitForTimeout(2000)

  // Focus the idle pane by clicking its xterm, like a user would.
  await page.evaluate(async (id) => { (await import('/src/lib/terminal-registry.ts' as string)).focusTerminal(id) }, idleId)
  await page.waitForTimeout(300)
  // The probe letters must not occur in the idle prompt (it shows the cwd,
  // %TEMP%\swarmterm-perf), or a prompt redraw would pass for an echo.
  const prompt: string = await page.evaluate(async (id) => (await import('/src/lib/terminal-registry.ts' as string)).readTerminalText(id, 3), idleId)
  if (/[zxjq]/i.test(prompt)) throw new Error(`idle prompt contains a probe letter (z x j q): ${prompt}`)

  if (process.env.PERF_TRACE) await browser.startTracing(page, { path: process.env.PERF_TRACE, screenshots: false, categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline.frame'] })
  await page.evaluate(() => (window as any).__perf.start())
  const t0 = Date.now()
  await page.evaluate(async ({ ids, file }) => {
    const term = await import('/src/tauri/terminal.ts' as string)
    for (const id of ids) await term.writeTerminal(id, `cmd /d /c type "${file}"\r`)
  }, { ids: floodIds, file })

  // Keystroke probes into the idle pane, one at a time: press a letter, wait
  // for its echo (or 3 s = unanswered), keep probes >= 250 ms apart. Only one
  // probe is ever outstanding, so a lost echo cannot shift later matches. The
  // letters never occur in the prompt (path ...\swarmterm-perf), so a prompt
  // redraw cannot pass for an echo; Escape (clear line) is sent only while no
  // probe is outstanding. Runs until every flood pane is done (sequence
  // complete, or quiet for QUIET_MS) or the timeout.
  // Long enough to ride out real output stalls (one of 15+ s was seen in a
  // baseline run); the stall itself is reported as maxOutputGapMs.
  const QUIET_MS = 60_000
  const letters = 'zxjq'
  let n = 0
  for (;;) {
    const pressed = Date.now()
    await page.keyboard.press(letters[n % letters.length])
    n++
    // One round trip that resolves in-page on the echo: polling over CDP would
    // itself load the main thread being measured.
    await page.evaluate(() => (window as any).__perf.waitEcho(3000))
    if (n % 16 === 0) await page.keyboard.press('Escape')
    await page.waitForTimeout(Math.max(0, 250 - (Date.now() - pressed)))
    const st = await page.evaluate(() => (window as any).__perf.status())
    const elapsed = (Date.now() - t0) / 1000
    // Quiet = no new output for QUIET_MS AND xterm has parsed everything it was
    // given (or has parsed nothing for QUIET_MS: xterm drops writes past its 50 MB
    // pending limit and never calls back). Writes stopping alone is not the end.
    const quiet = st.sinceLastData > QUIET_MS && (st.backlog === 0 || st.sinceLastParse > QUIET_MS)
    const complete = scenario !== 'b' && lines > 0 && st.completeStreams >= flood
    if ((complete && elapsed > 3) || (quiet && elapsed > 20) || elapsed > timeoutS) break
  }
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1500)
  const result = await page.evaluate((lines) => (window as any).__perf.stop(lines), lines)
  if (process.env.PERF_TRACE) await browser.stopTracing()
  result.scenario = scenario; result.flood = flood; result.idle = idle; result.wallSeconds = (Date.now() - t0) / 1000
  // Epoch window for flood.ps1 to trim its CPU/memory samples to the flood.
  result.windowStartMs = t0; result.windowEndMs = t0 + Math.round(result.floodSeconds * 1000)
  writeFileSync(env('PERF_OUT'), JSON.stringify(result, null, 2))
  // Ctrl+C any flood still running so the instance can be closed cleanly.
  await page.evaluate(async (ids) => { const t = await import('/src/tauri/terminal.ts' as string); for (const id of ids) await t.writeTerminal(id, '\x03') }, floodIds)
  await closePerfWorkspaces(page)
})

// Closes perf workspaces left by this or an earlier (possibly crashed) run and
// waits until their terminals are gone from the registry.
async function closePerfWorkspaces(page: Page): Promise<void> {
  const ids: string[] = await page.evaluate(async () => {
    const { useAppStore, visibleLeaves } = await import('/src/store/app-store.ts' as string)
    const perf = useAppStore.getState().workspaces.filter((w: any) => w.name?.startsWith('perf-'))
    const ids = perf.flatMap((w: any) => visibleLeaves(w).map((l: any) => l.terminalId))
    for (const w of perf) useAppStore.getState().closeWorkspace(w.id)
    return ids
  })
  if (!ids.length) return
  await page.waitForFunction(async (ids) => {
    const reg = await import('/src/lib/terminal-registry.ts' as string)
    return ids.every((id: string) => reg.getTerminalGeneration(id) === undefined)
  }, ids, { timeout: 30_000, polling: 250 })
  // The backend's graceful PTY shutdown (KILL_GRACE, 3 s) finishes after that.
  await page.waitForTimeout(3500)
}

function findMain(pages: Page[]): Page {
  const p = pages.find(p => /localhost:1420\/?(\?|#|$)/.test(p.url())) ?? pages.find(p => p.url().includes('1420'))
  if (!p) throw new Error('main webview not found: ' + pages.map(p => p.url()).join(', '))
  return p
}

async function createPanes(page: Page, cwd: string, total: number): Promise<string[]> {
  return page.evaluate(async ({ cwd, total }) => {
    const { useAppStore } = await import('/src/store/app-store.ts' as string)
    const { visibleLeaves } = await import('/src/store/app-store.ts' as string)
    // TERMINAL_COUNTS only allows these sizes. The first workspace is the
    // visible one and must hold the flood panes plus the probed idle pane, so
    // round it up (the extra panes are idle too); overflow goes to hidden ones.
    const counts = [1, 2, 4, 6, 8, 10, 12]
    const ids: string[] = []
    let left = total
    const wsIds: string[] = []
    while (left > 0) {
      const c = counts.find(c => c >= Math.min(left, 12))!
      useAppStore.getState().createWorkspace({ cwd, terminalCount: c, agentIds: Array(c).fill('terminal'), name: `perf-${wsIds.length}` })
      const s = useAppStore.getState()
      wsIds.push(s.activeWorkspaceId)
      left -= c
    }
    // Activate the first workspace: its panes are the visible ones (flood
    // panes come first, then the probed idle pane).
    useAppStore.setState({ activeWorkspaceId: wsIds[0] })
    for (const w of wsIds) {
      const ws = useAppStore.getState().workspaces.find((x: any) => x.id === w)
      for (const leaf of visibleLeaves(ws)) ids.push(leaf.terminalId)
    }
    return ids
  }, { cwd, total })
}

// Hooks Terminal.prototype.write (the app's own xterm module instance) to
// measure, per terminal: bytes handed to xterm, bytes parsed (callback fired),
// sequence-token gaps, keystroke echo latency; plus long tasks and rAF frame
// times for the whole WebView.
async function installProbes(page: Page): Promise<void> {
  await page.evaluate(async () => {
    // Install once per page: scenarios share the page, and stacking wrappers
    // and rAF loops would make later scenarios run hotter. start() resets state.
    if ((window as any).__perf) return
    const url = performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/.vite/deps/@xterm_xterm.js'))
    if (!url) throw new Error('xterm module not found in resource timing')
    const { Terminal } = await import(url)
    type S = { dec: TextDecoder; written: number; parsed: number; tail: string; next: number; gaps: number; missing: number; dupes: number; seen: number; hash: number; lastSeq: number }
    const streams = new Map<object, S>()
    let recording = false
    let lastData = performance.now()
    const longTasks: number[] = []
    const frames: number[] = []
    const echoes: number[] = []
    let pending: { ch: string; t: number } | undefined
    let unanswered = 0
    let maxGap = 0
    let lastParse = performance.now()
    let echoWaiter: (() => void) | undefined
    let hiddenMs = 0
    let hiddenAt = 0
    let floodEnd = 0
    let startAt = 0
    // rAF is throttled while hidden; report how long that was the case.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') hiddenAt = performance.now()
      else if (hiddenAt) { if (recording) hiddenMs += performance.now() - hiddenAt; hiddenAt = 0 }
    })
    new PerformanceObserver(list => { if (recording) for (const e of list.getEntries()) longTasks.push(e.duration) }).observe({ type: 'longtask' })
    let prev = 0
    const raf = (t: number): void => { if (recording && prev) frames.push(t - prev); prev = t; requestAnimationFrame(raf) }
    requestAnimationFrame(raf)
    // e.timeStamp is when the input event was created, so main-thread
    // queueing before the handler runs counts toward the latency.
    window.addEventListener('keydown', e => { if (recording && e.key.length === 1) pending = { ch: e.key, t: e.timeStamp } }, true)
    const FNV = (h: number, n: number): number => Math.imul(h ^ n, 16777619) >>> 0
    const orig = Terminal.prototype.write
    Terminal.prototype.write = function (this: any, data: string | Uint8Array, cb?: () => void) {
      if (!recording) return orig.call(this, data, cb)
      let s = streams.get(this)
      if (!s) streams.set(this, s = { dec: new TextDecoder(), written: 0, parsed: 0, tail: '', next: 0, gaps: 0, missing: 0, dupes: 0, seen: 0, hash: 2166136261, lastSeq: -1 })
      const st = s
      const text = typeof data === 'string' ? data : st.dec.decode(data, { stream: true })
      st.written += text.length
      const focused = this.textarea && this.textarea === document.activeElement
      // Echo in the probed pane must not keep the "flood still running" clock alive.
      if (!focused) { const t = performance.now(); if (t - lastData > maxGap) maxGap = t - lastData; lastData = t }
      return orig.call(this, data, () => {
        st.parsed += text.length
        // The flood window ends at the last parse, so draining xterm's backlog
        // after the writes stop is still inside it.
        // Late callbacks from a previous scenario's closed panes must not
        // move this run's clocks: start() cleared their streams.
        if (!focused && streams.get(this) === st) { lastParse = performance.now(); floodEnd = lastParse }
        const now = performance.now()
        if (focused && pending) {
          const plain = text.replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-_]/g, '')
          if (plain.includes(pending.ch)) { echoes.push(now - pending.t); pending = undefined; echoWaiter?.() }
        }
        // Sequence tokens S########| survive ConPTY re-rendering as long as a
        // line fits the pane; ConPTY does not pass raw bytes through, so this
        // replaces a byte checksum (see docs/perf-baseline.md).
        const buf = st.tail + text
        const re = /S(\d{8})\|/g
        let m: RegExpExecArray | null
        let lastEnd = 0
        while ((m = re.exec(buf))) {
          const n = Number(m[1]); lastEnd = re.lastIndex
          if (n === st.next) { st.next++; st.seen++; st.hash = FNV(st.hash, n) } else if (n > st.next) { st.gaps++; st.missing += n - st.next; st.next = n + 1; st.seen++ } else st.dupes++
          st.lastSeq = n
        }
        st.tail = buf.slice(Math.max(lastEnd, buf.length - 16))
        cb?.()
      })
    }
    const pct = (a: number[], p: number): number | null => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return Math.round(b[Math.min(b.length - 1, Math.floor(p * b.length))] * 10) / 10 }
    ;(window as any).__perf = {
      start() {
        streams.clear(); longTasks.length = 0; frames.length = 0; echoes.length = 0
        pending = undefined; unanswered = 0; hiddenMs = 0; maxGap = 0
        recording = true; prev = 0; lastData = lastParse = startAt = floodEnd = performance.now()
      },
      waitEcho(ms: number) {
        return new Promise<void>(resolve => {
          if (!pending) return resolve()
          const timer = setTimeout(() => { echoWaiter = undefined; if (pending) { unanswered++; pending = undefined } resolve() }, ms)
          echoWaiter = () => { clearTimeout(timer); echoWaiter = undefined; resolve() }
        })
      },
      status() {
        return { backlog: [...streams.values()].reduce((a, s) => a + s.written - s.parsed, 0), sinceLastData: performance.now() - lastData, sinceLastParse: performance.now() - lastParse, completeStreams: [...streams.values()].filter(s => s.seen > 0 && s.lastSeq >= 0 && s.next >= (window as any).__perfLines).length }
      },
      stop(lines: number) {
        recording = false
        if (pending) { unanswered++; pending = undefined }
        const seq = [...streams.values()].filter(s => s.seen > 0)
        let expected = 2166136261
        for (let i = 0; i < lines; i++) expected = FNV(expected, i)
        return {
          floodSeconds: Math.round(floodEnd - startAt) / 1000,
          hiddenMs: Math.round(hiddenMs),
          // Longest pause between flood writes (the final quiet wait not included).
          maxOutputGapMs: Math.round(maxGap),
          // Line integrity, not a byte checksum: chars are UTF-16 code units
          // handed to / parsed by xterm; loss is judged by the S-token sequence.
          streams: seq.map(s => ({ charsWritten: s.written, charsParsed: s.parsed, charsUnparsed: s.written - s.parsed, seen: s.seen, lastSeq: s.lastSeq, gaps: s.gaps, missingLines: s.missing + Math.max(0, lines - s.next), dupes: s.dupes, hashOk: lines ? s.hash === expected && s.next === lines : null })),
          echo: { samples: echoes.length, unanswered, p50: pct(echoes, 0.5), p95: pct(echoes, 0.95), max: pct(echoes, 1) },
          longTasks: { count: longTasks.length, over50: longTasks.filter(d => d > 50).length, totalMs: Math.round(longTasks.reduce((a, b) => a + b, 0)), max: pct(longTasks, 1) },
          frames: { count: frames.length, p50: pct(frames, 0.5), p95: pct(frames, 0.95), p99: pct(frames, 0.99), max: pct(frames, 1), over50: frames.filter(f => f > 50).length }
        }
      }
    }
  })
  await page.evaluate((l) => { (window as any).__perfLines = l }, Number(process.env.PERF_LINES ?? '0'))
}
