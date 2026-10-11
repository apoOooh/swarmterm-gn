import { APP_ACTIONS } from './app-actions'
import type { ShortcutKeyEvent } from './keybindings'

export type ShortcutOverrides = Record<string, string>
const MODIFIERS = ['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift']
const KEYS = /^(?:[a-z0-9,./;\[\]\\`'-]|F(?:[1-9]|1[0-2])|Enter|Backspace|Delete|Home|End|PageUp|PageDown|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Space)$/i
export function normalizeBinding(raw: string): string | null {
  if (raw === '') return ''
  const parts = raw.split('+'), key = parts.pop() ?? ''
  if (!KEYS.test(key) || !parts.length || parts.some(p => !MODIFIERS.includes(p)) || new Set(parts).size !== parts.length) return null
  if (parts.includes('Mod') && (parts.includes('Ctrl') || parts.includes('Meta'))) return null
  if (!parts.some(p => ['Mod','Ctrl','Meta','Alt'].includes(p))) return null
  const named = ['Enter','Backspace','Delete','Home','End','PageUp','PageDown','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space']
  const canonical = key.length === 1 || /^f\d+$/i.test(key) ? key.toUpperCase() : named.find(k => k.toLowerCase() === key.toLowerCase()) ?? key
  return [...MODIFIERS.filter(m => parts.includes(m)), canonical].join('+')
}
export function bindingFromEvent(e: ShortcutKeyEvent, isMac: boolean): string | null {
  if (['Control','Meta','Alt','Shift','AltGraph','Dead','Unidentified'].includes(e.key)) return null
  const modifiers = [isMac ? e.metaKey && 'Mod' : e.ctrlKey && 'Mod', isMac ? e.ctrlKey && 'Ctrl' : e.metaKey && 'Meta', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean)
  return normalizeBinding([...modifiers, e.key === ' ' ? 'Space' : e.key].join('+'))
}
export function bindingMatches(binding: string, e: ShortcutKeyEvent, isMac: boolean): boolean {
  const parts = binding.split('+'), key = parts.pop()
  return !!key && key.toLowerCase() === (e.key === ' ' ? 'Space' : e.key).toLowerCase()
    && e.ctrlKey === (parts.includes('Ctrl') || (!isMac && parts.includes('Mod')))
    && e.metaKey === (parts.includes('Meta') || (isMac && parts.includes('Mod')))
    && e.altKey === parts.includes('Alt') && e.shiftKey === parts.includes('Shift')
}
export function reservedBinding(binding: string, isMac: boolean): boolean {
  const e = { key: '', ctrlKey: !isMac, metaKey: isMac, shiftKey: false, altKey: false }
  return ['c','v','x','a','z','r'].some(key => bindingMatches(binding, { ...e, key }, isMac)) || bindingMatches(binding,{...e,key:'r',shiftKey:true},isMac) || binding === 'Alt+F4'
}
export interface ShortcutTarget { id: string; defaultBinding?: string }
export function resolveShortcut(e: ShortcutKeyEvent, isMac: boolean, overrides: ShortcutOverrides, extra: ShortcutTarget[] = []): string | null {
  // Every valid binding has a command modifier. Ordinary terminal text should
  // bypass the action list without allocating or parsing binding strings.
  if (!e.ctrlKey && !e.metaKey && !e.altKey) return null
  return [...APP_ACTIONS, ...extra].find(a => bindingMatches(overrides[a.id] ?? a.defaultBinding ?? '', e, isMac))?.id ?? null
}
export function bindingConflict(id: string, binding: string, overrides: ShortcutOverrides, extra: ShortcutTarget[] = [], isMac = false): string | null {
  if (!binding) return null
  const parts = binding.split('+'), key = parts.pop() ?? ''
  const e = { key: key === 'Space' ? ' ' : key, ctrlKey: parts.includes('Ctrl') || (!isMac && parts.includes('Mod')), metaKey: parts.includes('Meta') || (isMac && parts.includes('Mod')), shiftKey: parts.includes('Shift'), altKey: parts.includes('Alt') }
  return [...APP_ACTIONS, ...extra].find(a => a.id !== id && bindingMatches(overrides[a.id] ?? a.defaultBinding ?? '', e, isMac))?.id ?? null
}
