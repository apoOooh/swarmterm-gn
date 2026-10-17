# ADR 0003: Built-in spoken announcements

- Status: accepted
- Date: 2026-10-17
- Issue: SWA-66 (buzzkey side: BUZ-4)

## Context

Since SWA-41 Swarmterm pushes "agent done / needs input" facts to a
subscribed dictation app, but nothing speaks them. The voice roadmap planned
TTS in buzzkey with sherpa-onnx and a German Piper/VITS voice. With the
built-in speech source (ADR 0002) Swarmterm can also own the voice, and
should work without buzzkey. Stage 1 is status only; excerpts of the
agent's answer are SWA-58.

Licence check (2026-10-17):

- Every German Piper/VITS voice in sherpa-onnx needs piper-phonemize, which
  links espeak-ng (GPL-3). sherpa-onnx 1.13.8 (latest) builds it in.
  Removal is k2-fsa/sherpa-onnx PR 4055 (open) and issue 3731, planned as
  2.0.0; afterwards German Piper voices need either an external phonemizer
  (still GPL) or a lexicon that does not exist yet for German.
- A separate download of the GPL part is not a way out for a linked engine.
- Supertonic-3 (character-based, no espeak) ships its weights under
  OpenRAIL-M with use restrictions, and the upstream repository is archived.
- The fork intends a clean-room MIT product later (SWA-59); a GPL engine
  would be one more thing to replace.

## Decision

1. **Engine: the system's SAPI 5 voices** through the `windows` crate
   (`ISpVoice`), behind an `Engine` trait in `voice/tts/`. No model
   download, no native dependency (same `windows` version tauri already
   uses), no licence question. Windows x64 is the only supported platform.
   German voices (Hedda) come with the German language pack; the voice is
   selectable, default = first German voice.
2. **Neural voices later, as a second engine**, once sherpa-onnx 2.x is
   released and a German pipeline is shown GPL-free with concrete artifacts
   (engine/bindings version, DLLs, model weights and their cards). Until
   then this ADR does not call any neural route MIT-compatible.
3. **One owner per event.** `voice_turn_event` builds one event; the local
   voice (`speakTurns`) and the pipe feed (`announceTurns`) consume it
   independently. Each `turn` push carries `ttsHandled`, decided under the
   TTS hub lock: true = Swarmterm says it or drops it on purpose (stale,
   recording, pane gone, engine error) and never hands it back. buzzkey's
   fallback voice speaks only `ttsHandled == false` events, opt-in. A client
   without the field (older Swarmterm) decides on its own. `ttsOwner` in the
   `subscribe` answer is UI information only; capability `tts` means
   protocol support only.
4. **Half-duplex by polling, not timers.** The worker speaks only when
   nothing records (a `begin` in flight, a live pin, the built-in
   transcription) and 500 ms have passed since a recording was last seen;
   what was queued meanwhile is dropped. `begin` holds a per-call guard
   before its first await, stops the voice and waits for silence (300 ms)
   before it answers, so a client opens its mic only on silence; if the
   voice does not stop, `begin` fails (`tts-busy`) and the mic stays closed.
5. **Queue and stop.** At most three announcements, ten seconds TTL, a newer
   fact replaces an older one for the same pane, a respawn voids the pane's.
   A stop clears the queue and bumps a generation the playing utterance polls
   (20 ms); SAPI is then purged synchronously. Measured stop latency to
   silence: 120–145 ms (budget 150 ms). Triggers: typing (leading edge,
   throttled), focusing the announced pane, Ctrl+Shift+M, any `begin`.

## Consequences

- Works out of the box on German Windows; quality is the classic SAPI
  voice, fine for two-word status lines, not for reading answers aloud.
- The neural engine question moves to SWA-58 (excerpts), where quality
  matters, and waits for sherpa-onnx 2.x.
- Debug builds replace the engine with `SWARMTERM_TTS_FAKE=<file>` (JSON
  lines with text, start/end, cancelled) for the testlab; a hardware smoke
  test is `cargo test sapi -- --ignored`.

## Alternatives

- **sherpa-onnx + Piper thorsten now**: best German voice, but GPL through
  espeak-ng; rejected for licence.
- **sherpa-onnx + Supertonic**: no espeak, but OpenRAIL-M weights, archived
  upstream and sherpa built without piper — a large spike for a status line.
- **WinRT `SpeechSynthesizer`**: OneCore voices, but returns a stream we
  would have to play and stop ourselves; SAPI's own playback and purge give
  the stop guarantee directly.
- **TTS only in buzzkey** (original roadmap): Swarmterm would not speak
  without buzzkey, and two engines would need coordinating anyway.
