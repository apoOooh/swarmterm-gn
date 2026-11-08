// Synthetic tool-heavy agent for perf scenario g (scripts/perf/flood.ps1).
// Pure local simulation: no network, no AI provider, no agent CLI. It imitates
// what a coding agent's tool calls do to a pane and its workspace:
//   - many short-lived child processes (cmd.exe one-liners and small loops,
//     now and then pwsh -NoProfile), each sharing the pane's console like a
//     tool's bash/cmd call; every spawn's round trip (spawn -> exit) is timed
//   - bursty small output with pauses in between
//   - file reads/writes/creates/deletes in its own folder, including storms of
//     STORM_FILES creates + deletes in a fresh storm-<round> folder: 160+ raw
//     events, past the watcher's RESCAN_BURST (64), so every storm enters
//     storm mode
//   - frequent small appends to a log file
//   - occasionally a large output (`type` of a ~200 KB file)
// Usage: node tool-agent.mjs <seconds> <index>
// The pane's cwd is the perf data dir; files go to ./perf-tool-ws/<index>/,
// removed at the end (also on Ctrl+C). The summary (spawn counts and round
// trips, storm start times for the harness's file-event latency) is written
// to ./perf-tool-<index>.json.
// Deterministic: the action schedule depends only on the round number and the
// seed (index), never on timing.
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const seconds = Number(process.argv[2] ?? 75)
const index = Number(process.argv[3] ?? 1)
const STORM_FILES = 80
const dir = join('perf-tool-ws', String(index))
const big = join(dir, 'big.txt')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
// ~200 KB of short lines (never wrap in a pane).
writeFileSync(big, Array.from({ length: 4096 }, (_, i) => `B${String(i).padStart(6, '0')}|tool output line ${index} abcdefghijklmnopqrstu\r\n`).join(''))

// mulberry32: same sequence for the same seed.
let s = (index * 0x9e3779b9) >>> 0
const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const spawns = { cmd: [], pwsh: [], big: [] }
let spawnFailed = 0
const storms = []
let fileOps = 0

// The child inherits the pane's console, like a tool call whose output the
// agent shows. Resolves with the round trip in ms (spawn to exit).
function run(kind, file, args) {
  const t = performance.now()
  return new Promise((resolve) => {
    const c = spawn(file, args, { stdio: 'inherit', windowsHide: true, windowsVerbatimArguments: file === 'cmd.exe' })
    c.on('error', () => { spawnFailed++; resolve() })
    c.on('exit', (code) => { if (code === 0) spawns[kind].push(performance.now() - t); else spawnFailed++; resolve() })
  })
}
const cmd = (line, kind = 'cmd') => run(kind, 'cmd.exe', ['/d', '/s', '/c', `"${line}"`])

// Each storm has its own folder, so the harness can tell its events from the
// other file traffic; start/end let it match a trailing rescan too.
function storm(r) {
  const start = Date.now()
  const sd = join(dir, `storm-${r}`)
  mkdirSync(sd)
  for (let i = 0; i < STORM_FILES; i++) writeFileSync(join(sd, `f${i}.tmp`), `x${i}\n`)
  for (let i = 0; i < STORM_FILES; i++) unlinkSync(join(sd, `f${i}.tmp`))
  rmdirSync(sd)
  fileOps += 2 * STORM_FILES + 2
  storms.push({ key: `${index}/storm-${r}`, start, end: Date.now() })
}

function smallFiles(r) {
  for (let i = 0; i < 20; i++) writeFileSync(join(dir, `src-${i}.txt`), `round ${r} file ${i}\n`.repeat(1 + (i % 5)))
  let bytes = 0
  for (let i = 0; i < 20; i++) bytes += readFileSync(join(dir, `src-${i}.txt`)).length
  fileOps += 40
  process.stdout.write(`read 20 files, ${bytes} bytes\r\n`)
}

let cleaned = false
function cleanup() {
  if (cleaned) return
  cleaned = true
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* a child may still hold a handle */ }
}
function summary() {
  const st = (a) => {
    const o = [...a].sort((x, y) => x - y)
    const p = (q) => (o.length ? Math.round(o[Math.min(o.length - 1, Math.floor(q * o.length))] * 10) / 10 : null)
    return { count: o.length, p50: p(0.5), p95: p(0.95), max: o.length ? Math.round(o[o.length - 1] * 10) / 10 : null }
  }
  writeFileSync(`perf-tool-${index}.json`, JSON.stringify({ index, cmd: st(spawns.cmd), pwsh: st(spawns.pwsh), big: st(spawns.big), spawnFailed, fileOps, storms }))
}
process.on('SIGINT', () => { summary(); cleanup(); process.exit(130) })

const end = Date.now() + seconds * 1000
try {
for (let r = 0; Date.now() < end; r++) {
  switch (r % 12) {
    case 0: case 1: case 3: case 5: case 8:
      await cmd(`echo [tool ${index}.${r}] git status --short`)
      break
    case 2:
      await cmd(`for /l %i in (1,1,${5 + Math.floor(rnd() * 20)}) do @echo   match %i: src/file-%i.ts`)
      break
    case 4:
      smallFiles(r)
      await cmd(`dir /b "${dir}"`)
      break
    case 6:
      storm(r)
      await cmd(`echo [tool ${index}.${r}] wrote and removed ${STORM_FILES} files`)
      break
    case 7:
      for (let i = 0; i < 50; i++) appendFileSync(join(dir, 'agent.log'), `${r}:${i}\n`)
      fileOps += 50
      break
    case 9:
      // Large output every 4th cycle, pwsh every 4th cycle (offset), else a cmd.
      if (Math.floor(r / 12) % 4 === 1) await cmd(`type "${big}"`, 'big')
      else if (Math.floor(r / 12) % 4 === 3) await run('pwsh', 'pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-ChildItem '${dir}' | Measure-Object | Select-Object -ExpandProperty Count`])
      else await cmd(`ver`)
      break
    case 10:
      // Agent "thinks": a pause with no output.
      await sleep(300 + Math.floor(rnd() * 900))
      break
    case 11:
      process.stdout.write(`\x1b[2m[tool ${index}] round ${r}\x1b[0m\r\n`)
      break
  }
  await sleep(40 + Math.floor(rnd() * 110))
}
} finally {
  // Also on an exception, so the harness still gets the numbers so far.
  summary()
  cleanup()
}
process.stdout.write(`perf-tool ${index} done\r\n`)
