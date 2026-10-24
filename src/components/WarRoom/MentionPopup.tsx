/**
 * The @-mention suggestion list under the composer caret. Mounted only while
 * a mention is being typed, so the store subscriptions below (workspaces for
 * named panes, agent state per row) cost nothing while the popup is closed —
 * and none of them change on terminal output, only on layout/state edges.
 */
import { memo, useEffect, useRef, type ReactElement } from 'react'
import { Bot, SquareTerminal, Users } from 'lucide-react'
import { useAgentStateStore } from '@/store/agent-state-store'
import type { MentionMatch } from '@/lib/war-room-mentions'
import { cn } from '@/lib/utils'

export const MENTION_LIST_ID = 'war-room-mention-list'
export const mentionOptionId = (i: number): string => `war-room-mention-opt-${i}`

const KIND_LABEL = { peer: 'War Room', agent: 'agent', shell: 'shell' } as const

function Highlight({ name, ranges }: { name: string; ranges: Array<[number, number]> }): ReactElement {
  const parts: ReactElement[] = []
  let at = 0
  ranges.forEach(([s, e], i) => {
    if (s > at) parts.push(<span key={`t${i}`}>{name.slice(at, s)}</span>)
    parts.push(
      <mark key={`m${i}`} className="bg-transparent font-semibold text-[#00b0f4]">
        {name.slice(s, e)}
      </mark>
    )
    at = e
  })
  if (at < name.length) parts.push(<span key="rest">{name.slice(at)}</span>)
  return <>{parts}</>
}

const Row = memo(function Row({
  match,
  index,
  selected,
  onPick,
  onHover
}: {
  match: MentionMatch
  index: number
  selected: boolean
  onPick: (i: number) => void
  onHover: (i: number) => void
}): ReactElement {
  const c = match.candidate
  // Agent state changes on working/idle edges only, not per output chunk.
  const state = useAgentStateStore((s) => s.byId[c.id]?.state)
  const Icon = c.kind === 'peer' ? Users : c.kind === 'agent' ? Bot : SquareTerminal
  const kind = c.agentId ?? KIND_LABEL[c.kind]
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])
  return (
    <div
      ref={ref}
      id={mentionOptionId(index)}
      role="option"
      aria-selected={selected}
      // mousedown, not click: keep focus (and the caret) in the textarea.
      onMouseDown={(e) => {
        e.preventDefault()
        onPick(index)
      }}
      onMouseMove={() => onHover(index)}
      className={cn(
        'flex cursor-pointer items-center gap-1.5 px-2 py-[3px] text-xs',
        selected ? 'bg-[#04395e] text-white' : 'text-foreground'
      )}
    >
      <Icon className="h-3 w-3 shrink-0 opacity-70" aria-hidden />
      <span className="min-w-0 truncate">
        <Highlight name={c.name} ranges={match.ranges} />
      </span>
      {c.hint !== undefined && <span className="truncate text-[10px] opacity-60">{c.hint}</span>}
      <span className="ml-auto shrink-0 pl-2 text-[10px] opacity-60">
        {kind}
        {state === 'working' || state === 'blocked' ? ` · ${state}` : state === 'idle' ? ' · idle' : ''}
      </span>
    </div>
  )
})

export function MentionPopup({
  matches,
  selected,
  left,
  bottom,
  onPick,
  onHover
}: {
  matches: MentionMatch[]
  selected: number
  left: number
  bottom: number
  onPick: (i: number) => void
  onHover: (i: number) => void
}): ReactElement {
  return (
    <div
      id={MENTION_LIST_ID}
      role="listbox"
      aria-label="Mention suggestions"
      style={{ left, bottom }}
      className="absolute z-50 max-h-48 w-56 max-w-[calc(100%-8px)] overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-lg"
    >
      {matches.length === 0 ? (
        <div className="px-2 py-[3px] text-xs text-muted-foreground">No matching pane</div>
      ) : (
        matches.map((m, i) => (
          <Row key={m.candidate.id} match={m} index={i} selected={i === selected} onPick={onPick} onHover={onHover} />
        ))
      )}
    </div>
  )
}

/**
 * Pixel position of `caret` inside a textarea, via the usual mirror-div trick:
 * copy the box/typography styles to an off-screen div, put the text up to the
 * caret in it and measure a marker span. Only called while the popup is open.
 */
export function caretOffset(el: HTMLTextAreaElement, caret: number): { left: number; top: number } {
  const cs = getComputedStyle(el)
  const div = document.createElement('div')
  for (const p of [
    'boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderLeftWidth', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight',
    'letterSpacing', 'tabSize'
  ] as const) {
    div.style[p] = cs[p]
  }
  div.style.position = 'absolute'
  div.style.visibility = 'hidden'
  div.style.whiteSpace = 'pre-wrap'
  div.style.overflowWrap = 'break-word'
  div.textContent = el.value.slice(0, caret)
  const mark = document.createElement('span')
  mark.textContent = '​'
  div.appendChild(mark)
  document.body.appendChild(div)
  const pos = { left: mark.offsetLeft, top: mark.offsetTop - el.scrollTop }
  document.body.removeChild(div)
  return pos
}
