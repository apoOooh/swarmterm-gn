// Synthetic agent-like output for perf scenario d (scripts/perf/flood.ps1).
// Pure local generator: no network, no AI provider, no agent CLI. It imitates
// what a TUI coding agent writes to its pane:
//   - a spinner + status line redrawn at ~15 Hz (save/restore cursor, SGR,
//     erase line) below a scroll region
//   - bursts of streamed markdown/code at token rates (~40-90 tokens/s)
//   - occasional large tool-output dumps (100-400 KB in one go)
//   - OSC 0 title and OSC 9;4 progress updates
//   - an input box that echoes keystrokes at once (IN#<n>:<char>), like an
//     agent's prompt line, so the harness can probe echo in a busy pane
// Every streamed line starts with a delivery token @T<epoch ms 13 digits>|
// written at the moment the line starts (tool-dump lines use @D, so the
// harness can tell interactive text from bulk output); the harness compares
// it with the time xterm parsed it. Lines are cut to the pane width so ConPTY never wraps
// a token.
// Usage: node agent-stream.mjs <seconds> <seed>
const seconds = Number(process.argv[2] ?? 150)
let seed = (Number(process.argv[3] ?? 1) * 2654435761) >>> 0
const rnd = () => { seed = (Math.imul(seed ^ (seed >>> 15), 2246822519) + 0x9e3779b9) >>> 0; return seed / 4294967296 }
const pick = (a) => a[Math.floor(rnd() * a.length)]
const out = process.stdout
const E = '\x1b'
const cols = () => Math.max(30, out.columns || 80)
const rows = () => Math.max(8, out.rows || 24)
const end = Date.now() + seconds * 1000
// The vocabulary never contains "@T" or "IN#", so neither marker can occur
// outside the delivery tokens and the input box.
const words = 'the a function return value state buffer render pane output write stream token parse update test module config error handler async await const let type interface props render store layout terminal queue flush batch reader thread channel resize scroll cursor colour frame'.split(' ')
const code = ['const x = await load(id)', 'if (!ok) throw new Error(msg)', 'for (const p of panes) p.fit()', 'return { ...s, dirty: true }', 'export function flush(q) {', '  q.splice(0).forEach(send)', '}', 'let n = 0; while (n < 8) n++', 'fn next_batch(&mut self) -> Vec<u8>', 'impl Drop for Reader { }']
const spin = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
let tokens = 0
let typed = 0
let frame = 0
let pct = 0

const setup = () => out.write(`${E}[2J${E}[1;${rows() - 2}r${E}[${rows() - 2};1H`)
setup()
out.on('resize', setup)

// One streamed line: token first (its own write, stamped now), then the text
// in a few token-sized pieces so the line arrives progressively.
function line(text, sgr = '') {
  const max = cols() - 18
  out.write(`\r\n@T${Date.now()}|`)
  const t = text.slice(0, max)
  out.write(sgr + t + (sgr ? `${E}[0m` : ''))
  tokens += Math.ceil(t.length / 4)
}

function status() {
  const s = `${E}7${E}[${rows() - 1};1H${E}[2K${E}[38;5;208m${spin[frame++ % spin.length]}${E}[0m ${E}[1mWorking${E}[0m${E}[2m (${Math.round((Date.now() - (end - seconds * 1000)) / 1000)}s · ${tokens} tokens · esc to interrupt)${E}[0m${E}8`
  out.write(s)
  if (frame % 15 === 0) {
    pct = (pct + 3) % 100
    out.write(`${E}]0;✳ agent ${process.argv[3]} – step ${frame}\x07${E}]9;4;1;${pct}\x07`)
  }
}

// Echo the input box at once, also during a burst: keystrokes are handled
// between timer ticks, like an agent TUI's input loop.
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.on('data', (d) => {
  for (const ch of d.toString('utf8')) {
    if (ch === '\x03') { finish(); return }
    typed++
    out.write(`${E}7${E}[${rows()};1H${E}[2K${E}[36m> ${E}[0mIN#${typed}:${ch}${E}8`)
  }
})

const spinner = setInterval(status, 66)
let phase = 'think'
let phaseEnd = Date.now() + 1000 + rnd() * 3000
let chunk = []

function nextPhase() {
  const r = rnd()
  if (phase !== 'tool' && r < 0.25) phase = 'tool'
  else if (r < 0.55) phase = 'think'
  else phase = 'stream'
  phaseEnd = Date.now() + (phase === 'think' ? 1000 + rnd() * 4000 : 4000 + rnd() * 10000)
}

// 50 ms tick: at 40-90 tokens/s, ~2-5 tokens (8-20 chars) per tick, i.e. a
// line every ~0.3 s; one in ~6 lines is a fenced code line or heading.
const ticker = setInterval(() => {
  const now = Date.now()
  if (now >= end) { finish(); return }
  if (phase === 'tool') {
    // A tool result: 100-400 KB of numbered lines (a grep, a test log) in
    // one write, as an agent prints a captured command output.
    const kb = 100 + Math.floor(rnd() * 300)
    let s = ''
    let n = 0
    const max = cols() - 18
    while (s.length < kb * 1024) {
      // Cut the visible text to the width, then add the SGR around the number.
      const body = `${String(n++).padStart(5)} src/${pick(words)}/${pick(words)}.ts: ${pick(words)} ${pick(words)} ${pick(words)}`.slice(0, max)
      s += `\r\n@D${Date.now()}|${E}[2m${body.slice(0, 5)}${E}[0m${body.slice(5)}`
    }
    out.write(s)
    nextPhase()
    return
  }
  if (phase === 'stream') {
    const tok = 2 + Math.floor(rnd() * 4)
    for (let i = 0; i < tok; i++) chunk.push(pick(words))
    if (chunk.join(' ').length > cols() - 24 || rnd() < 0.1) {
      const r = rnd()
      if (r < 0.08) line('## ' + chunk.join(' '), `${E}[1;34m`)
      else if (r < 0.2) line(pick(code), `${E}[38;2;206;145;120m`)
      else if (r < 0.25) line('- **' + chunk[0] + '** ' + chunk.slice(1).join(' '))
      else line(chunk.join(' '))
      chunk = []
    }
  }
  if (now >= phaseEnd) nextPhase()
}, 50)

let done = false
function finish() {
  if (done) return
  done = true
  clearInterval(spinner); clearInterval(ticker)
  out.write(`${E}]9;4;0;0\x07${E}[r${E}[${rows()};1H\r\nagent-stream done\r\n`)
  if (process.stdin.isTTY) process.stdin.setRawMode(false)
  process.stdin.pause()
  setTimeout(() => process.exit(0), 50)
}
