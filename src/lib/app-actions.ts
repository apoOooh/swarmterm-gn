import type { AppShortcutAction } from './keybindings'

export type BuiltinActionId = AppShortcutAction | 'new-workspace' | 'open-settings' | 'split-horizontal' | 'split-vertical' | 'close-pane' | 'close-workspace' | 'next-workspace' | 'previous-workspace' | 'next-pane' | 'previous-pane' | 'tidy-layout' | 'select-all-broadcast' | 'clear-broadcast' | 'save-file' | 'cycle-markdown' | 'open-prompts' | 'open-routines' | 'dictate'
export interface AppAction { id: BuiltinActionId; label: string; group: string; defaultBinding?: string; macro?: boolean }
/** The window handler and terminal gate resolve the same registry and overrides. */
export const APP_ACTIONS: AppAction[] = [
  { id: 'toggle-navbar', label: 'Toggle sidebar', group: 'Window', defaultBinding: 'Mod+B', macro: true },
  { id: 'focus-explorer', label: 'Focus file explorer', group: 'Window', defaultBinding: 'Mod+Shift+E', macro: true },
  { id: 'new-workspace', label: 'Open workspace composer', group: 'Workspaces' },
  { id: 'open-settings', label: 'Open settings', group: 'Window', defaultBinding: 'Mod+,' },
  { id: 'open-prompts', label: 'Open prompt library', group: 'Window' },
  { id: 'open-routines', label: 'Open routines', group: 'Window' },
  { id: 'next-workspace', label: 'Next workspace', group: 'Workspaces', macro: true },
  { id: 'previous-workspace', label: 'Previous workspace', group: 'Workspaces', macro: true },
  { id: 'close-workspace', label: 'Close active workspace', group: 'Workspaces' },
  { id: 'split-horizontal', label: 'Split focused pane horizontally', group: 'Panes', macro: true },
  { id: 'split-vertical', label: 'Split focused pane vertically', group: 'Panes', macro: true },
  { id: 'next-pane', label: 'Focus next pane', group: 'Panes', macro: true },
  { id: 'previous-pane', label: 'Focus previous pane', group: 'Panes', macro: true },
  { id: 'close-pane', label: 'Close focused pane', group: 'Panes' },
  // Unbound by default: no key is free of a shell or agent meaning, and the
  // action is reachable from the workspace menu. Bind it under Settings.
  { id: 'tidy-layout', label: 'Tidy layout (equal pane sizes)', group: 'Panes', macro: true },
  { id: 'toggle-zoom', label: 'Maximize / restore focused pane', group: 'Panes', defaultBinding: 'Mod+Shift+Enter', macro: true },
  { id: 'jump-to-attention', label: 'Jump to pane needing attention', group: 'Panes', defaultBinding: 'Mod+Shift+J', macro: true },
  { id: 'find-in-terminal', label: 'Find in terminal', group: 'Terminal', defaultBinding: 'Mod+F' },
  { id: 'clear-input', label: 'Clear pending input line', group: 'Terminal', defaultBinding: 'Mod+Shift+Backspace' },
  // Built-in speech (SWA-38). Shift is mandatory: bare Ctrl+Space is NUL /
  // set-mark in shells and editors. Not a recipe step — it records audio.
  { id: 'dictate', label: 'Start / stop dictation (built-in speech)', group: 'Terminal', defaultBinding: 'Mod+Shift+Space' },
  { id: 'toggle-broadcast', label: 'Toggle broadcast', group: 'Broadcast', defaultBinding: 'Mod+Shift+B', macro: true },
  { id: 'select-all-broadcast', label: 'Select all broadcast panes', group: 'Broadcast', macro: true },
  { id: 'clear-broadcast', label: 'Clear broadcast group', group: 'Broadcast', macro: true },
  { id: 'save-file', label: 'Save active file', group: 'Files', defaultBinding: 'Mod+S' },
  { id: 'cycle-markdown', label: 'Cycle Markdown view', group: 'Files', defaultBinding: 'Mod+Shift+V' }
]
export const ACTION_EVENT = 'swarmterm:run-action'
export function requestAppAction(id: string): void { window.dispatchEvent(new CustomEvent(ACTION_EVENT, { detail: id })) }
