#!/usr/bin/env node
// Top-N summary of one profiled scenario folder (docs/perf-profiling.md).
// Usage: node scripts/perf/profile-summary.mjs <dir> [topN]
// Reads whatever exists of: renderer.cpuprofile, renderer.json, procs.csv,
// rust.json, etw-spawn.csv. Prints compact tables only; the raw files stay
// for DevTools / speedscope / WPA.
import { existsSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'

const dir = process.argv[2]
const N = Number(process.argv[3] ?? 15)
if (!dir) { console.error('usage: profile-summary.mjs <dir> [topN]'); process.exit(2) }
const read = f => { const p = join(dir, f); return existsSync(p) ? readFileSync(p, 'utf8') : null }
const ms = x => (x ?? 0).toFixed(1).padStart(9)
const pad = (s, n) => String(s).slice(0, n).padEnd(n)
const top = (rows, key) => rows.sort((a, b) => b[key] - a[key]).slice(0, N)

console.log(`== profile ${dir}`)
// One section's bad input (a truncated file from a failed run) must not hide the others.
const safe = f => { try { f() } catch (e) { console.log(`(section skipped: ${e.message})`) } }

safe(() => {
// ---- completion time + CPU per unit of work (user priority: a run that
// burns more CPU but finishes sooner is a win; show both side by side) ----
{
  const res = read('result.json') && JSON.parse(read('result.json'))
  const work = read('work.json') && JSON.parse(read('work.json'))
  const procs = read('procs.csv')
  const appCpuS = procs ? procs.trim().split(/\r?\n/).slice(1).reduce((t, l) => t + (Number(l.split(',')[4]) || 0) / 100, 0) : null
  const done = res?.floodSeconds ?? res?.timing?.runS
  const parts = [
    `completion ${done != null ? done.toFixed(1) + ' s' : 'n/a'}`,
    `run ${res?.timing?.runS?.toFixed(1) ?? 'n/a'} s`,
    `total ${res?.timing?.totalS?.toFixed(1) ?? 'n/a'} s`,
    `CPU ${appCpuS != null ? appCpuS.toFixed(1) + ' s' : 'n/a'}`,
  ]
  if (work && appCpuS != null) parts.push(`CPU/unit ${(appCpuS / work.units).toFixed(3)} s per ${work.unit} (${work.units} ${work.unit})`)
  if (work && done) parts.push(`throughput ${(work.units / done).toFixed(2)} ${work.unit}/s`)
  console.log(parts.join(' | '))
}
})

safe(() => {
// ---- V8 CPU profile: self time per function ----
const cpu = read('renderer.cpuprofile')
if (cpu) {
  const p = JSON.parse(cpu)
  const byId = new Map(p.nodes.map(n => [n.id, n]))
  const self = new Map()
  let total = 0
  p.samples.forEach((id, i) => {
    const dt = (p.timeDeltas[i + 1] ?? 0) / 1000
    total += dt
    const cf = byId.get(id)?.callFrame
    const key = cf ? `${cf.functionName || '(anonymous)'} ${basename(cf.url || '') || cf.url}:${cf.lineNumber + 1}` : '?'
    self.set(key, (self.get(key) ?? 0) + dt)
  })
  console.log(`\n-- JS self time (top ${N}, ${total.toFixed(0)} ms sampled)`)
  for (const r of top([...self].map(([k, v]) => ({ k, v })), 'v')) console.log(`${ms(r.v)} ms ${(100 * r.v / total).toFixed(1).padStart(5)}%  ${r.k}`)
}
})

safe(() => {
// ---- renderer.json: LoAF scripts, metrics, process CPU by type ----
const rj = read('renderer.json')
if (rj) {
  const r = JSON.parse(rj)
  if (Array.isArray(r.loaf)) {
    const frames = r.loaf
    const agg = new Map()
    for (const f of frames) for (const s of f.scripts) {
      const k = `${s.fn || '(anon)'} @ ${basename(s.src || '') || s.invoker}`
      const a = agg.get(k) ?? { k, n: 0, total: 0, max: 0, layout: 0 }
      a.n++; a.total += s.duration; a.max = Math.max(a.max, s.duration); a.layout += s.forcedLayout ?? 0
      agg.set(k, a)
    }
    const blocking = frames.reduce((t, f) => t + (f.blocking ?? 0), 0)
    console.log(`\n-- long animation frames: ${frames.length} (>50 ms), blocking ${blocking.toFixed(0)} ms; top scripts`)
    for (const a of top([...agg.values()], 'total')) console.log(`${ms(a.total)} ms  n=${String(a.n).padStart(4)} max ${a.max.toFixed(0).padStart(4)} layout ${a.layout.toFixed(0).padStart(4)}  ${a.k}`)
  } else console.log('\n-- long animation frames: unsupported by this WebView2')
  console.log(`\n-- process CPU by type (CDP SystemInfo, ${r.seconds.toFixed(0)} s)`)
  for (const [t, v] of Object.entries(r.processCpu)) console.log(`${pad(t, 16)} pids ${String(v.pids).padStart(2)}  cpu ${v.cpuS.toFixed(1).padStart(7)} s  avg ${v.avgCores.toFixed(2)} cores`)
  const d = k => (r.metrics.end[k] ?? 0) - (r.metrics.start[k] ?? 0)
  console.log(`metrics delta: TaskDuration ${d('TaskDuration').toFixed(2)} s, ScriptDuration ${d('ScriptDuration').toFixed(2)} s, LayoutDuration ${d('LayoutDuration').toFixed(2)} s, RecalcStyleDuration ${d('RecalcStyleDuration').toFixed(2)} s, JSHeapUsed end ${((r.metrics.end.JSHeapUsedSize ?? 0) / 2 ** 20).toFixed(0)} MB`)
}
})

safe(() => {
// ---- procs.csv: 1 Hz per-pid CPU, averaged per name/type ----
const pc = read('procs.csv')
if (pc) {
  const agg = new Map()
  for (const line of pc.trim().split(/\r?\n/).slice(1)) {
    const [, pid, name, type, pct] = line.split(',')
    if (pct === '') continue
    const k = `${name}${type ? ':' + type : ''}`
    const a = agg.get(k) ?? { k, pids: new Set(), sum: 0, n: 0, max: 0 }
    a.pids.add(pid); a.sum += Number(pct); a.n++; a.max = Math.max(a.max, Number(pct))
    agg.set(k, a)
  }
  // Average total % = sum of per-pid samples / number of seconds sampled.
  const secs = new Set(pc.trim().split(/\r?\n/).slice(1).map(l => l.split(',')[0])).size || 1
  console.log(`\n-- per-process CPU (1 Hz sampler, ${secs} s; % of one core)`)
  for (const a of top([...agg.values()].map(a => ({ ...a, avg: a.sum / secs })), 'avg')) console.log(`${pad(a.k, 30)} pids ${String(a.pids.size).padStart(3)}  avg ${a.avg.toFixed(1).padStart(6)}%  peak/pid ${a.max.toFixed(0).padStart(4)}%`)
}
})

safe(() => {
// ---- rust.json: locks, flow park, channel, commands, watchdog, tokio ----
const rs = read('rust.json')
if (rs) {
  const r = JSON.parse(rs)
  const h = Object.entries(r.histograms).map(([k, v]) => ({ k, ...v }))
  const section = (title, f) => {
    const rows = top(h.filter(x => f(x.k)), 'total_ms')
    if (!rows.length) return
    console.log(`\n-- ${title}`)
    for (const x of rows) console.log(`${pad(x.k, 34)} n ${String(x.count).padStart(8)}  total ${ms(x.total_ms)} ms  p99<= ${x.p99_ms_le.toFixed(2).padStart(7)}  max ${x.max_ms.toFixed(2).padStart(8)} ms`)
  }
  console.log('\n(rust counters share one registry mutex: rank by them, do not read absolutes)')
  section('lock waits', k => k.startsWith('lock.') && k.endsWith('.wait'))
  section('lock holds', k => k.startsWith('lock.') && !k.endsWith('.wait'))
  section('flow park / channel backpressure', k => k.startsWith('flow.') || k.startsWith('chan.'))
  section('command + IPC spans', k => k.startsWith('cmd.') || k.startsWith('ipc.'))
  section('main thread dispatch delay', k => k.startsWith('main.'))
  const st = r.main_thread_stalls ?? []
  console.log(`\nmain-thread stalls > 16 ms: ${st.length}${st.length ? '; worst: ' + top([...st], 'delay_ms').slice(0, 5).map(s => `${s.delay_ms.toFixed(0)} ms @${(s.at_ms / 1000).toFixed(1)} s`).join(', ') : ''}`)
  console.log(`tokio: ${JSON.stringify(r.tokio)}`)
}
})

safe(() => {
// ---- etw-spawn.csv ----
const es = read('etw-spawn.csv')
if (es) {
  const rows = es.trim().split(/\r?\n/).slice(1).map(l => l.replaceAll('"', '').split(','))
  const byImage = new Map()
  for (const [, ev, , , image] of rows) if (ev === 'start') { const k = basename((image ?? '').replaceAll('\\', '/')); byImage.set(k, (byImage.get(k) ?? 0) + 1) }
  console.log(`\n-- ETW process starts by image (${rows.length} events)`)
  for (const [k, v] of [...byImage].sort((a, b) => b[1] - a[1]).slice(0, N)) console.log(`${String(v).padStart(5)}  ${k}`)
}
})
