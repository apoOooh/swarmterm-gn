/**
 * Minimal SGR → coloured spans for the status line preview (SWA-92). The rows
 * come from the real Rust renderer, so the picker shows exactly what Claude
 * Code will print; only foreground colours are rendered here.
 */
export interface AnsiSpan {
  text: string
  /** CSS colour; absent = the preview's default text colour. */
  color?: string
}

// VS Code "Dark Modern" terminal colours, the palette the panes use
// (`terminal-registry.ts`), behind variables a theme may override.
const BASIC: Record<number, [string, string]> = {
  30: ['black', '#000000'],
  31: ['red', '#cd3131'],
  32: ['green', '#0dbc79'],
  33: ['yellow', '#e5e510'],
  34: ['blue', '#2472c8'],
  35: ['magenta', '#bc3fbc'],
  36: ['cyan', '#11a8cd'],
  37: ['white', '#e5e5e5'],
  90: ['bright-black', '#666666'],
  91: ['bright-red', '#f14c4c'],
  92: ['bright-green', '#23d18b'],
  93: ['bright-yellow', '#f5f543'],
  94: ['bright-blue', '#3b8eea'],
  95: ['bright-magenta', '#d670d6'],
  96: ['bright-cyan', '#29b8db'],
  97: ['bright-white', '#e5e5e5']
}

function color256(n: number): string | undefined {
  if (n >= 232 && n <= 255) {
    const v = 8 + (n - 232) * 10
    return `rgb(${v}, ${v}, ${v})`
  }
  if (n >= 16 && n <= 231) {
    const steps = [0, 95, 135, 175, 215, 255]
    const i = n - 16
    return `rgb(${steps[Math.floor(i / 36)]}, ${steps[Math.floor(i / 6) % 6]}, ${steps[i % 6]})`
  }
  const basic = BASIC[n < 8 ? 30 + n : 82 + n]
  return basic ? `var(--ansi-${basic[0]}, ${basic[1]})` : undefined
}

export function parseAnsi(input: string): AnsiSpan[] {
  const spans: AnsiSpan[] = []
  let color: string | undefined
  const push = (text: string): void => {
    if (text) spans.push(color ? { text, color } : { text })
  }
  const re = /\x1b\[([0-9;]*)m/g
  let last = 0
  for (let m = re.exec(input); m; m = re.exec(input)) {
    push(input.slice(last, m.index))
    last = re.lastIndex
    const codes = m[1] === '' ? [0] : m[1].split(';').map(Number)
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]
      if (c === 0 || c === 39) color = undefined
      else if (BASIC[c]) color = `var(--ansi-${BASIC[c][0]}, ${BASIC[c][1]})`
      else if (c === 38 && codes[i + 1] === 2) {
        color = `rgb(${codes[i + 2]}, ${codes[i + 3]}, ${codes[i + 4]})`
        i += 4
      } else if (c === 38 && codes[i + 1] === 5) {
        color = color256(codes[i + 2])
        i += 2
      }
    }
  }
  push(input.slice(last))
  return spans
}
