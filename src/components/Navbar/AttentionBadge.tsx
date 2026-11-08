import type { ReactElement } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { collectAttentionPanes } from '@/lib/attention'
import { attentionCounts } from '@/lib/pane-selectors'
import { jumpToAttention } from '@/lib/attention-jump'
import { formatStateAge, longestWaitMs } from '@/lib/state-age'
import { countRender } from '@/lib/perf-render-count'
import { cn } from '@/lib/utils'
import { useAgentStateStore } from '@/store/agent-state-store'
import { useAppStore } from '@/store/app-store'

/**
 * Cross-workspace count of panes the user should look at (blocked + done),
 * sat in the navbar header. Renders nothing when both are zero so the header
 * stays quiet in the common case. Clicking jumps like Mod+Shift+J — the ring
 * is computed once in `attention-jump.ts`, not duplicated here. The navbar is
 * a `data-focus-return` region, so focus lands on the revealed pane right
 * after the click.
 */
export function AttentionBadge(): ReactElement | null {
  countRender('AttentionBadge')
  const workspaces = useAppStore((s) => s.workspaces)
  // Only the two counts are subscribed: a pane flipping working ↔ idle (seen)
  // leaves them unchanged and no longer re-renders the badge. The longest
  // wait is read from the live store at hover time anyway.
  const { blocked, done } = useAgentStateStore(
    useShallow((s) => attentionCounts(workspaces, s.byId))
  )
  if (blocked === 0 && done === 0) return null
  return (
    <span className="flex items-center gap-1">
      {blocked > 0 && (
        <Pill
          count={blocked}
          tone="blocked"
          longest={() =>
            longestWaitMs(
              collectAttentionPanes(workspaces, useAgentStateStore.getState().byId),
              'blocked',
              Date.now()
            )
          }
        />
      )}
      {done > 0 && <Pill count={done} tone="done" />}
    </span>
  )
}

// Hex colours are the same VS Code Dark Modern brightRed / brightGreen as
// StateDot — the counter must read as "how many of those dots" at a glance.
const TONE = {
  blocked: { className: 'bg-[#F14C4C] text-white', title: 'pane(s) need your input' },
  done: { className: 'bg-[#23D18B] text-black', title: 'pane(s) finished while you were away' }
} as const

function Pill({
  count,
  tone,
  longest
}: {
  count: number
  tone: keyof typeof TONE
  /** Only the blocked pill names its longest wait — a done pane's age is not a wait. */
  longest?: () => number | undefined
}): ReactElement {
  const { className, title } = TONE[tone]
  // Same render-then-refresh-on-mouseenter pattern as StateDot: the native
  // tooltip is read when it shows, so the age is recomputed at hover time.
  // `formatStateAge(0, ms)` is the age-of-a-duration idiom — `ms` is already
  // an elapsed span, not a timestamp.
  const fullTitle = (): string => {
    const ms = longest?.()
    const tail = ms === undefined ? '' : ` (longest ${formatStateAge(0, ms)})`
    return `${count} ${title}${tail} — click or press Mod+Shift+J to jump`
  }
  return (
    <button
      type="button"
      // Focus must stay with the terminal (see CLAUDE.md "Keyboard focus").
      tabIndex={-1}
      title={fullTitle()}
      onMouseEnter={(e) => {
        e.currentTarget.title = fullTitle()
      }}
      onClick={() => jumpToAttention()}
      className={cn(
        'min-w-[18px] rounded-full px-1.5 text-[10px] font-semibold leading-4 tabular-nums',
        className
      )}
    >
      {count}
    </button>
  )
}
