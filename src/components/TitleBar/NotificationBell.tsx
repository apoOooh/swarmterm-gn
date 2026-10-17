import { useState, type ReactElement } from 'react'
import { AlertCircle, ArrowRightLeft, Bell, CalendarClock, CheckCircle2, CircleSlash, Hourglass, Mic, MessageSquareText, Power, TerminalSquare, XCircle } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { unreadCount, type CenterEntry, type CenterKind } from '@/lib/notification-center'
import { formatStateAge } from '@/lib/state-age'
import { centerEntryView } from '@/lib/notification-entry-view'
import { focusTerminal } from '@/lib/terminal-registry'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store/app-store'
import { useNotificationCenterStore } from '@/store/notification-center-store'

const KIND_ICON: Record<CenterKind, { icon: typeof Bell; className: string }> = {
  attention: { icon: AlertCircle, className: 'text-[#F14C4C]' },
  completion: { icon: CheckCircle2, className: 'text-[#23D18B]' },
  command: { icon: TerminalSquare, className: 'text-muted-foreground' },
  exit: { icon: Power, className: 'text-muted-foreground' },
  hold: { icon: Hourglass, className: 'text-[#E5C07B]' },
  handoff: { icon: ArrowRightLeft, className: 'text-[#3794FF]' },
  prompt: { icon: MessageSquareText, className: 'text-[#3794FF]' },
  routine: { icon: CalendarClock, className: 'text-[#3794FF]' },
  dictation: { icon: Mic, className: 'text-[#E5C07B]' },
  backend: { icon: AlertCircle, className: 'text-[#F14C4C]' },
  error: { icon: XCircle, className: 'text-[#F14C4C]' },
  interrupted: { icon: CircleSlash, className: 'text-muted-foreground' }
}

/**
 * Title-bar notification center: attention / finished / exit / War Room hold
 * across every workspace, newest first. Clicking an entry reveals its pane
 * (switching workspace or pulling it out of the drawer, like
 * `revealTerminal`) and marks it read. Radix menus are overlays, so native
 * preview webviews hide while it is open (lib/overlay-watch.ts).
 */
export function NotificationBell(): ReactElement {
  const entries = useNotificationCenterStore((s) => s.entries)
  const workspaces = useAppStore((s) => s.workspaces)
  const unread = unreadCount(entries)
  // Re-read the clock each time the menu opens so ages are current.
  const [now, setNow] = useState(() => Date.now())

  const open = (entry: CenterEntry, reveal: boolean): void => {
    useNotificationCenterStore.getState().markRead(entry.id)
    // Backend alerts have no pane to reveal: clicking only marks them read.
    if (!reveal) return
    useAppStore.getState().revealTerminal(entry.terminalId)
    focusTerminal(entry.terminalId)
  }

  return (
    <DropdownMenu onOpenChange={(o) => o && setNow(Date.now())}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-tauri-drag-region="false"
          aria-label={unread > 0 ? `Notifications (${unread} unread)` : 'Notifications'}
          title={unread > 0 ? `${unread} unread notification(s)` : 'Notifications'}
          className="relative mr-1 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Bell className="h-4 w-4" />
          {unread > 0 && (
            <span
              data-testid="notification-unread"
              className="absolute -right-0.5 -top-0.5 min-w-[14px] rounded-full bg-[#F14C4C] px-1 text-center text-[9px] font-semibold leading-[14px] text-white"
            >
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 max-h-[60vh] overflow-y-auto" data-testid="notification-center">
        <div className="flex items-center justify-between px-2 py-1 text-xs text-muted-foreground">
          <span className="font-semibold uppercase tracking-wide">Notifications</span>
          <span className="flex gap-2">
            <button
              type="button"
              disabled={unread === 0}
              onClick={() => useNotificationCenterStore.getState().markAllRead()}
              className="hover:text-foreground disabled:opacity-40"
            >
              Mark all read
            </button>
            <button
              type="button"
              disabled={entries.length === 0}
              onClick={() => useNotificationCenterStore.getState().clear()}
              className="hover:text-foreground disabled:opacity-40"
            >
              Clear
            </button>
          </span>
        </div>
        <DropdownMenuSeparator />
        {entries.length === 0 ? (
          <div className="px-2 py-3 text-center text-xs text-muted-foreground">No notifications</div>
        ) : (
          entries.map((entry) => {
            const view = centerEntryView(workspaces, entry)
            const { icon: Icon, className } = KIND_ICON[entry.kind]
            return (
              <DropdownMenuItem
                key={entry.id}
                disabled={view.disabled}
                onSelect={() => open(entry, view.reveal)}
                className={cn('items-start', entry.read && 'opacity-60')}
              >
                <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', className)} />
                <span className="min-w-0 flex-1">
                  <span className={cn('block truncate text-xs', !entry.read && 'font-semibold')}>{entry.title}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {view.subtitle}
                  </span>
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground">{formatStateAge(entry.at, now)}</span>
              </DropdownMenuItem>
            )
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
