import { useEffect, useState } from 'react'
import { useWarRoomStore } from '@/store/war-room-store'
import { templateById } from '@/lib/templates'
import { connectionStatus, CONNECT_GRACE_MS, type ConnectionStatus } from '@/lib/war-room-connection'

/** Connection status of a pane's War Room membership, or null when the pane
 *  is in no room. Re-renders once when the grace period of an unconnected
 *  member ends, so "waiting" turns into an error without polling. */
export function useMemberConnection(terminalId: string): ConnectionStatus | null {
  const member = useWarRoomStore((s) => {
    for (const ms of Object.values(s.membersByRoom)) {
      const m = ms.find((x) => x.terminalId === terminalId)
      if (m) return m
    }
    return undefined
  })
  const [now, setNow] = useState(() => Date.now())
  const pendingSince = member && !member.connected ? member.joinedAt : null
  useEffect(() => {
    if (pendingSince === null) return
    setNow(Date.now())
    const left = pendingSince + CONNECT_GRACE_MS - Date.now()
    if (left <= 0) return
    const t = setTimeout(() => setNow(Date.now()), left + 50)
    return () => clearTimeout(t)
  }, [pendingSince])
  if (!member) return null
  return connectionStatus({
    connected: member.connected,
    agentId: member.agentId,
    autoEnrolled: member.agentId !== null && templateById(member.agentId).mcpAutoEnrolled === true,
    joinedAt: member.joinedAt,
    now
  })
}
