# ADR 0004: Reading the agent's reply

- Status: accepted
- Date: 2026-10-17
- Issue: SWA-58 (follows SWA-41 and ADR 0003)

## Context

Since ADR 0003 Swarmterm says "Backend: fertig." for an agent the user is
not watching. The next stage of the voice roadmap is a conversation: after a
turn Swarmterm should say what the agent would say to the user ("Ich habe
den Login-Test repariert, alle Tests laufen. Soll ich committen?"), and say
failed or interrupted turns in the same tone. Until now the hook layer had a
hard rule: it never reads a transcript. `hook/mod.rs` deserialised only
lifecycle names and the session id, and `excerpt` on the status feed was
always null.

A reply needs the agent's final answer, and the only reliable source for it
is the agent's own session file. That rule has to be relaxed, but only as
far as necessary. The decisions below are the user's (2026-10-17).

What Claude Code 2.1.302 provides (checked in the binary):

- Every hook payload carries `prompt_id`, "a UUID correlating a user prompt
  with all subsequent events until the next prompt". Each user row in the
  transcript carries the same value as `promptId`.
- `Stop` passes `last_assistant_message`: the text blocks of the last
  assistant row, joined with "\n" and trimmed. `StopFailure` exists and
  carries `error` plus `prompt_id`.
- `UserPromptSubmit` may return `additionalContext`, which Claude sees as
  context for that prompt.
- Esc fires no hook. The transcript gets a user row
  "[Request interrupted by user]" (or "… for tool use]").

## Decision

1. **Claude Code only, opt-in, off by default.** Settings → Voice → "Allow
   excerpts", effective only together with "Speak announcements". While it
   is off, no transcript is opened, no instruction is sent, and Swarmterm
   behaves exactly as in ADR 0003. Switching it off clears every pending
   reply, stops one being spoken, and makes reads still in flight commit
   nothing. Codex and OpenCode stay status only.
2. **The agent writes its own spoken line (`<voice>`).** With the opt-in on,
   the `UserPromptSubmit` hook answers with a fixed `additionalContext`
   (`speech_text::VOICE_INSTRUCTION`): end every answer with one line
   `<voice>…</voice>`, one or two spoken sentences in the user's language,
   first person, no code, paths or URLs, a question if a decision is needed.
   - The app decides: `POST /hook` answers `{"voice":true}` for a prompt
     edge while the opt-in is on; the hook CLI then prints exactly that fixed
     JSON. It is the one exception to "never print to stdout", and it never
     contains anything from the payload or the network.
   - The line is visible in the terminal. Hiding it would mean rewriting
     the agent's output, which Swarmterm does not do.
   - It costs a few tokens per turn, only while the opt-in is on.
3. **The line is untrusted.** It is agent output, so it goes through the
   same filter as quoted text (`completion/excerpt.rs`): sentences with
   code, a URL, path, file name, hash, UUID or identifier are dropped whole,
   at most 300 characters, cut at a word, then the TTS sanitiser.
4. **Fallback without a block: quoted, honestly labelled.** The first one or
   two prose sentences, said as "<Pane> schreibt: …". Nothing speakable left
   → the plain status from ADR 0003. Never screen text.
5. **The text never leaves Swarmterm.** Not over the pipe, MCP, the War Room,
   a Tauri event or a log. It lives in the ledger (RAM) from the read until
   it is queued, then in the TTS queue (10 s TTL). The pipe is unchanged:
   no new op, no new capability, `excerpt` stays null, and feeds get
   `done`/`needs_input` of unwatched panes only — byte-identical to before.
   Error and interrupted reach no client, old or new.
6. **The hook CLI sends ids and a fingerprint, never content.** It sends
   `prompt_id`, the session plus PTY generation, and length + SHA-256 of
   `last_assistant_message`. `transcript_path` is ignored. `HookBody`
   rejects unknown fields.
7. **One ledger decides** (`voice/completion/mod.rs`):
   - `UserPromptSubmit` opens the turn `prompt_id` for {terminal,
     generation, session}.
   - `Stop` closes it only if exactly this turn is open. A late or foreign
     Stop changes nothing. `stop_hook_active` reopens the turn.
   - `StopFailure` marks the turn failed. If its status already went out, it
     triggers exactly one correction.
   - A prompt, SessionStart/SessionEnd, respawn or kill voids the old turn.
   - The renderer's status never closes a turn; it is matched against the
     ledger once per turn. Panes whose prompt Swarmterm did not see get the
     plain status.
8. **Swarmterm finds and reads the file itself** (`completion/reader.rs`):
   - The path is `<config>/projects/*/<session>.jsonl`, where `<config>` is
     the pane's account profile, `CLAUDE_CONFIG_DIR` or `~/.claude`.
   - The file is opened with `FILE_FLAG_OPEN_REPARSE_POINT`, and reparse
     points are refused. The handle's final path must lie inside the
     canonical root, compared component by component.
   - Each attempt reads only the last 2 MiB and whole lines. The total
     budget is 200 ms, retries every 50 ms included.
9. **Freshness comes from `prompt_id`; the hash only matches content**
   (`completion/claude.rs`): the answer is the last main-chain assistant row
   after the last user row of this `promptId`; a newer human prompt in the
   tail refuses the read; the row's text must equal the fingerprint byte for
   byte, else there is no reply, never an older one.
10. **Interrupted** is proved by the transcript, not guessed: a Claude pane
    whose turn is still open when the renderer reports it idle gets one tail
    read (same root check and limits). Only if the last main-chain row of
    that turn is the Esc marker is it said as interrupted; anything else is
    the plain status as before.
11. **Speaking**: same `TtsHub` queue as the status (one per pane, TTL
    10 s), same stop rules (typing, focus change, Ctrl+Shift+M, `begin`) and
    half-duplex. A reply never interrupts what plays. The worker re-checks
    ledger and opt-in right before it speaks. There is no hotkey. With the
    opt-in on, replies, error and interrupted are also said for the pane the
    user is looking at; a bare "fertig" for that pane still is not. SAPI
    stays the engine.

## Consequences

- After a Claude turn the user hears the agent's own short answer, in the
  conversation's language, without looking.
- The hook layer is no longer "names only", and Rust holds turn state. The
  boundary moved from "never read" to "read only with opt-in, in-process,
  keep only the spoken line in RAM until it is said". The user guide's
  "What is read" section is the contract.
- The root check keeps Swarmterm from being pointed at files outside the
  config dir. It does NOT prove the content is genuine, since any program
  running as the same user can write the file.
- `StopFailure` is a registered hook. A Claude Code version that does not
  know it ignores the key.
- Release builds only: the instruction comes from the installed hook
  binary. A debug build defers to the installed app's hooks (`dev_defer.rs`),
  so it sees the instruction only once the installed app has this change.
- Debug builds with `SWARMTERM_TTS_FAKE` log the spoken text, replies
  included. That is the one deliberate exception to "never logged", and it
  applies only to synthetic testlab transcripts.
- buzzkey is no longer part of the reply path. It keeps the status kinds for
  its fallback voice and `tts_stop`; it is positioned as the optional global
  dictation app.

## Alternatives

- **Rule-based excerpt only.** Kept as the fallback; on its own it sounds
  like a quote, not an answer.
- **Local LLM (llamacpp) to summarise.** A second process sees the turn,
  adds seconds, and is a dependency not everyone has. Possible later as its
  own card, opt-in, with a time limit.
- **Cloud API to summarise.** Rejected: the turn would go to a further
  service and need a key.
- **Hide the `<voice>` line in the terminal.** Rejected: rewriting agent
  output in the pane.
- **Trust `transcript_path` from the hook.** Rejected: it is attacker-shaped
  input on the loopback port, and nothing we cannot derive ourselves.
- **Send `last_assistant_message` from the CLI to the app.** Rejected:
  conversation text would cross the loopback port.
- **Reply text or hasExcerpt + read_excerpt to buzzkey, a hotkey to read an
  excerpt on request.** The first draft did this; dropped by the user:
  replies come automatically, Swarmterm speaks them itself, old and new
  clients see no new kinds.
