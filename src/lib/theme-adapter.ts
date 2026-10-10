import type { ITheme } from '@xterm/xterm'
import type { Style } from './appearance'
import { themeCssVars } from './theme/apply'
import { parseColor } from './theme/color'
import { THEMES, themeById, type Theme } from './theme/themes'

export interface StyleOption { id: Style; label: string; surface: string }
export const styleOptions: readonly StyleOption[] = [
  { id: 'vscode-dark', label: 'VS Code Dark', surface: 'Modern' },
  ...THEMES.map(t => ({ id: t.id, label: t.name, surface: `${t.density} density` }))
]

// Keep the upstream default. Astera's own theme data remains unchanged under theme/.
const vscode: Theme = {
  id: 'vega', name: 'VS Code Dark',
  colors: {
    bg: '#1f1f1f', rail: '#1f1f1f', panel: '#1f1f1f', elevated: '#2b2b2b',
    surfaceHover: '#2e2e2e', termBg: '#1f1f1f', line: '#2b2b2b', lineSoft: '#404040',
    text: '#cccccc', textDim: '#9e9e9e', textFaint: '#767676', railIcon: '#9e9e9e',
    accent: '#0078d4', accentInk: '#ffffff', statusBg: '#181818', statusInk: '#cccccc', mdLink: '#3794ff'
  },
  radius: { base: '6px', lg: '8px', sm: '4px' }, markerW: '2px',
  shadow: { sm: '0 1px 2px rgba(0,0,0,.3)', lg: '0 20px 25px rgba(0,0,0,.25)' },
  density: 'normal',
  font: { sans: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif", mono: null, tracking: '0' }
}

export const visualTheme = (style: Style): Theme => style === 'vscode-dark' ? vscode : themeById(style)

function hsl(r: number, g: number, b: number): string {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min
  const lightness = (max + min) / 2
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1))
  const hue = delta === 0 ? 0 : max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4
  return `${+(hue * 60).toFixed(4)} ${+(saturation * 100).toFixed(4)}% ${+(lightness * 100).toFixed(4)}%`
}

/** RGB channels plus a separate alpha preserve Astera's translucent lines through Tailwind's /opacity modifiers. */
export function themeVariables(style: Style): Record<string, string> {
  const theme = visualTheme(style), c = theme.colors
  const variables = themeCssVars(theme)
  const colors: Record<string, string> = {
    background: c.bg, canvas: style === 'vscode-dark' ? '#121212' : c.rail, foreground: c.text,
    card: c.panel, 'card-foreground': c.text, popover: c.elevated, 'popover-foreground': c.text,
    primary: c.accent, 'primary-foreground': c.accentInk,
    secondary: c.rail, 'secondary-foreground': c.text, muted: c.elevated, 'muted-foreground': c.textDim,
    accent: c.surfaceHover, 'accent-foreground': c.text, border: c.line, 'pane-border': c.lineSoft,
    input: c.lineSoft, ring: c.accent, destructive: '#f14c4c', 'destructive-foreground': '#ffffff',
    broadcast: '#2dc4b2', activity: '#facb17'
  }
  for (const [name, value] of Object.entries(colors)) {
    const rgba = parseColor(value)!
    variables[`--color-${name}`] = `${rgba.r} ${rgba.g} ${rgba.b}`
    variables[`--color-${name}-alpha`] = String(rgba.a)
    // Existing inline hsl() consumers remain compatible; Tailwind uses the lossless RGB tokens.
    variables[`--${name}`] = hsl(rgba.r, rgba.g, rgba.b)
  }
  if (style === 'vscode-dark') {
    variables['--row-pad-y'] = '6px'
    variables['--pane-tabbar-h'] = '28px'
  }
  return variables
}

export function terminalTheme(style: Style): ITheme {
  const c = visualTheme(style).colors
  return {
    background: style === 'vscode-dark' ? '#1F1F1F' : c.termBg,
    foreground: c.text, cursor: style === 'vscode-dark' ? c.text : c.accent,
    cursorAccent: c.termBg, selectionBackground: 'rgba(255,255,255,.25)'
  }
}

export function applyVisualStyle(style: Style): void {
  const root = document.documentElement
  for (const [name, value] of Object.entries(themeVariables(style))) root.style.setProperty(name, value)
  root.dataset.theme = style
}
