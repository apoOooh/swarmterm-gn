/**
 * Shown inside a pane whose War Room deliveries are being withheld (reasons:
 * lib/war-room-nudge.ts `HoldReason`). Only the typing and pane-busy holds
 * get a "Deliver now" (`releaseHeld`): it clears the typing signal or waives
 * the output gate once — never the agent or draft rules, which would press
 * Enter on the prompt the agent is waiting on or send the user's draft.
 */
import type { ReactElement } from 'react'
import { Swords } from 'lucide-react'
import { useWarRoomStore } from '@/store/war-room-store'
import { holdReasonCopy } from '@/lib/war-room-nudge'
import { releaseHeld } from '@/lib/war-room-delivery'

const PILL_CLASS =
  'absolute bottom-2 right-3 z-10 flex items-center gap-1.5 rounded-full border border-[#f97316]/40 bg-card/95 px-2.5 py-1 text-[11px] text-muted-foreground shadow-lg'

export function HeldDeliveryPill({ terminalId }: { terminalId: string }): ReactElement | null {
  const reason = useWarRoomStore((s) => s.held[terminalId])
  const count = useWarRoomStore((s) => s.queues[terminalId]?.length ?? 0)
  if (reason === undefined || count === 0) return null
  const { title, releasable } = holdReasonCopy(reason)
  const label = count === 1 ? '1 message waiting' : `${count} messages waiting`
  if (!releasable) {
    return (
      <div title={title} className={PILL_CLASS}>
        <Swords className="h-3 w-3 shrink-0 text-[#f97316]" />
        {label}
        <span className="text-muted-foreground/70">
          {reason === 'agent-blocked' ? 'agent needs input' : reason === 'draft' ? 'unsent draft' : 'agent working'}
        </span>
      </div>
    )
  }
  return (
    <button
      data-no-dnd
      tabIndex={-1}
      // Never pull DOM focus off the terminal the user is mid-sentence in —
      // mousedown, not click, is what would move it.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => releaseHeld(terminalId, reason)}
      title={title}
      className={`${PILL_CLASS} transition-colors hover:text-foreground`}
    >
      <Swords className="h-3 w-3 shrink-0 text-[#f97316]" />
      {label}
      <span className="font-medium text-[#f97316]">Deliver now</span>
    </button>
  )
}
