import { create } from 'zustand'
import {
  addEntry,
  clearAll,
  markAllRead,
  markRead,
  markTerminalRead,
  type CenterEntry,
  type CenterKind,
  type NewCenterEntry
} from '@/lib/notification-center'

/**
 * Session-only history behind the title-bar bell. Deliberately NOT persisted:
 * entries point at live terminal ids. UI state and actions only; the list
 * rules live in lib/notification-center.
 */
export interface NotificationCenterStore {
  entries: CenterEntry[]
  add: (entry: NewCenterEntry) => void
  markRead: (id: string) => void
  markTerminalRead: (terminalId: string, kinds?: readonly CenterKind[]) => void
  markAllRead: () => void
  clear: () => void
}

export const useNotificationCenterStore = create<NotificationCenterStore>((set) => ({
  entries: [],
  add: (entry) => set((s) => ({ entries: addEntry(s.entries, entry) })),
  markRead: (id) => set((s) => ({ entries: markRead(s.entries, id) })),
  markTerminalRead: (terminalId, kinds) =>
    set((s) => ({ entries: markTerminalRead(s.entries, terminalId, kinds) })),
  markAllRead: () => set((s) => ({ entries: markAllRead(s.entries) })),
  clear: () => set((s) => ({ entries: clearAll(s.entries) }))
}))
