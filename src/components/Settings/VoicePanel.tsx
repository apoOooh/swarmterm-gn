import { useEffect, useState, type ReactElement } from 'react'
import {
  cancelVoiceModel,
  deleteVoiceModel,
  downloadVoiceModel,
  getTtsStatus,
  getVoiceSettings,
  setVoiceSettings,
  voiceTtsTest,
  type TtsStatus,
  type VoiceSettings
} from '@/tauri/voice'
import { useVoiceDictationStore } from '@/store/voice-dictation-store'
import { modelSelectable } from '@/lib/voice-dictation'
import { BuzzkeySection } from './BuzzkeySection'
import { ToggleRow } from './NotificationsPanel'

/** Whisper detects the language itself; pinning it avoids misdetections on short phrases. */
const LANGUAGES: { id: string; label: string }[] = [
  { id: 'auto', label: 'Detect automatically' },
  { id: 'de', label: 'German' },
  { id: 'en', label: 'English' },
  { id: 'fr', label: 'French' },
  { id: 'es', label: 'Spanish' },
  { id: 'it', label: 'Italian' },
  { id: 'nl', label: 'Dutch' },
  { id: 'pl', label: 'Polish' }
]

const field = 'rounded border border-input bg-background px-2 py-1 text-sm'
const action = 'rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50'

const megabytes = (bytes: number): string => `${Math.round(bytes / 1_000_000)} MB`

/**
 * Settings → Voice (SWA-12). The endpoint lets a local dictation app
 * (buzzkey) type into the pane that owned the keyboard when recording
 * began. Settings live in Rust (`voice/settings.rs`), which also enforces
 * them: switching off closes the pipe and revokes open dictations.
 *
 * Built-in speech (SWA-38) records and transcribes inside Swarmterm with a
 * downloaded Whisper model and delivers through the same path.
 *
 * Spoken announcements (SWA-66) use the system's voices; Rust owns the
 * queue, the stop rules and who speaks (buzzkey only as a fallback).
 */
export function VoicePanel(): ReactElement {
  const [settings, setSettings] = useState<VoiceSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tts, setTts] = useState<TtsStatus | null>(null)
  const models = useVoiceDictationStore((s) => s.models)
  const progress = useVoiceDictationStore((s) => s.progress)
  // A model downloaded from here becomes the selection once it is on disk:
  // only downloaded models can be picked, so Download is how you choose one.
  const [pickAfterDownload, setPickAfterDownload] = useState<string | null>(null)

  useEffect(() => {
    void getVoiceSettings().then(setSettings, (e) => setError(String(e)))
    void useVoiceDictationStore.getState().refresh()
    void getTtsStatus().then(setTts, () => setTts(null))
  }, [])

  const update = (next: VoiceSettings): void => {
    setError(null)
    void setVoiceSettings(next).then((saved) => {
      setSettings(saved)
      useVoiceDictationStore.getState().setSettings(saved)
    }, (e) => setError(String(e)))
  }

  const run = (p: Promise<void>): void => {
    setError(null)
    void p.then(() => useVoiceDictationStore.getState().refresh(), (e) => setError(String(e)))
  }

  useEffect(() => {
    if (!pickAfterDownload || !settings) return
    if (!models.some((m) => m.id === pickAfterDownload && m.ready)) return
    setPickAfterDownload(null)
    if (settings.model !== pickAfterDownload) update({ ...settings, model: pickAfterDownload })
  }, [models, pickAfterDownload, settings])

  const selected = models.find((m) => m.id === settings?.model)
  const modelMissing = !!settings?.enabled && !!settings.builtinEnabled && !selected?.ready

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
              description="Only apps running as your Windows user can connect. Also required for built-in speech."
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
              description="Tells the dictation app when an agent you are not watching finishes or waits for input. Sends the status and the pane title, never pane output."
              checked={settings.announceTurns}
              onChange={(announceTurns) => update({ ...settings, announceTurns })}
            />
          </div>
        )}
      </section>

      {settings && (
        <section>
          <h2 className="text-lg font-semibold text-foreground">Spoken announcements</h2>
          <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted-foreground">
            Swarmterm says when an agent you are not watching finishes or waits for input, using a
            voice installed in Windows. Only the pane title and the status are spoken, never pane
            output. Typing, focusing that pane, dictating or Ctrl+Shift+M stops it.
          </p>
          <div className="mt-4">
            <ToggleRow
              label="Speak announcements"
              description={tts?.ready ? 'Needs "Accept dictation" on.' : `No voice available${tts?.error ? ` (${tts.error})` : ''}.`}
              checked={settings.speakTurns}
              onChange={(speakTurns) => update({ ...settings, speakTurns })}
            />
            {tts?.ready && (
              <>
                <label className="flex items-center justify-between gap-4 py-2 text-sm text-foreground">
                  Voice
                  <select
                    aria-label="Announcement voice"
                    className={field}
                    value={settings.ttsVoice}
                    onChange={(e) => update({ ...settings, ttsVoice: e.target.value })}
                  >
                    <option value="">First German voice</option>
                    {tts.voices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                </label>
                <label className="flex items-center justify-between gap-4 py-2 text-sm text-foreground">
                  Volume
                  <span className="flex items-center gap-2">
                    <input
                      type="range"
                      aria-label="Announcement volume"
                      min={0}
                      max={100}
                      step={5}
                      value={settings.ttsVolume}
                      onChange={(e) => update({ ...settings, ttsVolume: Number(e.target.value) })}
                    />
                    <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">{settings.ttsVolume}</span>
                    <button className={action} onClick={() => run(voiceTtsTest())}>Test voice</button>
                  </span>
                </label>
              </>
            )}
          </div>
        </section>
      )}

      {settings && models.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold text-foreground">Built-in speech recognition</h2>
          <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted-foreground">
            Dictate without a separate app: press Ctrl+Shift+Space (or the microphone in the pane
            header), speak, press it again. Recognition runs locally on your CPU with a Whisper
            model you download once; no audio leaves this computer.
          </p>
          <div className="mt-4">
            <ToggleRow
              label="Enable built-in speech"
              description={selected?.ready ? 'Ctrl+Shift+Space starts and stops a dictation.' : 'Download the selected model below first.'}
              checked={settings.builtinEnabled}
              onChange={(builtinEnabled) => update({ ...settings, builtinEnabled })}
            />
            <label className="flex items-center justify-between gap-4 py-2 text-sm text-foreground">
              Language
              <select
                aria-label="Dictation language"
                className={field}
                value={settings.language}
                onChange={(e) => update({ ...settings, language: e.target.value })}
              >
                {LANGUAGES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
            </label>
          </div>
          {modelMissing && (
            <p role="alert" className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
              The selected model is not downloaded, so dictation is off. Download it, or pick a downloaded model.
            </p>
          )}
          <div className="mt-2 space-y-1" role="radiogroup" aria-label="Speech model">
            {models.map((m) => {
              const received = progress[m.id]
              return (
                <div key={m.id} className="flex items-center justify-between gap-4 rounded px-1 py-1.5 hover:bg-muted/40">
                  <label
                    className={`flex min-w-0 items-center gap-2 text-sm ${modelSelectable(m, settings.model) ? 'text-foreground' : 'text-muted-foreground'}`}
                    title={modelSelectable(m, settings.model) ? undefined : 'Download this model to use it'}
                  >
                    <input
                      type="radio"
                      name="voice-model"
                      checked={settings.model === m.id}
                      disabled={!modelSelectable(m, settings.model)}
                      onChange={() => update({ ...settings, model: m.id })}
                    />
                    <span className="truncate">{m.label}</span>
                    {m.ready && <span className="text-xs text-muted-foreground">downloaded</span>}
                  </label>
                  <div className="flex shrink-0 items-center gap-2">
                    {m.downloading ? (
                      <>
                        <progress
                          className="h-1.5 w-28"
                          max={m.bytes}
                          value={received ?? 0}
                          aria-label={`Downloading ${m.label}`}
                        />
                        <span className="w-24 text-right text-xs tabular-nums text-muted-foreground">
                          {megabytes(received ?? 0)} / {megabytes(m.bytes)}
                        </span>
                        <button className={action} onClick={() => { if (pickAfterDownload === m.id) setPickAfterDownload(null); run(cancelVoiceModel(m.id)) }}>Cancel</button>
                      </>
                    ) : m.ready ? (
                      <button className={action} onClick={() => run(deleteVoiceModel(m.id))}>Delete</button>
                    ) : (
                      <button className={action} onClick={() => { setPickAfterDownload(m.id); run(downloadVoiceModel(m.id)) }}>Download</button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Models come from huggingface.co/ggerganov/whisper.cpp and are checked against a fixed
            checksum before use.
          </p>
        </section>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <BuzzkeySection />
    </div>
  )
}
