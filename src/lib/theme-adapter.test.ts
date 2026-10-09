import { describe, expect, it } from 'vitest'
import { THEMES } from './theme/themes'
import { themeVariables, terminalTheme, styleOptions } from './theme-adapter'
import { readStoredStyle } from './appearance'

describe('Astera theme integration', () => {
  it('retains the original style alongside all seven Astera styles', () => {
    expect(styleOptions.map(t => t.id)).toEqual(['vscode-dark', ...THEMES.map(t => t.id)])
    for (const theme of THEMES) {
      expect(readStoredStyle({ getItem: () => theme.id, setItem: () => {} })).toBe(theme.id)
    }
  })
  it('preserves translucent borders instead of making them opaque white', () => {
    expect(themeVariables('umbra')['--color-border']).toBe('255 255 255')
    expect(themeVariables('umbra')['--color-border-alpha']).toBe('0.07')
    expect(themeVariables('quasar')['--radius-sm']).toBe('1px')
  })
  it('updates terminal colors without replacing ANSI colors', () => {
    expect(terminalTheme('umbra')).toMatchObject({ background: '#000000', foreground: '#fafafa', cursor: '#4c7ef3' })
    expect(terminalTheme('aurora')).not.toHaveProperty('red')
    expect(terminalTheme('vscode-dark').background).toBe('#1F1F1F')
  })
  it('retains density and bundled font choices', () => {
    expect(themeVariables('quasar')['--row-pad-y']).toBe('3px')
    expect(themeVariables('umbra')['--row-pad-y']).toBe('6px')
    expect(themeVariables('sirius')['--sans']).toContain('Public Sans')
  })
})
