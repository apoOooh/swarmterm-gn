import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { Button } from '@/components/ui/button'
import {
  companionErrorText,
  companionView,
  progressText,
  type CompanionAction,
  type CompanionStatus
} from '@/lib/voice-companion'
import {
  checkCompanionUpdate,
  getCompanionStatus,
  installCompanion,
  onCompanionProgress,
  probeCompanionHardware,
  quitCompanion,
  setCompanionAutostart,
  startCompanion,
  type HardwareProbe,
  type UpdateCheck
} from '@/tauri/voice-companion'
import { ToggleRow } from './NotificationsPanel'

/** Running/connected change outside this panel (tray, dictation); re-poll while open. */
const POLL_MS = 3000

const ACTION_LABEL: Record<CompanionAction, string> = {
  install: 'Install buzzkey',
  reinstall: 'Reinstall',
  start: 'Start',
  quit: 'Quit',
  check: 'Check for update'
}

/**
 * Settings → Voice → buzzkey (SWA-42). Installs and controls the dictation
 * app; every network access is a click here. Decisions about what to offer
 * live in `lib/voice-companion.ts`.
 */
export function BuzzkeySection(): ReactElement | null {
  const [status, setStatus] = useState<CompanionStatus | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [update, setUpdate] = useState<UpdateCheck | null>(null)
  const [probe, setProbe] = useState<HardwareProbe | null>(null)

  const refresh = useCallback(() => {
    void getCompanionStatus().then(setStatus, (e) => setError(String(e)))
  }, [])

  useEffect(() => {
    refresh()
    const timer = window.setInterval(refresh, POLL_MS)
    const unlisten = onCompanionProgress((p) => setProgress(progressText(p)))
    return () => {
      window.clearInterval(timer)
      void unlisten.then((off) => off())
    }
  }, [refresh])

  const installed = status?.installed ?? false
  useEffect(() => {
    if (installed) void probeCompanionHardware().then(setProbe, () => setProbe(null))
  }, [installed])

  if (!status) return null
  const view = companionView(status)

  const run = (action: CompanionAction): void => {
    setError(null)
    const fail = (e: unknown): void => setError(companionErrorText(String(e)))
    switch (action) {
      case 'install':
      case 'reinstall':
        setStatus({ ...status, busy: true })
        void installCompanion()
          .then((s) => {
            setStatus(s)
            setUpdate(null)
          }, fail)
          .finally(() => {
            setProgress(null)
            refresh()
          })
        return
      case 'start':
        void startCompanion().then(setStatus, fail)
        return
      case 'quit':
        void quitCompanion().then(refresh, fail)
        return
      case 'check':
        void checkCompanionUpdate().then(setUpdate, fail)
    }
  }

  return (
    <section data-testid="buzzkey-section">
      <h2 className="text-lg font-semibold text-foreground">buzzkey</h2>
      <p className="mt-1 max-w-prose text-sm leading-relaxed text-muted-foreground">
        The dictation app for Swarmterm. It stays a separate program with its own tray icon and works
        in any app; Swarmterm only installs and starts it when you click.
      </p>
      <div className="mt-3 text-sm text-foreground" data-testid="buzzkey-state" data-state={view.state}>
        {view.label}
      </div>
      {probe?.summary && (
        <div className="mt-1 text-xs text-muted-foreground">
          {probe.voiceAdvised === false
            ? `${probe.summary} — buzzkey advises keeping voice off on this machine.`
            : `${probe.summary}${probe.model ? ` — suggested model ${probe.model}` : ''}${probe.runtime ? ` (${probe.runtime})` : ''}`}
        </div>
      )}
      {view.actions.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {view.actions.map((a) => (
            <Button
              key={a}
              size="sm"
              variant={a === 'install' ? 'default' : 'outline'}
              onClick={() => run(a)}
            >
              {ACTION_LABEL[a]}
            </Button>
          ))}
          {update?.updateAvailable && view.state !== 'not-installed' && (
            <Button size="sm" onClick={() => run('reinstall')}>
              Update to {update.latestVersion}
            </Button>
          )}
        </div>
      )}
      {update && !update.updateAvailable && (
        <div className="mt-2 text-xs text-muted-foreground">
          {update.latestVersion ? `Up to date (newest signed release ${update.latestVersion}).` : 'No signed release found.'}
        </div>
      )}
      {view.quitHint && (
        <div className="mt-2 text-xs text-muted-foreground">To stop it, use Quit in buzzkey's tray menu.</div>
      )}
      {progress && <div className="mt-2 text-xs text-muted-foreground" data-testid="buzzkey-progress">{progress}</div>}
      {view.showAutostart && (
        <div className="mt-2">
          <ToggleRow
            label="Start buzzkey with Windows"
            description="The same entry as buzzkey's own tray setting."
            checked={status.autostart}
            onChange={(on) =>
              void setCompanionAutostart(on).then(setStatus, (e) => setError(companionErrorText(String(e))))
            }
          />
        </div>
      )}
      {status.signingKeyIsTest && (
        <p className="mt-2 text-xs text-amber-500">
          Development build: releases are checked against a test signing key.
        </p>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        Downloads come only from buzzkey's GitHub releases and are installed only after their signature and
        checksums match{status.dir ? ` (into ${status.dir})` : ''}. To uninstall, quit buzzkey, turn off
        autostart and delete that folder.
      </p>
      {error && <p className="mt-2 text-xs text-destructive" data-testid="buzzkey-error">{error}</p>}
    </section>
  )
}
