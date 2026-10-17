# ADR 0004: Reading agent output for spoken excerpts

- Status: accepted
- Date: 2026-10-17
- Issue: SWA-58 (follows SWA-41 and ADR 0003)

## Context

Since ADR 0003 Swarmterm says "Backend: fertig." for an agent the user is
not watching. The voice roadmap's next stage is an excerpt of the answer:
the first sentence or two, read on request. Until now the hook layer had
a hard rule: it never reads a transcript. `hook/mod.rs` deserialised only
lifecycle names and the session id, and `excerpt` on the status feed was
always null.

An excerpt needs the agent's final answer, and the only reliable source for
it is the agent's own session file. That rule has to be relaxed, but only as
far as necessary. Reviewed in the War Room (Claude + Codex, three rounds,
GO on plan v2.2); the decisions below are the user's.

What Claude Code 2.1.302 provides (checked in the binary):

- Every hook payload carries `prompt_id`, "a UUID correlating a user prompt
  with all subsequent events until the next prompt". Each user row in the
  transcript carries the same value as `promptId`.
- `Stop` passes `last_assistant_message`: the text blocks of the last
  assistant row, joined with "\n" and trimmed. `StopFailure` exists and
  carries `error` plus `prompt_id`.
- Esc fires no hook, so an interruption has no edge.

## Decision

1. **Opt-in, off by default.** Settings → Voice → "Allow excerpts". While it
   is off, no transcript is opened. Switching it off clears every excerpt,
   stops one being spoken, and makes reads still in flight commit nothing.
2. **The text never leaves Swarmterm.** It does not go over the pipe, MCP,
   the War Room, a Tauri event or a log. The status feed gets an opaque
   `completionId` and `hasExcerpt` (capability `excerpt-read`). A client
   asks Swarmterm to speak it with `read_excerpt`. `excerpt` stays null
   for every capability combination.
3. **The hook CLI sends ids and a fingerprint, never content.** It sends
   `prompt_id`, the session plus PTY generation, and length + SHA-256 of
   `last_assistant_message`. `transcript_path` is ignored. `HookBody`
   rejects unknown fields.
4. **One ledger decides** (`voice/completion/mod.rs`):
   - `UserPromptSubmit` opens the turn `prompt_id` for {terminal,
     generation, session}.
   - `Stop` closes it only if exactly this turn is open. A late or foreign
     Stop changes nothing.
   - `stop_hook_active` reopens the turn without an excerpt.
   - `StopFailure` marks the turn failed. If "done" was already spoken, it
     triggers exactly one correction.
   - A prompt, SessionStart/SessionEnd, respawn or kill voids the old turn
     at once.
   - The renderer's status never closes a turn. A status that arrives after
     a newer prompt goes out plain.
   - Panes whose prompt Swarmterm did not see (adopted or already running)
     get no excerpt until their next prompt.
5. **Swarmterm finds and reads the file itself** (`completion/reader.rs`):
   - The path is `<config>/projects/*/<session>.jsonl`, where `<config>` is
     the pane's account profile, `CLAUDE_CONFIG_DIR` or `~/.claude`.
   - The file is opened with `FILE_FLAG_OPEN_REPARSE_POINT`, and reparse
     points are refused.
   - The handle's final path (`GetFinalPathNameByHandleW`) must lie inside
     the canonical root, compared component by component.
   - Each attempt reads only the last 2 MiB and whole lines. The total
     budget is 200 ms, retries included.
6. **Freshness comes from `prompt_id`; the hash only matches content**
   (`completion/claude.rs`):
   - The answer is the last main-chain assistant row after the last user row
     of this `promptId`.
   - A newer human prompt in the tail refuses the read.
   - The row's text must equal the fingerprint byte for byte; otherwise
     there is no excerpt, never an older answer. Two turns with identical
     answers cannot be confused, because the anchor is the turn's id, not
     its text.
7. **Excerpt rules** (`completion/excerpt.rs`):
   - The excerpt is the first one or two sentences of prose, at most
     300 characters, cut at a word.
   - Code blocks, tables, headings, autolinks, shell lines and any sentence
     with a URL, path, file name, hash, UUID or identifier are dropped whole.
   - Nothing left means "Kein Auszug verfügbar." The spoken prefix is honest:
     "<Pane>, Auszug: …".
8. **Speaking**: Ctrl+Shift+R (claimed only while excerpts are on) reads
   the excerpt of the pane whose announcement last actually started
   playing, else of the focused pane. Ctrl+Shift+M is claimed while the
   status voice OR excerpts are on. The TTS worker re-checks ledger and
   opt-in right before it speaks. Half-duplex is unchanged.
9. **Protocol (v:1, additive)**: capabilities `turn-kinds` (`error` turns,
   `turn_update.kind`) and `excerpt-read`, negotiated and serialised per
   feed. `turn_update {seq, terminalId, kind?, completionId?, hasExcerpt?}`
   reports a late excerpt or a failure after "done".
   `read_excerpt {requestId, completionId}` is idempotent per requestId,
   allowed on a status feed, takes no begin guard and no lock across an
   await. It answers `ok`, `no-excerpt`, `stale`, `tts-busy`, `unavailable`
   or `disabled`. A feed without the new capabilities sees byte-identical
   pushes and no `error` kind.

## Consequences

- The answer of a Claude Code turn can be heard without looking. It is
  read on request only, never automatically.
- Swarmterm now holds turn state in Rust, and the hook layer is no longer
  "names only". The boundary moved from "never read" to "read only with
  opt-in, in-process, keep only the excerpt in RAM (10 min TTL)". The
  user guide's "What is read" section is the contract.
- The root check keeps Swarmterm from being pointed at files outside the
  config dir. It does NOT prove the content is genuine, since any program
  running as the same user can write the file.
- `StopFailure` is now a registered hook. A Claude Code version that does
  not know it ignores the key.
- Debug builds with `SWARMTERM_TTS_FAKE` log the spoken text, excerpts
  included. That is the one deliberate exception to "never logged", and it
  applies only to synthetic testlab transcripts.
- Codex (`notify` with `agent-turn-complete`) and OpenCode are not covered
  yet: Codex follows in a second step and is not installed over a foreign
  `notify`, OpenCode has its own card. Until then both get status only.
  `interrupted` stays out until some CLI gives a reliable edge for it.

## Alternatives

- **Trust `transcript_path` from the hook.** Rejected: it is attacker-shaped
  input on the loopback port, and it is wrong for nothing we cannot derive
  ourselves.
- **Send `last_assistant_message` from the CLI to the app.** Rejected:
  conversation text would cross the loopback port. The fingerprint gives the
  same proof without the content.
- **Watermark (file identity + size at prompt time) as the turn anchor.**
  This was the plan before `prompt_id` was found in the payload. Dropped
  because `prompt_id` is exact, needs no extra file access at prompt time,
  and survives rotation and resume without special cases.
- **Excerpt text to buzzkey.** Rejected by the user: buzzkey gets
  `hasExcerpt` + `read_excerpt`, and the text stays in one process.
- **Automatic excerpts after "fertig".** Rejected: reading answers aloud
  unasked is noise and a privacy risk next to other people.
