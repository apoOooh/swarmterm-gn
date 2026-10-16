/**
 * Shown inside the pane a dictation is pinned to while the user is still
 * speaking (SWA-40). Text plus icon, not colour alone, and announced to
 * screen readers. Stop ends the dictation and tells buzzkey to discard it;
 * buzzkey's own hotkey stays the primary way. There is deliberately no Esc
 * binding: Esc belongs to the agent CLI in the pane (interrupt).
 */
import type { ReactElement } from 'react'
import { Mic } from 'lucide-react'
import { useVoiceIndicatorStore } from '@/store/voice-indicator-store'
import { useVoiceDictationStore } from '@/store/voice-dictation-store'
import { voiceIndicatorStop } from '@/tauri/voice'

export function VoiceIndicatorPill({ terminalId }: { terminalId: string }): ReactElement | null {
  const pin = useVoiceIndicatorStore((s) => s.byTerminal[terminalId])
  // The built-in source (SWA-38) keeps its pin while whisper runs; say so
  // instead of "Listening…" once the microphone is already closed.
  const transcribing = useVoiceDictationStore(
    (s) => s.dictation.terminalId === terminalId && s.dictation.phase === 'transcribing'
  )
  if (pin === undefined) return null
  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute bottom-2 left-3 z-10 flex items-center gap-1.5 rounded-full border border-[#ef4444]/50 bg-card/95 px-2.5 py-1 text-[11px] text-muted-foreground shadow-lg"
    >
      <Mic className="h-3 w-3 shrink-0 animate-pulse text-[#ef4444]" aria-hidden />
      {transcribing ? 'Transcribing…' : 'Listening…'}
      <button
        data-no-dnd
        // Clicking must not pull DOM focus off the terminal; keyboard users
        // can still Tab to it.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => void voiceIndicatorStop(pin)}
        aria-label="Stop dictation"
        className="rounded px-1 font-medium text-[#ef4444] hover:text-foreground focus-visible:outline focus-visible:outline-1"
      >
        Stop
      </button>
    </div>
  )
}
