import { useEffect, useState, type ReactElement } from 'react'
import { getVoiceSettings, setVoiceSettings, type VoiceSettings } from '@/tauri/voice'
import { ToggleRow } from './NotificationsPanel'

/**
 * Settings → Voice (SWA-12). The endpoint lets a local dictation app
 * (buzzkey) type into the pane that owned the keyboard when recording
 * began. Settings live in Rust (`voice/settings.rs`), which also enforces
 * them: switching off closes the pipe and revokes open dictations.
 */
export function VoicePanel(): ReactElement {
  const [settings, setSettings] = useState<VoiceSettings | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void getVoiceSettings().then(setSettings, (e) => setError(String(e)))
  }, [])

  const update = (next: VoiceSettings): void => {
    setError(null)
    void setVoiceSettings(next).then(setSettings, (e) => setError(String(e)))
  }

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Voice</h1>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted-foreground">
          A local dictation app such as buzzkey can send what you say straight into the pane that had
          the keyboard when you started speaking — even if you click elsewhere while it transcribes.
          Text arrives as a draft; it is never sent as a command on its own.
        </p>
        {settings && (
          <div className="mt-4">
            <ToggleRow
              label="Accept dictation"
              description="Only apps running as your Windows user can connect."
              checked={settings.enabled}
              onChange={(enabled) => update({ ...settings, enabled })}
            />
            <ToggleRow
              label="Allow auto-Enter"
              description="Lets the dictation app submit the draft. Never in plain shells or while an agent is busy."
              checked={settings.allowAutoEnter}
              onChange={(allowAutoEnter) => update({ ...settings, allowAutoEnter })}
            />
            <ToggleRow
              label="Announce finished agents"
              description="Tells the dictation app when an agent you are not watching finishes or waits for input. Status only — no text from the pane."
              checked={settings.announceTurns}
              onChange={(announceTurns) => update({ ...settings, announceTurns })}
            />
          </div>
        )}
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      </section>
    </div>
  )
}
