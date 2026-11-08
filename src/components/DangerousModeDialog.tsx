import { ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useModalFocus } from '@/components/ui/use-modal-focus'
import { dangerousModeWarning } from '@/lib/launch-mode-safety'

export interface PendingDangerousMode {
  agentId: string
  modeId: string
}

interface DangerousModeDialogProps {
  /** The selection waiting for confirmation; undefined = closed. */
  pending: PendingDangerousMode | undefined
  onConfirm: () => void
  onCancel: () => void
  /** Terminal that gets the keyboard back on close (pane menu); none from Settings. */
  returnTo?: string
}

/**
 * Confirms a switch into Bypass / YOLO, once per selection. Cancel is the
 * first focusable control so a reflexive Enter keeps the safe mode.
 * role="dialog" + aria-modal is what terminal-focus and overlay-watch key on,
 * and useModalFocus keeps Esc/Enter away from the pane behind it.
 */
export function DangerousModeDialog(props: DangerousModeDialogProps): React.ReactElement | null {
  const { pending, onConfirm, onCancel } = props
  const root = useModalFocus(pending !== undefined, onCancel, props.returnTo)
  const warning = pending === undefined ? undefined : dangerousModeWarning(pending.agentId, pending.modeId)
  if (warning === undefined) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onMouseDown={onCancel}>
      <div
        ref={root}
        role="dialog"
        aria-modal="true"
        aria-label={warning.title}
        className="theme-elevated flex w-[480px] max-w-[94vw] flex-col gap-3 rounded-lg border border-red-500/60 bg-card p-4 text-sm text-foreground shadow-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 font-medium text-red-500">
          <ShieldAlert aria-hidden="true" className="h-4 w-4" />
          {warning.title}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">{warning.body}</p>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" className="bg-red-600 text-white hover:bg-red-700" onClick={onConfirm}>
            Use this mode
          </Button>
        </div>
      </div>
    </div>
  )
}
