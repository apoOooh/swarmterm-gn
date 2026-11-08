import { type ReactElement } from 'react'
import { useDraggable } from '@dnd-kit/core'
import { X } from 'lucide-react'
import { useWarRoomStore, type WarRoomMember } from '@/store/war-room-store'
import { useTerminalActivityStore } from '@/store/terminal-activity-store'
import { releaseHeld } from '@/lib/war-room-delivery'
import { useAgentStateStore } from '@/store/agent-state-store'
import { displayState, paneDot } from '@/lib/agent-state/rollup'
import { warRoomLeave } from '@/tauri/warroom'
import { MEMBER_DRAG_PREFIX } from '@/lib/war-room-drop'
import { memberColor } from '@/lib/war-room-identity'
import { holdReasonCopy } from '@/lib/war-room-nudge'
import { cn } from '@/lib/utils'
import { ActivityDot } from '@/components/ActivityDot'
import { StateDot } from '@/components/StateDot'
import { useMemberConnection } from './useMemberConnection'
import { Avatar, jumpToTerminal } from './Avatar'

const HELD_BADGE_CLASS = 'shrink-0 rounded bg-[#f97316]/15 px-1 py-0.5 text-[10px] text-[#f97316]'

function MemberRow({ member }: { member: WarRoomMember }): ReactElement {
  const active = useTerminalActivityStore((s) => s.active[member.terminalId] ?? false)
  const agentState = useAgentStateStore((s) => s.byId[member.terminalId])
  const dot = paneDot(displayState(agentState), active)
  const reason = useWarRoomStore((s) => s.held[member.terminalId])
  const heldCount = useWarRoomStore((s) =>
    reason !== undefined ? (s.queues[member.terminalId]?.length ?? 0) : 0
  )
  const status = useMemberConnection(member.terminalId) ?? {
    kind: 'waiting' as const, label: 'waiting', reason: ''
  }
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: `${MEMBER_DRAG_PREFIX}${member.terminalId}`
  })
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      tabIndex={-1}
      onClick={() => jumpToTerminal(member.terminalId)}
      title={member.cwd}
      className={cn(
        'group flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-muted/40',
        isDragging && 'opacity-40'
      )}
    >
      <Avatar terminalId={member.terminalId} agentId={member.agentId} />
      <div className="min-w-0 flex-1">
        <div
          className="truncate text-xs font-medium"
          style={{ color: memberColor(member.terminalId) }}
        >
          {member.name}
        </div>
        <div className="truncate text-[10px] text-muted-foreground">{member.cwd}</div>
      </div>
      {member.connected ? (
        dot !== null ? (
          dot === 'activity' ? (
            <ActivityDot className="h-1.5 w-1.5" />
          ) : (
            <StateDot state={dot} sinceMs={agentState?.sinceMs} className="h-1.5 w-1.5" />
          )
        ) : (
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50"
            title="Connected, idle"
          />
        )
      ) : (
        <span
          className={cn(
            'shrink-0 rounded bg-muted px-1 py-0.5 text-[10px]',
            status.kind === 'error' ? 'text-destructive' : 'text-amber-400'
          )}
          title={status.reason}
          data-connection={status.kind}
        >
          {status.label}
        </span>
      )}
      {reason !== undefined &&
        heldCount > 0 &&
        // Only the typing and pane-busy holds are user-releasable; an agent or
        // draft hold shows the same badge but no click (see HeldDeliveryPill).
        (holdReasonCopy(reason).releasable ? (
          <button
            data-no-dnd
            onClick={(e) => {
              e.stopPropagation() // the row click would jump to the pane instead
              releaseHeld(member.terminalId, reason)
            }}
            title={holdReasonCopy(reason).title}
            className={HELD_BADGE_CLASS}
          >
            ⏸ {heldCount}
          </button>
        ) : (
          <span title={holdReasonCopy(reason).title} className={HELD_BADGE_CLASS}>
            ⏸ {heldCount}
          </span>
        ))}
      <button
        data-no-dnd
        onClick={(e) => {
          e.stopPropagation() // row click would jump to the pane being removed
          void warRoomLeave(member.terminalId)
        }}
        className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
        aria-label={`Remove ${member.name} from the War Room`}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}

export function MembersTab({ members }: { members: WarRoomMember[] }): ReactElement {
  if (members.length === 0) {
    return (
      <div className="m-2 rounded border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
        Drag terminal panes here. Their agents can then message each other, debate, and
        hand tasks over — drag a member out to revoke access.
      </div>
    )
  }
  return (
    <div className="p-1">
      {members.map((m) => (
        <MemberRow key={m.terminalId} member={m} />
      ))}
    </div>
  )
}
