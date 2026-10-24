/**
 * The user's seat at the table: send probes, broadcasts and executes without
 * leaving the panel. Validation mirrors the server (war-room-composer.ts) so
 * the control can explain itself before a round trip; the server's own error
 * is what lands in the error line if they ever disagree.
 *
 * Shaped as one box, not a stack of fields: the textarea sits on top and a
 * toolbar (target · mode · send) sits inside the same border beneath it, so
 * the whole thing reads as a composer rather than a form. The paper plane is
 * reserved for the send button — an earlier version put it on the mode
 * toggle, where it read as "click to send".
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { ChevronDown, SendHorizontal, Users, Zap } from 'lucide-react'
import { useWarRoomStore } from '@/store/war-room-store'
import { useAppStore, selectFocusedTerminalId } from '@/store/app-store'
import { focusTerminal } from '@/lib/terminal-registry'
import {
  EVERYONE,
  composerTargets,
  reconcileTarget,
  validateComposer
} from '@/lib/war-room-composer'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { warRoomModeratorSend, type WarRoomMode } from '@/tauri/warroom'
import { memberColor } from '@/lib/war-room-identity'
import { cn } from '@/lib/utils'
import {
  acceptMention,
  activeMention,
  buildCandidates,
  matchCandidates,
  mentionKeyAction,
  namedPanes,
  tokenizeMentions,
  type ActiveMention,
  type MentionMatch
} from '@/lib/war-room-mentions'
import { MENTION_LIST_ID, MentionPopup, caretOffset, mentionOptionId } from './MentionPopup'

const MAX_ROWS = 6

/**
 * Subscribes to the workspaces only while mounted (= while a mention is being
 * typed) and publishes its matches through `out` for the composer's keydown.
 */
function MentionLayer({
  query,
  members,
  selected,
  anchor,
  out,
  onPick,
  onHover
}: {
  query: string
  members: Array<{ terminalId: string; name: string; agentId: string | null }>
  selected: number
  anchor: { left: number; bottom: number }
  out: { current: MentionMatch[] }
  onPick: (m: MentionMatch) => void
  onHover: (i: number) => void
}): ReactElement {
  const workspaces = useAppStore((s) => s.workspaces)
  const candidates = useMemo(() => buildCandidates(members, namedPanes(workspaces)), [members, workspaces])
  const matches = useMemo(() => matchCandidates(candidates, query), [candidates, query])
  // Written during render so a keydown right after the next keystroke sees
  // the list that is on screen, not the previous one.
  out.current = matches
  const index = Math.min(selected, Math.max(0, matches.length - 1))
  return (
    <MentionPopup
      matches={matches}
      selected={index}
      left={anchor.left}
      bottom={anchor.bottom}
      onPick={(i) => onPick(matches[i])}
      onHover={onHover}
    />
  )
}

const MODE_HINT: Record<WarRoomMode, string> = {
  probe: 'Probe — the message goes to the peer’s inbox and nudges them to read it.',
  execute: 'Execute — the text is pasted into one agent’s terminal and run as a prompt.'
}

export function ModeratorComposer(): ReactElement {
  const roomId = useWarRoomStore((s) => s.activeRoomId)
  const members = useWarRoomStore((s) =>
    s.activeRoomId !== null ? (s.membersByRoom[s.activeRoomId] ?? []) : []
  )
  const [text, setText] = useState('')
  const [mode, setMode] = useState<WarRoomMode>('probe')
  const [targetId, setTargetId] = useState<string>(EVERYONE)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  // `sending` (state) drives the display; this ref is the actual send guard.
  // Native key-repeat on a held Enter can dispatch a second keydown before
  // React flushes the state update from the first, so a state read in the
  // handler can still see stale `false` — the ref is written synchronously
  // and can't be stale.
  const inFlightRef = useRef(false)
  // Mention popup: `caret` follows the selection so editing mid-text works;
  // `dismissed` remembers the `@` the user closed with Esc so the popup stays
  // shut until they start a different mention.
  const [caret, setCaret] = useState(0)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [dismissed, setDismissed] = useState<number | null>(null)
  const matchesRef = useRef<MentionMatch[]>([])
  const boxRef = useRef<HTMLDivElement>(null)
  const typed = activeMention(text, caret)
  const active: ActiveMention | null = typed !== null && typed.start !== dismissed ? typed : null
  // A new query puts the highlight back on the best match; leaving the
  // dismissed mention re-arms the popup for the next `@`.
  const typedStart = typed?.start ?? null
  const typedQuery = typed?.query ?? null
  useEffect(() => {
    setDismissed((d) => (d !== null && d === typedStart ? d : null))
    setMentionIndex(0)
  }, [typedStart, typedQuery])
  // Measured only while open; the anchor is the `@`, so it holds still while
  // the query grows.
  const activeStart = active?.start ?? null
  const anchor = useMemo(() => {
    const el = areaRef.current
    const box = boxRef.current
    if (activeStart === null || el === null || box === null) return { left: 0, bottom: 0 }
    const pos = caretOffset(el, activeStart)
    const left = Math.max(0, Math.min(el.offsetLeft + pos.left, box.clientWidth - 224))
    return { left, bottom: box.clientHeight - (el.offsetTop + pos.top) + 2 }
  }, [activeStart, text])

  function syncCaret(el: HTMLTextAreaElement): void {
    setCaret(el.selectionStart === el.selectionEnd ? el.selectionStart : -1)
  }

  function pickMention(match: MentionMatch | undefined): void {
    const el = areaRef.current
    if (active === null || match === undefined || el === null) return
    const next = acceptMention(text, active, caret, match.candidate.name)
    // The first mention of a peer while the target is still the default
    // "Everyone" points the message at that peer — visibly, in the target
    // picker, so the user can still change it. Anything else (a second
    // mention, a non-member pane, an explicit target) only references.
    const firstMention = !tokenizeMentions(text.slice(0, active.start)).some((s) => s.t === 'mention')
    if (match.candidate.kind === 'peer' && firstMention && targetId === EVERYONE) {
      const row = composerTargets(members, mode).find((t) => t.id === match.candidate.id)
      if (row !== undefined && row.disabled === null) setTargetId(row.id)
    }
    setText(next.text)
    setCaret(next.caret)
    requestAnimationFrame(() => {
      el.setSelectionRange(next.caret, next.caret)
      grow()
    })
  }

  // Membership and mode both invalidate a selection; reconciling in an effect
  // (rather than at render) keeps the trigger label and the menu in step.
  useEffect(() => {
    setTargetId((current) => reconcileTarget(current, members, mode))
  }, [members, mode])

  // Selection is per-room: carrying a target across rooms would send into the
  // wrong roster (reconcileTarget would catch most, but Everyone + stale text
  // reads as aimed at the previous room).
  useEffect(() => {
    setTargetId(EVERYONE)
    setError(null)
  }, [roomId])

  const targets = composerTargets(members, mode)
  const validation = validateComposer({ text, targetId, mode, members })
  const canSend = validation.ok && !sending
  const hasConnectedMember = members.some((m) => m.connected)

  // In execute mode reconcileTarget's last resort is EVERYONE (see its own doc
  // comment: deliberately invalid, so validateComposer reports the real reason
  // rather than this component inventing a recipient). composerTargets never
  // emits an EVERYONE row for execute, so the trigger needs its own fallback
  // label; the real reason still shows under the box.
  const selected = targets.find((t) => t.id === targetId)
  const targetLabel = selected?.label ?? (mode === 'execute' ? 'No eligible agent' : 'Everyone')
  const isBroadcast = targetId === EVERYONE

  function grow(): void {
    const el = areaRef.current
    if (!el) return
    el.style.height = 'auto'
    const max = MAX_ROWS * 18
    el.style.height = `${Math.min(el.scrollHeight, max)}px`
  }

  async function send(): Promise<void> {
    if (inFlightRef.current) return
    if (roomId === null) return
    if (!validation.ok) {
      setError(validation.reason)
      return
    }
    inFlightRef.current = true
    setSending(true)
    try {
      await warRoomModeratorSend({
        roomId,
        to: targetId === EVERYONE ? null : targetId,
        content: text.trim(),
        mode
      })
      setText('')
      setError(null)
      // The textarea shrinks back only if we re-measure after the value clears.
      requestAnimationFrame(grow)
    } catch (e) {
      setError(String(e))
    } finally {
      inFlightRef.current = false
      setSending(false)
    }
  }

  const placeholder = !hasConnectedMember
    ? 'No connected agents yet — drag a pane in.'
    : mode === 'execute'
      ? `Prompt to run in ${targetLabel}’s terminal…`
      : isBroadcast
        ? 'Message the room…'
        : `Message ${targetLabel}…`

  const modeButton = (m: WarRoomMode, label: string, Icon: typeof Zap): ReactElement => (
    <button
      onClick={() => setMode(m)}
      title={MODE_HINT[m]}
      aria-pressed={mode === m}
      className={cn(
        'flex items-center gap-1 rounded-[3px] px-1.5 py-[3px] text-[11px] transition-colors',
        mode !== m && 'text-muted-foreground hover:text-foreground',
        mode === m && m === 'execute' && 'bg-[#f97316]/20 text-[#f97316]',
        mode === m && m === 'probe' && 'bg-card text-foreground shadow-sm'
      )}
    >
      <Icon className="h-3 w-3" />
      {label}
    </button>
  )

  return (
    <div className="shrink-0 border-t border-border p-1.5">
      <div
        ref={boxRef}
        className={cn(
          'relative rounded-md border bg-card transition-colors focus-within:border-[#00b0f4]',
          mode === 'execute' ? 'border-[#f97316]/50' : 'border-border'
        )}
      >
        <textarea
          ref={areaRef}
          rows={1}
          value={text}
          // Nobody can receive anything yet — disable rather than merely hint
          // via the placeholder, matching the design (spec §Composer UI).
          disabled={!hasConnectedMember}
          placeholder={placeholder}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={active !== null}
          aria-controls={active !== null ? MENTION_LIST_ID : undefined}
          aria-activedescendant={
            active !== null && matchesRef.current.length > 0 ? mentionOptionId(mentionIndex) : undefined
          }
          onChange={(e) => {
            setText(e.target.value)
            syncCaret(e.target)
            setError(null)
            grow()
          }}
          onSelect={(e) => syncCaret(e.currentTarget)}
          onKeyDown={(e) => {
            if (active !== null) {
              const action = mentionKeyAction(e.key, {
                count: matchesRef.current.length,
                index: Math.min(mentionIndex, Math.max(0, matchesRef.current.length - 1)),
                // keyCode 229 covers engines that report composition only there.
                composing: e.nativeEvent.isComposing || e.keyCode === 229,
                shift: e.shiftKey
              })
              if (action.type === 'move') {
                e.preventDefault()
                setMentionIndex(action.index)
                return
              }
              if (action.type === 'accept') {
                e.preventDefault()
                pickMention(matchesRef.current[action.index])
                return
              }
              if (action.type === 'close') {
                // Esc closes the popup only; the next Esc leaves the composer.
                e.preventDefault()
                setDismissed(active.start)
                return
              }
            }
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              // Hand the keyboard back to the terminal — the right panel owns
              // focus while it has it, so nothing else will do this for us.
              e.currentTarget.blur()
              const id = selectFocusedTerminalId(useAppStore.getState())
              if (id !== undefined) focusTerminal(id)
            }
          }}
          className="block w-full resize-none bg-transparent px-2 pb-1 pt-1.5 text-xs leading-[18px] text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
        />
        {active !== null && (
          <MentionLayer
            query={active.query}
            members={members}
            selected={mentionIndex}
            anchor={anchor}
            out={matchesRef}
            onPick={pickMention}
            onHover={setMentionIndex}
          />
        )}

        <div className="flex items-center gap-1 px-1 pb-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                title="Choose who receives this"
                className="flex min-w-0 items-center gap-1 rounded px-1.5 py-[3px] text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {isBroadcast ? (
                  <Users className="h-3 w-3 shrink-0" />
                ) : (
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: memberColor(targetId) }}
                  />
                )}
                <span className="max-w-[7rem] truncate">{targetLabel}</span>
                <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {targets.map((t) => (
                <DropdownMenuItem
                  key={t.id}
                  disabled={t.disabled !== null}
                  title={t.disabled ?? undefined}
                  onSelect={() => setTargetId(t.id)}
                >
                  {t.id === EVERYONE ? (
                    <Users className="h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: memberColor(t.id) }}
                    />
                  )}
                  <span className="truncate">{t.label}</span>
                  {t.disabled !== null && (
                    <span className="ml-auto pl-3 text-[10px] text-muted-foreground">
                      unavailable
                    </span>
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Two options on one track: unmistakably a mode, where a single
              toggling button reads as an action. */}
          <div className="flex items-center rounded bg-muted/60 p-px">
            {modeButton('probe', 'Probe', SendHorizontal)}
            {modeButton('execute', 'Execute', Zap)}
          </div>

          <button
            onClick={() => void send()}
            disabled={!canSend}
            title="Send · Enter (Shift+Enter for a new line)"
            aria-label="Send"
            className={cn(
              'ml-auto flex shrink-0 items-center justify-center rounded p-1 transition-colors',
              canSend
                ? mode === 'execute'
                  ? 'text-[#f97316] hover:bg-[#f97316]/15'
                  : 'text-[#00b0f4] hover:bg-[#00b0f4]/15'
                : 'cursor-not-allowed text-muted-foreground/40'
            )}
          >
            <SendHorizontal className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {error !== null && <div className="mt-1 px-1 text-[10px] text-[#ed4245]">{error}</div>}
      {error === null && !validation.ok && text.trim() !== '' && (
        <div className="mt-1 px-1 text-[10px] text-muted-foreground">{validation.reason}</div>
      )}
    </div>
  )
}
