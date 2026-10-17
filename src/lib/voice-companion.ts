/**
 * Settings → Voice companion section (SWA-42): which state buzzkey is in
 * and which buttons that allows. Rust (`voice/companion/`) reports facts;
 * the decisions about what to offer live here so they are testable.
 * Serde camelCase in lockstep with `CompanionStatus` in Rust.
 */

export interface CompanionStatus {
  supported: boolean
  installed: boolean
  dir: string | null
  running: boolean
  connected: boolean
  version: string | null
  canQuit: boolean
  autostart: boolean
  whisperKeyRunning: boolean
  busy: boolean
  signingKeyIsTest: boolean
}

export interface CompanionProgress {
  phase: 'check' | 'verify' | 'download' | 'install' | 'done' | 'failed'
  file: string | null
  received: number
  total: number
}

export type CompanionAction = 'install' | 'reinstall' | 'start' | 'quit' | 'check'

export interface CompanionView {
  state: 'unsupported' | 'whisper-key' | 'not-installed' | 'stopped' | 'running' | 'connected'
  label: string
  actions: CompanionAction[]
  showAutostart: boolean
  /** Running, but buzzkey cannot be asked to quit: point at its tray. */
  quitHint: boolean
}

export function companionView(s: CompanionStatus): CompanionView {
  const none = { actions: [] as CompanionAction[], showAutostart: false, quitHint: false }
  if (!s.supported) return { ...none, state: 'unsupported', label: 'Only available on Windows' }
  // whisper-key holds the same hotkey and microphone; offering an install
  // next to it would make both fight over them.
  if (s.whisperKeyRunning) {
    return { ...none, state: 'whisper-key', label: 'whisper-key is running — quit it before using buzzkey' }
  }
  const idle = !s.busy
  if (!s.installed) {
    return { ...none, state: 'not-installed', label: 'Not installed', actions: idle ? ['install'] : [] }
  }
  if (!s.running) {
    return {
      state: 'stopped',
      label: 'Installed, not running',
      actions: idle ? ['start', 'check', 'reinstall'] : [],
      showAutostart: true,
      quitHint: false
    }
  }
  const actions: CompanionAction[] = idle ? [...(s.canQuit ? (['quit'] as const) : []), 'check'] : []
  return {
    state: s.connected ? 'connected' : 'running',
    label: s.connected
      ? `Connected — buzzkey ${s.version ?? '(version unknown)'}`
      : 'Running, not connected yet',
    actions,
    showAutostart: true,
    quitHint: !s.canQuit
  }
}

const ERRORS: Record<string, string> = {
  'signature-invalid': 'The release signature does not match Swarmterm\'s key. Nothing was installed.',
  'signing-key-invalid': 'The built-in signing key is broken. Nothing was installed.',
  'sums-invalid': 'The release checksums are malformed. Nothing was installed.',
  'no-signed-release': 'No signed buzzkey release is available yet.',
  'releases-invalid': 'GitHub answered with something that is not a release list.',
  'host-not-allowed': 'The download tried to leave GitHub and was stopped.',
  'too-large': 'A release file is larger than allowed and was not downloaded.',
  'whisper-key-running': 'whisper-key is running. Quit it first.',
  'running-quit-in-tray': 'buzzkey is running. Quit it from its tray icon, then try again.',
  'quit-timeout': 'buzzkey did not quit in time. Quit it from its tray icon, then try again.',
  'quit-unsupported': 'This buzzkey cannot be stopped from here. Quit it from its tray icon.',
  'not-installed': 'buzzkey is not installed.',
  busy: 'An install is already running.',
  unsupported: 'Only available on Windows.'
}

export function companionErrorText(reason: string): string {
  if (ERRORS[reason]) return ERRORS[reason]
  const [kind, file] = reason.split(':', 2)
  if (kind === 'hash-mismatch') return `${file} does not match the signed checksum. Nothing was installed.`
  if (kind === 'sums-missing') return `The signed checksums do not list ${file}. Nothing was installed.`
  if (kind === 'in-use') return `${file} is in use. Quit buzzkey and try again; the previous version was kept.`
  return reason
}

const mb = (n: number): string => (n / 1_048_576).toFixed(1)

export function progressText(p: CompanionProgress): string | null {
  switch (p.phase) {
    case 'check':
      return 'Looking for the newest release…'
    case 'verify':
      return 'Checking signature…'
    case 'download':
      return `Downloading ${p.file ?? ''} — ${mb(p.received)} / ${mb(p.total)} MB`
    case 'install':
      return 'Installing…'
    case 'done':
    case 'failed':
      return null
  }
}
