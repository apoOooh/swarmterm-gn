/**
 * SWA-88 fallback pill: data-shield blocked a prompt in this pane and its
 * masked form could not be put back (the user typed here since). Copy puts
 * the masked text on the clipboard; nothing is typed into the pane. The text
 * itself is not shown — the pill says what happened, the clipboard has it.
 */
import type { ReactElement } from 'react'
import { ShieldAlert } from 'lucide-react'
import { usePromptResubmitStore } from '@/store/prompt-resubmit-store'
import { writeClipboard } from '@/tauri/clipboard'

export function ResubmitPill({ terminalId }: { terminalId: string }): ReactElement | null {
  const text = usePromptResubmitStore((s) => s.byTerminal[terminalId])
  const dismiss = usePromptResubmitStore((s) => s.dismiss)
  if (text === undefined) return null
  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute bottom-2 right-3 z-10 flex items-center gap-1.5 rounded-full border border-amber-500/50 bg-card/95 px-2.5 py-1 text-[11px] text-muted-foreground shadow-lg"
    >
      <ShieldAlert className="h-3 w-3 shrink-0 text-amber-500" aria-hidden />
      Prompt blocked by data-shield
      <button
        data-no-dnd
        // Clicking must not pull DOM focus off the terminal.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => void writeClipboard(text).then(() => dismiss(terminalId)).catch(() => {})}
        className="rounded px-1 font-medium text-amber-500 hover:text-foreground focus-visible:outline focus-visible:outline-1"
      >
        Copy masked prompt
      </button>
      <button
        data-no-dnd
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => dismiss(terminalId)}
        aria-label="Dismiss"
        className="rounded px-1 hover:text-foreground focus-visible:outline focus-visible:outline-1"
      >
        ✕
      </button>
    </div>
  )
}
