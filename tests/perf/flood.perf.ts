// Perf flood driver (Phase 0 of the perf plan). Run ONLY through
// scripts/perf/flood.ps1: it starts an isolated dev instance with WebView2
// remote debugging on, generates the data files and samples process CPU and
// memory while this spec drives the real app over CDP.
//
// Inputs (env): PERF_CDP (http://127.0.0.1:9333), PERF_SCENARIO (a|b|c|d|e|f|g),
// PERF_FLOOD (flooding panes), PERF_IDLE (idle panes), PERF_FILE (data file),
// PERF_LINES (sequence lines in the file, scenario a/c), PERF_CWD,
// PERF_OUT (result JSON), PERF_TRACE (optional Chromium trace path),
// PERF_TIMEOUT_S (max flood duration), PERF_SECONDS (scenario d/e/f: stream
// duration; PERF_FILE is then scripts/perf/agent-stream.mjs, also copied to
// PERF_CWD), PERF_HOST (1 = switch the terminal host on before creating
// panes), PERF_MOCK (1 = scenario d's agent panes use the perf-mock-agent
// template), PERF_WAR (scenario e: War Room peer/waiter pairs), PERF_STREAM
// (scenario e: extra streaming panes; scenario g: PERF_FILE is
// scripts/perf/tool-agent.mjs, PERF_FLOOD tool panes, PERF_IDLE idle panes), PERF_VISIBLE (scenario f: visible panes
// in the main workspace), PERF_SWITCH_S (scenario f: workspace switch period).
//
// Hard rule: no agent CLI or AI provider, ever. Panes are plain shells, except
// the dev-only `perf-mock-agent` template (scenario d with PERF_MOCK, scenario
// e), whose command is the local generator `node agent-stream.mjs --mock`.
// assertPlainPanes() aborts the run before any command is typed if ANY
// workspace in the instance holds another agent or a session, or if the mock
// template resolves to anything but that exact command; flood.ps1 runs the
// instance on a fresh empty profile and kills it if an agent CLI process ever
// shows up in its tree.
import { chromium, test, type Page } from '@playwright/test'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startProfile, type ProfileMode } from './profile-capture'

const env = (k: string, d?: string): string => {
  const v = process.env[k] ?? d
  if (v === undefined) throw new Error(`missing ${k}`)
  return v
}

// Must match src/lib/templates.ts; assertPlainPanes checks both in-page.
const MOCK_ID = 'perf-mock-agent'
const MOCK_COMMAND = 'node agent-stream.mjs --mock'
const REG = '/src/lib/terminal-registry.ts'

// Degradation notes of the current run, also kept when it fails.
const runNotes: string[] = []

test('flood', async () => {
  // Any failure still leaves a result file with its reason, so flood.ps1
  // reports it loudly instead of a silent n/a.
  const tStart = Date.now()
  try { await runScenario(tStart) } catch (e) {
    const out = env('PERF_OUT')
    let prev: any = null
    try { prev = JSON.parse(readFileSync(out, 'utf8')) } catch { /* none yet */ }
    const error = String(e instanceof Error ? e.stack ?? e.message : e).slice(0, 4000)
    // A failure during teardown keeps the measured result, marked failed.
    // Failed before the run started: all elapsed time counts as setup.
    const elapsed = (Date.now() - tStart) / 1000
    writeFileSync(out, JSON.stringify(prev ? { ...prev, failed: true, error } : { scenario: process.env.PERF_SCENARIO, failed: true, error, notes: runNotes, timing: { setupS: elapsed, runS: null, teardownS: null, totalS: elapsed } }, null, 2))
    throw e
  }
})

// What this build offers beyond the plain app: the dev-only mock agent
// template, the renderer stats (WebGL count), the render counter and named
// War Rooms. Release builds before the perf work (1.22.1) lack the first
// three; the scenarios degrade instead of failing (see notes in the result).
type Caps = { mockTemplate: boolean; rendererStats: boolean; renderCounter: boolean; warRoomRooms: boolean }
async function probeCaps(page: Page): Promise<Caps> {
  return page.evaluate(async ({ MOCK_ID, REG }) => {
    const tpl = await import('/src/lib/templates.ts' as string)
    const reg = await import(REG)
    const wr = await import('/src/tauri/warroom.ts' as string)
    // Vite answers a missing module with an error, not an empty module.
    const renderCounter = await import('/src/lib/perf-render-count.ts' as string).then(() => true, () => false)
    return {
      mockTemplate: tpl.templateById(MOCK_ID)?.id === MOCK_ID,
      rendererStats: typeof reg.perfRendererStats === 'function',
      renderCounter,
      warRoomRooms: typeof wr.warRoomCreate === 'function' && typeof wr.warRoomDelete === 'function'
    }
  }, { MOCK_ID, REG })
}

async function runScenario(tStart: number): Promise<void> {
  const scenario = env('PERF_SCENARIO')
  const flood = Number(env('PERF_FLOOD'))
  const idle = Number(env('PERF_IDLE'))
  const file = env('PERF_FILE')
  const lines = Number(env('PERF_LINES', '0'))
  const timeoutS = Number(env('PERF_TIMEOUT_S', '600'))
  const cwd = env('PERF_CWD')
  const hostMode = process.env.PERF_HOST === '1'
  const agents = scenario === 'd'
  const warRoom = scenario === 'e'
  const many = scenario === 'f'
  // Scenario g: tool-heavy agents (scripts/perf/tool-agent.mjs in plain shells).
  const tools = scenario === 'g'
  // Fixed-duration scenarios: they run PERF_SECONDS instead of until the
  // flood is complete or quiet.
  const fixed = agents || warRoom || many || tools
  const wantMock = (agents && process.env.PERF_MOCK === '1') || warRoom
  if (!fixed && flood > 11) throw new Error('PERF_FLOOD must be <= 11')
  const seconds = Number(env('PERF_SECONDS', '150'))
  const browser = await chromium.connectOverCDP(env('PERF_CDP'))
  const page = findMain(browser.contexts().flatMap(c => c.pages()))
  await page.waitForFunction(() => document.querySelector('#root')?.childElementCount)

  // Window must be visible: a hidden or minimised WebView throttles rAF,
  // which would make the frame times meaningless.
  if (await page.evaluate(() => document.visibilityState) !== 'visible') throw new Error('dev window is not visible; un-minimise it')
  const caps = await probeCaps(page)
  const notes = runNotes
  // No mock template: scenario d falls back to plain shells typing the
  // generator, scenario e to plain-shell peers running it in --mock mode.
  // assertPlainPanes then allows NO agent at all.
  const mock = wantMock && caps.mockTemplate
  if (wantMock && !mock) notes.push(agents
    ? 'fallback: no perf-mock-agent template in this build; agent panes are plain shells running agent-stream.mjs (no detector, tab badges or state flips)'
    : 'fallback: no perf-mock-agent template in this build; War Room peers are plain shells running agent-stream.mjs --mock (no agent detector, so wait_peer may never see a flip)')
  if (!caps.renderCounter) notes.push('unsupported: render counter (src/lib/perf-render-count.ts) missing; WorkspaceTabs/AttentionBadge renders not measured')
  if (many && !caps.rendererStats) notes.push('unsupported: perfRendererStats missing; WebGL/DOM-fallback counts not measured')
  if (warRoom && !caps.warRoomRooms) notes.push('fallback: no named War Room API; panes join the default room')
  // Abort before touching anything if the instance holds any agent pane.
  await assertPlainPanes(page, mock)
  await closePerfWorkspaces(page)
  await installProbes(page)
  // The mock generators start on perf-mock.json; stale logs would mix runs.
  clearMockFiles(cwd)
  if (hostMode) await page.evaluate(async () => { await (await import('/src/tauri/terminal-host.ts' as string)).setTerminalHostSettings({ enabled: true }) })

  // ---- panes ----
  const war = Number(env('PERF_WAR', '4'))
  const streamN = Number(env('PERF_STREAM', '4'))
  let ids: string[]
  let floodIds: string[]
  let idleId: string
  let peerIds: string[] = []
  let waiterIds: string[] = []
  let wsIds: string[] = []
  if (many) {
    const made = await createManyVisible(page, cwd, Number(env('PERF_VISIBLE', '16')))
    ids = made.ids; wsIds = made.wsIds; floodIds = ids; idleId = ''
  } else if (warRoom) {
    // Waiters (plain shells, the first is the probed idle pane), then the
    // mock agent peers they wait on, then panes that only stream.
    const kinds = [...Array(war).fill('terminal'), ...Array(war).fill(mock ? MOCK_ID : 'terminal'), ...Array(streamN).fill('terminal')]
    ids = await createPanes(page, cwd, kinds)
    waiterIds = ids.slice(0, war); peerIds = ids.slice(war, 2 * war)
    floodIds = ids.slice(2 * war, 2 * war + streamN); idleId = waiterIds[0]
  } else if (tools) {
    // Idle panes first (the first is probed), then the tool agents.
    ids = await createPanes(page, cwd, Array(idle + flood).fill('terminal'))
    floodIds = ids.slice(idle); idleId = ids[0]
  } else {
    const kinds = agents ? ['terminal', ...Array(flood).fill(mock ? MOCK_ID : 'terminal')] : Array(flood + idle).fill('terminal')
    ids = await createPanes(page, cwd, kinds)
    floodIds = agents ? ids.slice(1, 1 + flood) : ids.slice(0, flood)
    idleId = agents ? ids[0] : ids[flood]
  }
  await assertPlainPanes(page, mock)
  const mockIds: string[] = await page.evaluate(async ({ ids, MOCK_ID }) => {
    const { useAppStore } = await import('/src/store/app-store.ts' as string)
    const { collectLeaves } = await import('/src/lib/layout-tree.ts' as string)
    const leaves = useAppStore.getState().workspaces.flatMap((w: any) => collectLeaves(w.layout))
    return ids.filter((id: string) => leaves.find((l: any) => l.terminalId === id)?.agentId === MOCK_ID)
  }, { ids, MOCK_ID })
  // Fallback peers: plain shells start the generator in --mock mode now; it
  // prints the same wait line and waits for perf-mock.json like the template.
  if (warRoom && !mock) await page.evaluate(async (ids) => { const t = await import('/src/tauri/terminal.ts' as string); for (const id of ids) await t.writeTerminal(id, 'node agent-stream.mjs --mock\r') }, peerIds)
  const runIds = warRoom && !mock ? peerIds : mockIds
  if (warRoom && mock && mockIds.join() !== peerIds.join()) throw new Error('scenario e: peer panes are not the mock agents')
  const busyId = agents ? floodIds[0] : ''
  // Wait for every shell prompt (mock panes: the mock's wait line), so
  // startup output is not counted as flood.
  await page.waitForFunction(async ({ all, REG }) => {
    const reg = await import(REG)
    return all.every((id: string) => { const t = reg.readTerminalText(id, 3); return /[>$#]\s*$/.test(t) || t.includes('perf-mock: waiting') })
  }, { all: ids, REG }, { timeout: 120_000, polling: 500 }).catch(async (e) => {
    // Name the panes that never got ready (a mock whose `node` failed shows
    // a shell error instead of its wait line).
    const tails: string[] = await page.evaluate(async ({ all, REG }) => {
      const reg = await import(REG)
      return all.map((id: string) => `${id}: ${reg.readTerminalText(id, 3).replace(/\s+/g, ' ').slice(-120)}`)
    }, { all: ids, REG })
    throw new Error(`panes not ready after 120 s:\n${tails.join('\n')}\n${e}`)
  })
  await page.waitForTimeout(2000)
  let host: unknown = null
  if (hostMode) {
    host = await page.evaluate(async () => (await import('/src/tauri/terminal-host.ts' as string)).getTerminalHostStatus())
    if (!(host as any).connected) throw new Error('PERF_HOST: terminal host is not connected: ' + JSON.stringify(host))
  }

  // ---- scenario g: file watcher on the panes' cwd (the perf data dir) ----
  // Opens a file context for a tool pane and watches its root, as the file
  // explorer would, and timestamps every files:changed event in-page. Builds
  // without the files API (1.22.1) skip it with a note.
  // Each event keeps only its time, the rescan flag and the storm folders
  // (<pane>/storm-<round>) its paths touch, so the other file traffic in the
  // data dir cannot pass for a storm's event.
  let watching = false
  if (tools) {
    const err: string = await page.evaluate(async (id) => {
      try {
        const f = await import('/src/tauri/files.ts' as string)
        if (!f.openFileContext || !f.watchFiles || !f.onFileChange) return 'openFileContext/watchFiles/onFileChange missing'
        const ctx = await f.openFileContext(id)
        const w = window as any
        w.__perfFileEvents = [] as { t: number; rescan: boolean; keys: string[] }[]
        w.__perfFileUnlisten = await f.onFileChange((c: any) => {
          const keys = new Set<string>()
          for (const p of c.paths ?? []) { const m = /perf-tool-ws[\\/](\d+)[\\/](storm-\d+)/.exec(p); if (m) keys.add(`${m[1]}/${m[2]}`) }
          w.__perfFileEvents.push({ t: Date.now(), rescan: !!c.rescan, keys: [...keys] })
        })
        await f.watchFiles(ctx.id)
        w.__perfFileCtx = ctx.id
        return ''
      } catch (e) { return String(e) }
    }, floodIds[0])
    watching = !err
    if (!watching) notes.push(`unsupported: file watcher not measurable on this build (${err}); file-event counts and latency not measured`)
  }

  // ---- scenario e: War Room setup ----
  let room: WarRoomRun | undefined
  if (warRoom) room = await setupWarRoom(page, cwd, waiterIds, peerIds, mock, caps.warRoomRooms)

  if (idleId) {
    // Focus the idle pane by clicking its xterm, like a user would.
    await page.evaluate(async ({ id, REG }) => { (await import(REG)).focusTerminal(id) }, { id: idleId, REG })
    await page.waitForTimeout(300)
    // The probe letters must not occur in the idle prompt (it shows the cwd,
    // %TEMP%\swarmterm-perf), or a prompt redraw would pass for an echo.
    const prompt: string = await page.evaluate(async ({ id, REG }) => (await import(REG)).readTerminalText(id, 3), { id: idleId, REG })
    if (/[zxjq]/i.test(prompt)) throw new Error(`idle prompt contains a probe letter (z x j q): ${prompt}`)
  }

  if (process.env.PERF_TRACE) await browser.startTracing(page, { path: process.env.PERF_TRACE, screenshots: false, categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline.frame'] })
  // Profile runs only (flood.ps1 -Profile): captures start with the window.
  const profMode = process.env.PERF_PROFILE as ProfileMode | undefined
  const stopProfile = profMode ? await startProfile(browser, page, profMode, env('PERF_PROFILE_DIR')) : undefined
  await page.evaluate(() => (window as any).__perf.start())
  const t0 = Date.now()
  // Start signal for the mock agents (their template line already runs).
  if (runIds.length) writeFileSync(join(cwd, 'perf-mock.json'), JSON.stringify({ seconds }))
  const typed = mock && agents ? [] : floodIds
  await page.evaluate(async ({ ids, file, fixed, seconds }) => {
    const term = await import('/src/tauri/terminal.ts' as string)
    for (const [i, id] of ids.entries()) await term.writeTerminal(id, fixed ? `node "${file}" ${seconds} ${i + 1}\r` : `cmd /d /c type "${file}"\r`)
  }, { ids: typed, file, fixed, seconds })

  const waits = room ? runWaiters(room, t0 + seconds * 1000) : undefined
  let switches: SwitchSample[] = []
  if (many) switches = await switchWorkspaces(page, wsIds, t0, seconds, Number(env('PERF_SWITCH_S', '3')), caps.rendererStats)
  else await probeLoop(page, { scenario, fixed, agents, seconds, lines, flood, timeoutS, t0, busyId, idleId })
  const waitResults = waits ? await waits : undefined
  let toolSummary: unknown
  if (tools) {
    // Stop listening at the run's end, before the generators write their
    // summaries and clean up, so only the run's own events count.
    const events: FileEvent[] = watching ? await page.evaluate(async () => {
      const w = window as any
      try { w.__perfFileUnlisten?.(); await (await import('/src/tauri/files.ts' as string)).unwatchFiles(w.__perfFileCtx) } catch { /* teardown only */ }
      return w.__perfFileEvents ?? []
    }) : []
    // The generators stop on their own after PERF_SECONDS; a spawn still
    // running then delays the summary file a little.
    const files = floodIds.map((_, i) => join(cwd, `perf-tool-${i + 1}.json`))
    const until = Date.now() + 15_000
    while (Date.now() < until && !files.every((f) => existsSync(f))) await page.waitForTimeout(250)
    toolSummary = summarizeTools(files, watching ? events : null)
  }

  if (idleId) await page.keyboard.press('Escape')
  await page.waitForTimeout(1500)
  const result = await page.evaluate((lines) => (window as any).__perf.stop(lines), lines)
  const tRunEnd = Date.now()
  if (stopProfile) await stopProfile()
  if (process.env.PERF_TRACE) await browser.stopTracing()
  if (!caps.renderCounter) result.renders = { WorkspaceTabs: 'unsupported', AttentionBadge: 'unsupported' }
  result.caps = caps; result.notes = notes
  result.scenario = scenario; result.flood = flood; result.idle = idle; result.wallSeconds = (Date.now() - t0) / 1000
  result.hostMode = hostMode; result.host = host; result.mockAgents = mockIds.length
  if (waitResults) result.warRoom = summarizeWaits(waitResults, cwd, peerIds, war, streamN)
  if (many) result.renderers = summarizeSwitches(switches, ids.length, caps.rendererStats)
  if (tools) result.tools = toolSummary
  // Epoch window for flood.ps1 to trim its CPU/memory samples to the flood.
  result.windowStartMs = t0; result.windowEndMs = t0 + Math.round((fixed ? seconds : result.floodSeconds) * 1000)
  // Timing: setup = test start to the run's t0, run = t0 to the probes'
  // stop, teardown = generators stopped and perf workspaces closed.
  result.timing = { setupS: (t0 - tStart) / 1000, runS: (tRunEnd - t0) / 1000, teardownS: null as number | null, totalS: null as number | null }
  writeFileSync(env('PERF_OUT'), JSON.stringify(result, null, 2))
  const tTear = Date.now()
  // Ctrl+C any generator still running so the instance can be closed cleanly.
  await page.evaluate(async (ids) => { const t = await import('/src/tauri/terminal.ts' as string); for (const id of ids) await t.writeTerminal(id, '\x03') }, [...floodIds, ...runIds])
  if (room?.roomId) await page.evaluate(async (roomId) => { await (await import('/src/tauri/warroom.ts' as string)).warRoomDelete(roomId).catch(() => {}) }, room.roomId)
  else if (room) await page.evaluate(async (ids) => { const wr = await import('/src/tauri/warroom.ts' as string); for (const id of ids) await wr.warRoomLeave?.(id).catch(() => {}) }, [...waiterIds, ...peerIds])
  await closePerfWorkspaces(page)
  clearMockFiles(cwd)
  result.timing.teardownS = (Date.now() - tTear) / 1000
  result.timing.totalS = (Date.now() - tStart) / 1000
  writeFileSync(env('PERF_OUT'), JSON.stringify(result, null, 2))
}

// Keystroke probes into the idle pane, one at a time: press a letter, wait
// for its echo (or 3 s = unanswered), keep probes >= 250 ms apart. Only one
// probe is ever outstanding, so a lost echo cannot shift later matches. The
// letters never occur in the prompt (path ...\swarmterm-perf), so a prompt
// redraw cannot pass for an echo; Escape (clear line) is sent only while no
// probe is outstanding. Runs until every flood pane is done (sequence
// complete, or quiet for QUIET_MS), the timeout, or (fixed-duration
// scenarios) PERF_SECONDS.
async function probeLoop(page: Page, o: { scenario: string; fixed: boolean; agents: boolean; seconds: number; lines: number; flood: number; timeoutS: number; t0: number; busyId: string; idleId: string }): Promise<void> {
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
    if (o.agents && n % 16 === 0 && n > 0) {
      busy = !busy
      await page.evaluate(async ({ id, REG }) => { (await import(REG)).focusTerminal(id) }, { id: busy ? o.busyId : o.idleId, REG })
      await page.waitForTimeout(300)
    }
    const pressed = Date.now()
    const ch = letters[n % letters.length]
    if (o.agents) await page.evaluate((c) => (window as any).__perf.expect(c), busy ? ch : null)
    await page.keyboard.press(ch)
    n++
    // One round trip that resolves in-page on the echo: polling over CDP would
    // itself load the main thread being measured.
    // A busy agent pane may stall for seconds behind a tool dump: wait long
    // enough to measure the stall instead of censoring it at 3 s.
    // Capped at the scenario's end, so the run does not overshoot it.
    const left = (o.seconds + 5) * 1000 - (Date.now() - o.t0)
    await page.evaluate((ms) => (window as any).__perf.waitEcho(ms), busy ? Math.max(500, Math.min(10_000, left)) : 3000)
    if (n % 16 === 0 && !busy) await page.keyboard.press('Escape')
    await page.waitForTimeout(Math.max(0, 250 - (Date.now() - pressed)))
    const st = await page.evaluate(() => (window as any).__perf.status())
    const elapsed = (Date.now() - o.t0) / 1000
    // Quiet = no new output for QUIET_MS AND xterm has parsed everything it was
    // given (or has parsed nothing for QUIET_MS: xterm drops writes past its 50 MB
    // pending limit and never calls back). Writes stopping alone is not the end.
    const quiet = st.sinceLastData > QUIET_MS && (st.backlog === 0 || st.sinceLastParse > QUIET_MS)
    const complete = o.scenario !== 'b' && o.lines > 0 && st.completeStreams >= o.flood
    if (o.fixed) { if (elapsed > o.seconds + 5) break; continue }
    if ((complete && elapsed > 3) || (quiet && elapsed > 20) || elapsed > o.timeoutS) break
  }
}

function clearMockFiles(cwd: string): void {
  if (!existsSync(cwd)) return
  for (const f of readdirSync(cwd)) if (f === 'perf-mock.json' || f === 'perf-mcp.json' || /^perf-mock-.*\.log$/.test(f) || /^perf-tool-\d+\.json$/.test(f)) rmSync(join(cwd, f), { force: true })
  // Scenario g's workspace (the generators remove their own folder; this
  // catches one killed mid-run).
  rmSync(join(cwd, 'perf-tool-ws'), { recursive: true, force: true })
}

// ---------- scenario g: tool-heavy agents ----------
// Merges the generators' summaries: spawn round trips per kind (total count,
// median over panes of each pane's p50 / p95, overall max) and the storm
// latency: from a storm's start to the first files:changed event that names
// its folder, or the first rescan at or after its end (storm mode skips the
// later batches and sends one rescan after RESCAN_QUIET without raw events,
// which other panes' file traffic can delay). Within 5 s, else missed.
// `events` null = not measured.
type FileEvent = { t: number; rescan: boolean; keys: string[] }
type Storm = { key: string; start: number; end: number }
function summarizeTools(files: string[], events: FileEvent[] | null): unknown {
  const per = files.filter((f) => existsSync(f)).map((f) => JSON.parse(readFileSync(f, 'utf8')))
  const kind = (k: string) => {
    const xs = per.map((p) => p[k]).filter((x) => x && x.count)
    const med = (a: number[]) => pctl(a, 0.5)
    return { count: xs.reduce((n, x) => n + x.count, 0), p50: med(xs.map((x) => x.p50)), p95: med(xs.map((x) => x.p95)), max: xs.length ? Math.max(...xs.map((x) => x.max)) : null }
  }
  const lat: number[] = []
  let stormsMissed = 0
  let viaRescan = 0
  const storms: Storm[] = per.flatMap((p) => p.storms ?? [])
  if (events) {
    const ev = [...events].sort((a, b) => a.t - b.t)
    for (const s of storms) {
      const e = ev.find((x) => x.t >= s.start && (x.keys.includes(s.key) || (x.rescan && x.t >= s.end)))
      if (e !== undefined && e.t - s.start <= 5000) { lat.push(e.t - s.start); if (!e.keys.includes(s.key)) viaRescan++ } else stormsMissed++
    }
  }
  const na = 'unsupported'
  return {
    panesReported: per.length, panes: files.length,
    spawnCmd: kind('cmd'), spawnPwsh: kind('pwsh'), spawnBigOutput: kind('big'),
    spawnFailed: per.reduce((n, p) => n + (p.spawnFailed ?? 0), 0),
    fileOps: per.reduce((n, p) => n + (p.fileOps ?? 0), 0),
    storms: storms.length,
    fileEvents: events ? events.length : na,
    rescans: events ? events.filter((e) => e.rescan).length : na,
    // Same leaves either way, so compare.ps1 lines up a build without the API.
    fileEventLatency: events
      ? { samples: lat.length, viaRescan, missed: stormsMissed, p50: pctl(lat, 0.5), p95: pctl(lat, 0.95), max: lat.length ? Math.max(...lat) : null }
      : { samples: na, viaRescan: na, missed: na, p50: na, p95: na, max: na },
  }
}

// ---------- scenario e: War Room waiters ----------
type WarRoomRun = { roomId: string | null; mcpUrl: string; pairs: { waiter: string; peer: string }[] }
type WaitRecord = { peer: string; calledAt: number; returnedAt: number; outcome: string; state: string; error?: string }

// Puts the waiters and the mock peers into a fresh War Room through the same
// command the app's drag-and-drop uses (war_room_join), and reads the MCP URL
// from a waiter's environment. Each waiter's bearer is its pane id, exactly
// what an agent CLI in that pane would send (SWARMTERM_SESSION).
// Builds without named rooms get the default room; without the mock
// template the peers join as plain terminals.
async function setupWarRoom(page: Page, cwd: string, waiters: string[], peers: string[], mock: boolean, rooms: boolean): Promise<WarRoomRun> {
  const roomId: string | null = await page.evaluate(async ({ waiters, peers, cwd, MOCK_ID, mock, rooms }) => {
    const wr = await import('/src/tauri/warroom.ts' as string)
    const roomId: string | undefined = rooms ? (await wr.warRoomCreate(`perf-room-${Date.now()}`)).roomId : undefined
    const at = roomId ? { roomId } : {}
    for (const [i, id] of waiters.entries()) await wr.warRoomJoin({ ...at, terminalId: id, cwd, displayName: `perf-waiter-${i}` })
    for (const [i, id] of peers.entries()) await wr.warRoomJoin({ ...at, terminalId: id, ...(mock ? { agentId: MOCK_ID } : {}), cwd, displayName: `perf-peer-${i}` })
    return roomId ?? null
  }, { waiters, peers, cwd, MOCK_ID, mock, rooms })
  // The waiter pane writes its own MCP env to a file (screen text of a narrow
  // pane wraps).
  const envFile = join(cwd, 'perf-mcp.json')
  await page.evaluate(async (id) => (await import('/src/tauri/terminal.ts' as string)).writeTerminal(id,
    'node -e "require(\'fs\').writeFileSync(\'perf-mcp.json\',JSON.stringify({url:process.env.SWARMTERM_MCP_URL,tok:process.env.SWARMTERM_SESSION}))"\r'), waiters[0])
  let mcpEnv: { url?: string; tok?: string } = {}
  for (const until = Date.now() + 30_000; Date.now() < until; await new Promise(r => setTimeout(r, 250))) {
    try { mcpEnv = JSON.parse(readFileSync(envFile, 'utf8')); break } catch { /* not written yet */ }
  }
  const url = mcpEnv.url
  if (!url || !/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) throw new Error(`scenario e: no loopback MCP URL from the waiter pane: ${url}`)
  if (mcpEnv.tok !== waiters[0]) throw new Error(`scenario e: pane token ${mcpEnv.tok} is not its pane id ${waiters[0]}`)
  // Clear the line, so the probe letters land on an empty prompt.
  await page.evaluate(async (id) => (await import('/src/tauri/terminal.ts' as string)).writeTerminal(id, 'cls\r'), waiters[0])
  await page.waitForTimeout(1000)
  return { roomId, mcpUrl: url, pairs: waiters.map((w, i) => ({ waiter: w, peer: peers[i] })) }
}

// Minimal MCP Streamable-HTTP client (initialize, then tools/call), like an
// agent CLI's MCP client. Answers come as JSON or as an SSE stream.
async function mcpSession(url: string, token: string): Promise<(name: string, args: unknown) => Promise<any>> {
  let sid: string | undefined
  let next = 0
  const rpc = async (method: string, params: unknown, notify = false): Promise<any> => {
    const id = ++next
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, ...(sid ? { 'mcp-session-id': sid } : {}) },
      body: JSON.stringify(notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params })
    })
    sid ??= res.headers.get('mcp-session-id') ?? undefined
    const body = await res.text()
    if (notify) return undefined
    if (!res.ok) throw new Error(`MCP ${method}: HTTP ${res.status} ${body.slice(0, 200)}`)
    const msgs = (res.headers.get('content-type') ?? '').includes('event-stream')
      ? body.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(Boolean).map(l => JSON.parse(l))
      : [JSON.parse(body)]
    const msg = msgs.find(x => x.id === id)
    if (!msg) throw new Error(`MCP ${method}: no answer`)
    if (msg.error) throw new Error(`MCP ${method}: ${JSON.stringify(msg.error)}`)
    return msg.result
  }
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'swarmterm-perf', version: '0' } })
  await rpc('notifications/initialized', {}, true)
  return async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args })
    if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.content)}`)
    return r.structuredContent ?? JSON.parse(r.content?.[0]?.text ?? 'null')
  }
}

// One loop per waiter until the deadline: war_room.wait_peer with
// afterChange (only a state entered after the call counts), so every return
// is one fresh working -> idle flip of the mock peer.
async function runWaiters(room: WarRoomRun, deadline: number): Promise<WaitRecord[]> {
  const out: WaitRecord[] = []
  await Promise.all(room.pairs.map(async ({ waiter, peer }) => {
    const call = await mcpSession(room.mcpUrl, waiter)
    while (Date.now() < deadline - 500) {
      const calledAt = Date.now()
      try {
        const r = await call('war_room.wait_peer', { peer, afterChange: true, timeoutMs: Math.max(1000, Math.min(30_000, deadline - calledAt)) })
        out.push({ peer, calledAt, returnedAt: Date.now(), outcome: String(r.outcome), state: String(r.state) })
        // A peer that left (or any instant non-reached answer) must not turn
        // this into a busy loop against the MCP server.
        if (r.outcome !== 'reached' && r.outcome !== 'timeout') await new Promise(res => setTimeout(res, 1000))
      } catch (e) {
        out.push({ peer, calledAt, returnedAt: Date.now(), outcome: 'error', state: '', error: String(e).slice(0, 300) })
        await new Promise(r => setTimeout(r, 1000))
      }
    }
  }))
  return out
}

// Resolve latency = wait_peer's return minus the mock's own idle flip (its
// log, same clock): the newest idle flip after the call started and before it
// returned. Covers generator -> ConPTY -> xterm -> detector -> mirror IPC ->
// peer_states -> wake -> MCP answer.
function summarizeWaits(recs: WaitRecord[], cwd: string, peers: string[], pairs: number, streaming: number): unknown {
  const flips = new Map<string, number[]>()
  for (const p of peers) {
    const f = join(cwd, `perf-mock-${p}.log`)
    flips.set(p, existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((l: string) => l.startsWith('idle ')).map((l: string) => Number(l.slice(5))) : [])
  }
  const lat: number[] = []
  let unmatched = 0
  // The mock only flips working <-> idle, which the app shows as idle or done
  // (unseen idle); any other reached state is counted apart, not timed.
  const idleLike = (s: string): boolean => s === 'idle' || s === 'done'
  for (const r of recs.filter(r => r.outcome === 'reached' && idleLike(r.state))) {
    const idle = (flips.get(r.peer) ?? []).filter(t => t >= r.calledAt && t <= r.returnedAt)
    if (idle.length) lat.push(r.returnedAt - Math.max(...idle)); else unmatched++
  }
  const count = (o: string): number => recs.filter(r => r.outcome === o).length
  return {
    pairs, streaming, calls: recs.length, reached: count('reached'), timeout: count('timeout'), stalled: count('stalled'), peerLeft: count('peer_left'), errors: count('error'),
    firstError: recs.find(r => r.error)?.error ?? null,
    reachedOtherState: recs.filter(r => r.outcome === 'reached' && !idleLike(r.state)).length,
    idleFlips: [...flips.values()].reduce((a, f) => a + f.length, 0), unmatched,
    resolve: { samples: lat.length, p50: pctl(lat, 0.5), p95: pctl(lat, 0.95), max: pctl(lat, 1) }
  }
}

function pctl(a: number[], p: number): number | null {
  if (!a.length) return null
  const b = [...a].sort((x, y) => x - y)
  return b[Math.min(b.length - 1, Math.floor(p * b.length))]
}

// ---------- scenario f: many visible panes + workspace switching ----------
type SwitchSample = { ws: number; t: number; webgl: number; domVisible: number; visible: number }

// Main workspace: 12 panes from the wizard, split up to `visible`; two more
// workspaces of 4 panes each to switch between. Every pane streams.
async function createManyVisible(page: Page, cwd: string, visible: number): Promise<{ ids: string[]; wsIds: string[] }> {
  return page.evaluate(async ({ cwd, visible }) => {
    const { useAppStore, visibleLeaves } = await import('/src/store/app-store.ts' as string)
    const st = (): any => useAppStore.getState()
    st().createWorkspace({ cwd, terminalCount: 12, agentIds: Array(12).fill('terminal'), name: 'perf-0' })
    const main = st().activeWorkspaceId
    const ws = (): any => st().workspaces.find((w: any) => w.id === main)
    for (let i = 0; visibleLeaves(ws()).length < visible; i++) st().splitPane(visibleLeaves(ws())[i].id, i % 2 ? 'horizontal' : 'vertical', 'terminal')
    const wsIds = [main]
    for (const k of [1, 2]) {
      st().createWorkspace({ cwd, terminalCount: 4, agentIds: Array(4).fill('terminal'), name: `perf-${k}` })
      wsIds.push(st().activeWorkspaceId)
    }
    useAppStore.setState({ activeWorkspaceId: main })
    const ids = wsIds.flatMap(w => visibleLeaves(st().workspaces.find((x: any) => x.id === w)).map((l: any) => l.terminalId))
    return { ids, wsIds }
  }, { cwd, visible })
}

async function switchWorkspaces(page: Page, wsIds: string[], t0: number, seconds: number, periodS: number, stats: boolean): Promise<SwitchSample[]> {
  const out: SwitchSample[] = []
  for (let k = 0; Date.now() - t0 < seconds * 1000; k++) {
    const ws = k % wsIds.length
    await page.evaluate(async (id) => { (await import('/src/store/app-store.ts' as string)).useAppStore.getState().setActiveWorkspace(id) }, wsIds[ws])
    // Sample once the switch has settled (attach, fit, renderer swap).
    await page.waitForTimeout(Math.min(1000, periodS * 500))
    // Without the hook only the switches themselves run (frames, long tasks).
    const s = stats ? await page.evaluate(async (REG) => (await import(REG)).perfRendererStats(), REG) : { webgl: 0, domVisible: 0, visible: 0 }
    out.push({ ws, t: Date.now() - t0, ...s })
    await page.waitForTimeout(Math.max(0, periodS * 1000 - Math.min(1000, periodS * 500)))
  }
  await page.evaluate(async (id) => { (await import('/src/store/app-store.ts' as string)).useAppStore.getState().setActiveWorkspace(id) }, wsIds[0])
  return out
}

function summarizeSwitches(s: SwitchSample[], panes: number, stats: boolean): unknown {
  if (!stats) {
    const u = 'unsupported'
    return { panes, switches: s.length, mainVisible: u, mainWebglMax: u, mainDomFallbackMax: u, webglMax: u, domFallbackMax: u, samples: s.map(x => ({ ws: x.ws, t: x.t })) }
  }
  const main = s.filter(x => x.ws === 0)
  const max = (a: SwitchSample[], k: 'webgl' | 'domVisible' | 'visible'): number | null => a.length ? Math.max(...a.map(x => x[k])) : null
  return {
    panes, switches: s.length,
    mainVisible: max(main, 'visible'), mainWebglMax: max(main, 'webgl'), mainDomFallbackMax: max(main, 'domVisible'),
    webglMax: max(s, 'webgl'), domFallbackMax: max(s, 'domVisible'),
    samples: s
  }
}

// Hard rule (docs/perf-baseline.md): the harness never runs an agent CLI or AI
// provider. Fails the run if ANY workspace in the instance (not only perf-*
// ones: a restored workspace could resume an agent session) has a default
// agent, or any leaf has a non-terminal agent, a session to resume, a
// start prompt or a startup command. The ONE exception, only when the
// scenario asks for it (allowMock), is the dev-only perf-mock-agent template,
// and only after checking in-page that it resolves to exactly the local
// generator command and is not one of the real templates.
async function assertPlainPanes(page: Page, allowMock: boolean): Promise<void> {
  const bad: string[] = await page.evaluate(async ({ allowMock, MOCK_ID, MOCK_COMMAND }) => {
    const { useAppStore } = await import('/src/store/app-store.ts' as string)
    // Every leaf in the layout, including drawered and floating ones.
    const { collectLeaves } = await import('/src/lib/layout-tree.ts' as string)
    const tpl = await import('/src/lib/templates.ts' as string)
    const out: string[] = []
    if (allowMock) {
      const t = tpl.templateById(MOCK_ID)
      if (tpl.TEMPLATES.some((x: any) => x.id === MOCK_ID)) out.push('perf-mock-agent is a real template')
      if (t.id !== MOCK_ID || t.command !== MOCK_COMMAND || tpl.agentCommand(MOCK_ID) !== MOCK_COMMAND || t.executable || t.launchModes || t.resume || t.continueCommand || t.spawnPromptFlag) {
        out.push(`perf-mock-agent does not resolve to exactly "${MOCK_COMMAND}"`)
      }
    }
    const allowed = (id: string): boolean => id === 'terminal' || (allowMock && id === MOCK_ID)
    for (const w of useAppStore.getState().workspaces as any[]) {
      if (w.defaultAgentId && w.defaultAgentId !== 'terminal') out.push(`workspace ${w.name}: defaultAgentId ${w.defaultAgentId}`)
      for (const l of collectLeaves(w.layout) as any[]) {
        const why = [
          l.agentId && !allowed(l.agentId) && `agentId ${l.agentId}`,
          l.agentId === MOCK_ID && !w.name?.startsWith('perf-') && 'mock agent outside a perf workspace',
          l.accountId && 'accountId', l.launchModeId && 'launchModeId',
          l.sessionId && 'sessionId', l.resumeSessionId && 'resumeSessionId', l.continueSession && 'continueSession',
          l.initialPrompt && 'initialPrompt', l.startupCommand && 'startupCommand'
        ].filter(Boolean)
        if (why.length) out.push(`workspace ${w.name} pane ${l.terminalId}: ${why.join(', ')}`)
      }
    }
    return out
  }, { allowMock, MOCK_ID, MOCK_COMMAND })
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

// kinds[i] is pane i's template id ('terminal' or the mock agent); padding
// panes that round a workspace up are plain terminals.
async function createPanes(page: Page, cwd: string, kinds: string[]): Promise<string[]> {
  return page.evaluate(async ({ cwd, kinds }) => {
    const total = kinds.length
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
      const from = total - left
      const agentIds = Array.from({ length: c }, (_, i) => kinds[from + i] ?? 'terminal')
      useAppStore.getState().createWorkspace({ cwd, terminalCount: c, agentIds, name: `perf-${wsIds.length}` })
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
  }, { cwd, kinds })
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
    // First non-echo chunk handed to xterm / parsed, last one handed over.
    let firstData = 0
    let firstParse = 0
    let lastWrite = 0
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
      if (!focused) { const t = performance.now(); if (t - lastData > maxGap) maxGap = t - lastData; lastData = lastWrite = t; if (!firstData) firstData = t }
      return orig.call(this, data, () => {
        st.parsed += text.length
        // The flood window ends at the last parse, so draining xterm's backlog
        // after the writes stop is still inside it.
        // Late callbacks from a previous scenario's closed panes must not
        // move this run's clocks: start() cleared their streams.
        if (!focused && streams.get(this) === st) { lastParse = performance.now(); floodEnd = lastParse; if (!firstParse) firstParse = lastParse }
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
        recording = true; prev = 0; lastData = lastParse = startAt = floodEnd = performance.now(); firstData = firstParse = lastWrite = 0
        // Dev-only render counter (src/lib/perf-render-count.ts) counts while set.
        ;(window as any).__perfRenderCounts = {}
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
        // Zero renders is a result, not a missing value.
        const renders = { WorkspaceTabs: 0, AttentionBadge: 0, ...((window as any).__perfRenderCounts ?? {}) }
        delete (window as any).__perfRenderCounts
        if (pending) { if (pending.busy) unansweredBusy++; else unanswered++; pending = undefined }
        const seq = [...streams.values()].filter(s => s.seen > 0)
        const lagged = [...streams.values()].filter(s => s.parse.length)
        const all = (k: 'recv' | 'parse' | 'recvD' | 'parseD'): number[] => lagged.flatMap(s => s[k])
        const lagStats = (a: number[]) => ({ samples: a.length, p50: pct(a, 0.5), p95: pct(a, 0.95), max: pct(a, 1) })
        let expected = 2166136261
        for (let i = 0; i < lines; i++) expected = FNV(expected, i)
        return {
          floodSeconds: Math.round(floodEnd - startAt) / 1000,
          // Output timing from start(): first chunk handed to xterm / parsed,
          // the span of hand-overs (stream duration) and the last parse (all
          // output parsed). Null when no output came at all.
          outputTiming: firstData ? {
            firstOutputMs: Math.round(firstData - startAt), firstParsedMs: firstParse ? Math.round(firstParse - startAt) : null,
            streamSeconds: Math.round(lastWrite - firstData) / 1000, allParsedMs: firstParse ? Math.round(floodEnd - startAt) : null
          } : null,
          // Component renders during the window (WorkspaceTabs, AttentionBadge).
          renders,
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
