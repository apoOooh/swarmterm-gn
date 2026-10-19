// Perf flood driver (Phase 0 of the perf plan). Run ONLY through
// scripts/perf/flood.ps1: it starts an isolated dev instance with WebView2
// remote debugging on, generates the data files and samples process CPU and
// memory while this spec drives the real app over CDP.
//
// Inputs (env): PERF_CDP (http://127.0.0.1:9333), PERF_SCENARIO (a|b|c|d),
// PERF_FLOOD (flooding panes), PERF_IDLE (idle panes), PERF_FILE (data file),
// PERF_LINES (sequence lines in the file, scenario a/c), PERF_CWD,
// PERF_OUT (result JSON), PERF_TRACE (optional Chromium trace path),
// PERF_TIMEOUT_S (max flood duration), PERF_SECONDS (scenario d: stream
// duration; PERF_FILE is then scripts/perf/agent-stream.mjs).
//
// Hard rule: every pane is a plain shell. The harness never starts an agent
// CLI or AI provider; scenario d's "agents" are the local generator script.
// assertPlainPanes() aborts the run before any command is typed if ANY
// workspace in the instance holds an agent pane or a session, and flood.ps1
// runs the instance on a fresh empty profile and kills it if an agent CLI
// process ever shows up in its tree.
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
  const agents = scenario === 'd'
  // Scenario d puts the idle pane first, so it and the probed busy pane are
  // visible while the agent panes beyond the first workspace's 12 are hidden.
  if (!agents && flood > 11) throw new Error('PERF_FLOOD must be <= 11')
  const seconds = Number(env('PERF_SECONDS', '150'))
  const browser = await chromium.connectOverCDP(env('PERF_CDP'))
  const page = findMain(browser.contexts().flatMap(c => c.pages()))
  await page.waitForFunction(() => document.querySelector('#root')?.childElementCount)

  // Window must be visible: a hidden or minimised WebView throttles rAF,
  // which would make the frame times meaningless.
  if (await page.evaluate(() => document.visibilityState) !== 'visible') throw new Error('dev window is not visible; un-minimise it')
  // Abort before touching anything if the instance holds any agent pane.
  await assertPlainPanes(page)
  await closePerfWorkspaces(page)
  await installProbes(page)
  const ids = await createPanes(page, env('PERF_CWD'), flood + idle)
  await assertPlainPanes(page)
  const floodIds = agents ? ids.slice(1) : ids.slice(0, flood)
  const idleId = agents ? ids[0] : ids[flood]
  const busyId = floodIds[0]
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
  await page.evaluate(async ({ ids, file, agents, seconds }) => {
    const term = await import('/src/tauri/terminal.ts' as string)
    for (const [i, id] of ids.entries()) await term.writeTerminal(id, agents ? `node "${file}" ${seconds} ${i + 1}\r` : `cmd /d /c type "${file}"\r`)
  }, { ids: floodIds, file, agents, seconds })

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
  // Scenario d alternates blocks of 16 probes between the idle pane and the
  // busy agent pane (whose generator echoes IN#<k>:<char> in its input box;
  // a probe counts on a <char> with a higher <k> than the last match, so a
  // lost or doubled keystroke cannot desync later probes).
  let busy = false
  for (;;) {
    if (agents && n % 16 === 0 && n > 0) {
      busy = !busy
      await page.evaluate(async (id) => { (await import('/src/lib/terminal-registry.ts' as string)).focusTerminal(id) }, busy ? busyId : idleId)
      await page.waitForTimeout(300)
    }
    const pressed = Date.now()
    const ch = letters[n % letters.length]
    if (agents) await page.evaluate((c) => (window as any).__perf.expect(c), busy ? ch : null)
    await page.keyboard.press(ch)
    n++
    // One round trip that resolves in-page on the echo: polling over CDP would
    // itself load the main thread being measured.
    // A busy agent pane may stall for seconds behind a tool dump: wait long
    // enough to measure the stall instead of censoring it at 3 s.
    // Capped at the scenario's end, so the run does not overshoot it.
    const left = (seconds + 5) * 1000 - (Date.now() - t0)
    await page.evaluate((ms) => (window as any).__perf.waitEcho(ms), busy ? Math.max(500, Math.min(10_000, left)) : 3000)
    if (n % 16 === 0 && !busy) await page.keyboard.press('Escape')
    await page.waitForTimeout(Math.max(0, 250 - (Date.now() - pressed)))
    const st = await page.evaluate(() => (window as any).__perf.status())
    const elapsed = (Date.now() - t0) / 1000
    // Quiet = no new output for QUIET_MS AND xterm has parsed everything it was
    // given (or has parsed nothing for QUIET_MS: xterm drops writes past its 50 MB
    // pending limit and never calls back). Writes stopping alone is not the end.
    const quiet = st.sinceLastData > QUIET_MS && (st.backlog === 0 || st.sinceLastParse > QUIET_MS)
    const complete = scenario !== 'b' && lines > 0 && st.completeStreams >= flood
    if (agents) { if (elapsed > seconds + 5) break; continue }
    if ((complete && elapsed > 3) || (quiet && elapsed > 20) || elapsed > timeoutS) break
  }
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1500)
  const result = await page.evaluate((lines) => (window as any).__perf.stop(lines), lines)
  if (process.env.PERF_TRACE) await browser.stopTracing()
  result.scenario = scenario; result.flood = flood; result.idle = idle; result.wallSeconds = (Date.now() - t0) / 1000
  // Epoch window for flood.ps1 to trim its CPU/memory samples to the flood.
  result.windowStartMs = t0; result.windowEndMs = t0 + Math.round((agents ? seconds : result.floodSeconds) * 1000)
  writeFileSync(env('PERF_OUT'), JSON.stringify(result, null, 2))
  // Ctrl+C any flood still running so the instance can be closed cleanly.
  await page.evaluate(async (ids) => { const t = await import('/src/tauri/terminal.ts' as string); for (const id of ids) await t.writeTerminal(id, '\x03') }, floodIds)
  await closePerfWorkspaces(page)
})

// Hard rule (docs/perf-baseline.md): the harness never runs an agent CLI or AI
// provider. Fails the run if ANY workspace in the instance (not only perf-*
// ones: a restored workspace could resume an agent session) has a default
// agent, or any leaf has a non-terminal agent, a session to resume, a
// start prompt or a startup command.
async function assertPlainPanes(page: Page): Promise<void> {
  const bad: string[] = await page.evaluate(async () => {
    const { useAppStore } = await import('/src/store/app-store.ts' as string)
    // Every leaf in the layout, including drawered and floating ones.
    const { collectLeaves } = await import('/src/lib/layout-tree.ts' as string)
    const out: string[] = []
    for (const w of useAppStore.getState().workspaces as any[]) {
      if (w.defaultAgentId && w.defaultAgentId !== 'terminal') out.push(`workspace ${w.name}: defaultAgentId ${w.defaultAgentId}`)
      for (const l of collectLeaves(w.layout) as any[]) {
        const why = [
          l.agentId && l.agentId !== 'terminal' && `agentId ${l.agentId}`,
          l.sessionId && 'sessionId', l.resumeSessionId && 'resumeSessionId', l.continueSession && 'continueSession',
          l.initialPrompt && 'initialPrompt', l.startupCommand && 'startupCommand'
        ].filter(Boolean)
        if (why.length) out.push(`workspace ${w.name} pane ${l.terminalId}: ${why.join(', ')}`)
      }
    }
    return out
  })
  if (bad.length) throw new Error('refusing to run: agent panes/sessions present (harness must never start an agent):\n' + bad.join('\n'))
}

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
    type S = { dec: TextDecoder; written: number; parsed: number; tail: string; next: number; gaps: number; missing: number; dupes: number; seen: number; hash: number; lastSeq: number
      // Scenario d delivery lag: @T<epoch ms>| tokens, at hand-over to xterm
      // (recv) and at xterm's parse callback (parse).
      // Streamed lines (@T) and tool-dump lines (@D) are kept apart.
      rTail: string; pTail: string; rLast: number; pLast: number; recv: number[]; parse: number[]; recvD: number[]; parseD: number[]; tokDupes: number }
    const streams = new Map<object, S>()
    let recording = false
    let lastData = performance.now()
    const longTasks: number[] = []
    const frames: number[] = []
    const echoes: number[] = []
    let pending: { ch: string; t: number; busy: boolean } | undefined
    let expectBusy = false
    let lastBusyN = 0
    const IN = /IN#(\d+):(.)/
    const echoesBusy: number[] = []
    let unansweredBusy = 0
    const TOK = /@([TD])(\d{13})\|/g
    // Scans text for delivery tokens; a token older than the last one seen is
    // a ConPTY repaint, not a delivery.
    const lagScan = (tail: string, text: string, last: number, into: number[], intoD: number[], now: number, s: S): [string, number] => {
      const buf = tail + text
      let m: RegExpExecArray | null
      let lastEnd = 0
      TOK.lastIndex = 0
      while ((m = TOK.exec(buf))) {
        const ts = Number(m[2]); lastEnd = TOK.lastIndex
        if (ts >= last) { (m[1] === 'T' ? into : intoD).push(now - ts); last = ts } else s.tokDupes++
      }
      return [buf.slice(Math.max(lastEnd, buf.length - 16)), last]
    }
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
    window.addEventListener('keydown', e => { if (recording && e.key.length === 1) pending = { ch: e.key, t: e.timeStamp, busy: expectBusy } }, true)
    const FNV = (h: number, n: number): number => Math.imul(h ^ n, 16777619) >>> 0
    const orig = Terminal.prototype.write
    Terminal.prototype.write = function (this: any, data: string | Uint8Array, cb?: () => void) {
      if (!recording) return orig.call(this, data, cb)
      let s = streams.get(this)
      if (!s) streams.set(this, s = { dec: new TextDecoder(), written: 0, parsed: 0, tail: '', next: 0, gaps: 0, missing: 0, dupes: 0, seen: 0, hash: 2166136261, lastSeq: -1, rTail: '', pTail: '', rLast: 0, pLast: 0, recv: [], parse: [], recvD: [], parseD: [], tokDupes: 0 })
      const st = s
      const text = typeof data === 'string' ? data : st.dec.decode(data, { stream: true })
      st.written += text.length
      ;[st.rTail, st.rLast] = lagScan(st.rTail, text, st.rLast, st.recv, st.recvD, Date.now(), st)
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
        ;[st.pTail, st.pLast] = lagScan(st.pTail, text, st.pLast, st.parse, st.parseD, Date.now(), st)
        if (focused && pending?.busy) {
          // Busy agent pane: ConPTY sends only the changed cells of the input
          // box, so match the parsed screen, not the chunk text.
          const b = this.buffer.active
          for (let y = b.viewportY; y < b.viewportY + this.rows; y++) {
            const m = IN.exec(b.getLine(y)?.translateToString(true) ?? '')
            if (m && Number(m[1]) > lastBusyN && m[2] === pending.ch) { lastBusyN = Number(m[1]); echoesBusy.push(now - pending.t); pending = undefined; echoWaiter?.(); break }
          }
        } else if (focused && pending) {
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
        streams.clear(); longTasks.length = 0; frames.length = 0; echoes.length = 0; echoesBusy.length = 0
        pending = undefined; unanswered = 0; unansweredBusy = 0; expectBusy = false; lastBusyN = 0; hiddenMs = 0; maxGap = 0
        recording = true; prev = 0; lastData = lastParse = startAt = floodEnd = performance.now()
      },
      // Next keystroke goes to the busy agent pane (a char) or the idle one (null).
      expect(ch: string | null) { expectBusy = ch !== null },
      waitEcho(ms: number) {
        return new Promise<void>(resolve => {
          if (!pending) return resolve()
          const timer = setTimeout(() => { echoWaiter = undefined; if (pending) { if (pending.busy) unansweredBusy++; else unanswered++; pending = undefined } resolve() }, ms)
          echoWaiter = () => { clearTimeout(timer); echoWaiter = undefined; resolve() }
        })
      },
      status() {
        return { backlog: [...streams.values()].reduce((a, s) => a + s.written - s.parsed, 0), sinceLastData: performance.now() - lastData, sinceLastParse: performance.now() - lastParse, completeStreams: [...streams.values()].filter(s => s.seen > 0 && s.lastSeq >= 0 && s.next >= (window as any).__perfLines).length }
      },
      stop(lines: number) {
        recording = false
        if (pending) { if (pending.busy) unansweredBusy++; else unanswered++; pending = undefined }
        const seq = [...streams.values()].filter(s => s.seen > 0)
        const lagged = [...streams.values()].filter(s => s.parse.length)
        const all = (k: 'recv' | 'parse' | 'recvD' | 'parseD'): number[] => lagged.flatMap(s => s[k])
        const lagStats = (a: number[]) => ({ samples: a.length, p50: pct(a, 0.5), p95: pct(a, 0.95), max: pct(a, 1) })
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
          echoBusy: { samples: echoesBusy.length, unanswered: unansweredBusy, p50: pct(echoesBusy, 0.5), p95: pct(echoesBusy, 0.95), max: pct(echoesBusy, 1) },
          // Generator write -> xterm (all panes pooled), and per pane.
          lag: lagged.length ? {
            panes: lagged.length, repaintTokens: lagged.reduce((a, s) => a + s.tokDupes, 0),
            recv: lagStats(all('recv')), parse: lagStats(all('parse')),
            recvDump: lagStats(all('recvD')), parseDump: lagStats(all('parseD')),
            worstPaneP95: Math.max(...lagged.map(s => pct(s.parse, 0.95) ?? 0)),
            perPane: lagged.map(s => ({ parse: lagStats(s.parse), recvP95: pct(s.recv, 0.95) }))
          } : null,
          longTasks: { count: longTasks.length, over50: longTasks.filter(d => d > 50).length, totalMs: Math.round(longTasks.reduce((a, b) => a + b, 0)), max: pct(longTasks, 1) },
          frames: { count: frames.length, p50: pct(frames, 0.5), p95: pct(frames, 0.95), p99: pct(frames, 0.99), max: pct(frames, 1), over50: frames.filter(f => f > 50).length }
        }
      }
    }
  })
  await page.evaluate((l) => { (window as any).__perfLines = l }, Number(process.env.PERF_LINES ?? '0'))
}
