import { useEffect, useState, type ReactElement } from 'react'
import { displayState } from '@/lib/agent-state/rollup'
import { paneStatusTone } from '@/lib/pane-status-color'
import { useAgentStateStore } from '@/store/agent-state-store'
import { usePaneStatusPrefStore } from '@/store/pane-status-pref-store'

/** The yellow→orange drift is minutes long; a 5 s step is invisible per tick. */
const GRADIENT_TICK_MS = 5_000

/**
 * Agent-state frame drawn over a pane (Settings → Appearance). Its own
 * component so the gradient ticker re-renders this overlay only, never the
 * whole TerminalPane. The glow sits inside the border, so the focus and
 * broadcast frames stay readable underneath; pointer-events-none keeps it out
 * of clicks, drags and file drops.
 */
export function PaneStatusFrame({ terminalId }: { terminalId: string }): ReactElement | null {
  const enabled = usePaneStatusPrefStore((s) => s.prefs.enabled)
  const gradientMinutes = usePaneStatusPrefStore((s) => s.prefs.gradientMinutes)
  const entry = useAgentStateStore((s) => s.byId[terminalId])
  const [now, setNow] = useState(() => Date.now())

  const display = displayState(entry)
  const drifting = enabled && display === 'working' && gradientMinutes > 0
  useEffect(() => {
    if (!drifting) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), GRADIENT_TICK_MS)
    return () => window.clearInterval(id)
  }, [drifting, entry?.sinceMs])

  if (!enabled || entry === undefined) return null
  const tone = paneStatusTone(display, Math.max(0, now - entry.sinceMs), gradientMinutes)
  if (tone === null) return null
  return (
    <div
      aria-hidden
      data-pane-status={tone.tone}
      className="pointer-events-none absolute inset-0 z-10 rounded-md transition-[box-shadow] duration-500"
      style={{ boxShadow: `inset 0 0 0 1px ${tone.color}, inset 0 0 14px ${tone.color}59` }}
    />
  )
}
