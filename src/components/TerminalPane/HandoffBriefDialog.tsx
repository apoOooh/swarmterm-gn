import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { buildHandoffBrief, EMPTY_DRAFT, type HandoffDraft, type HandoffGit } from '@/lib/handoff-brief'
import { readTerminalText } from '@/lib/terminal-registry'
import { getChangedFiles, getCommitInfo } from '@/tauri/git'
import { writeClipboard } from '@/tauri/clipboard'
import { useHandoffStore } from '@/store/handoff-store'

interface HandoffBriefDialogProps {
  open: boolean
  onClose: () => void
  terminalId: string
  /** Source leaf for "Hand off…" (SWA-22): the new pane is split from it. */
  leafId: string
  agentName: string
  accountLabel?: string
  cwd: string
  sessionId?: string
}

/** Scrollback rows captured when the dialog opens; the brief keeps only its tail. */
const EXCERPT_CAPTURE_ROWS = 200

const FIELDS: Array<{ key: keyof HandoffDraft; label: string; placeholder: string }> = [
  { key: 'task', label: 'Task', placeholder: 'What this pane was asked to do' },
  { key: 'status', label: 'Status', placeholder: 'Where the work stands' },
  { key: 'openItems', label: 'Open items', placeholder: 'What is left, known risks' },
  { key: 'tests', label: 'Tests', placeholder: 'What was run and its result' }
]

/**
 * Editable preview of a pane's handoff brief (SWA-21). It never sends by
 * itself: Copy, or "Hand off…" which passes the text to the SWA-22 handoff
 * dialog, where a new pane is started and the brief sent only on confirmation. Git state is read once on open; a failed lookup just drops
 * the git section (non-repo folders are normal). The excerpt is captured on
 * open too but stays out of the brief unless the checkbox is ticked. Once the
 * user edits the preview directly, field edits stop overwriting it until they
 * press Regenerate — their hand edits are the more valuable text.
 * role="dialog" is what overlay-watch and terminal-focus key on.
 */
export function HandoffBriefDialog(props: HandoffBriefDialogProps): React.ReactElement | null {
  const { open, onClose, terminalId, cwd } = props
  const [draft, setDraft] = useState<HandoffDraft>(EMPTY_DRAFT)
  const [git, setGit] = useState<HandoffGit | undefined>(undefined)
  const [excerpt, setExcerpt] = useState('')
  const [withExcerpt, setWithExcerpt] = useState(false)
  const [manual, setManual] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!open) return
    setDraft(EMPTY_DRAFT)
    setManual(null)
    setWithExcerpt(false)
    setCopied(false)
    setGit(undefined)
    setExcerpt(readTerminalText(terminalId, EXCERPT_CAPTURE_ROWS))
    let alive = true
    Promise.all([getCommitInfo(cwd), getChangedFiles(cwd)])
      .then(([info, files]) => {
        if (alive) setGit({ branch: info.branch, headSha: info.headSha, ahead: info.ahead, behind: info.behind, changedFiles: files })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [open, terminalId, cwd])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const generated = useMemo(
    () =>
      buildHandoffBrief(
        { agentName: props.agentName, accountLabel: props.accountLabel, cwd, sessionId: props.sessionId, git },
        draft,
        withExcerpt ? { terminalExcerpt: excerpt } : {}
      ),
    [props.agentName, props.accountLabel, props.sessionId, cwd, git, draft, withExcerpt, excerpt]
  )

  if (!open) return null
  const text = manual ?? generated

  const copy = (): void => {
    void writeClipboard(text).then(() => setCopied(true))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Handoff brief"
        className="theme-elevated flex h-[640px] max-h-[90vh] w-[760px] max-w-[94vw] flex-col gap-2 overflow-hidden rounded-lg border border-border bg-card p-3 text-sm text-foreground shadow-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="font-medium">Handoff brief</div>
        <div className="grid grid-cols-2 gap-2">
          {FIELDS.map((f) => (
            <label key={f.key} className="flex flex-col gap-0.5 text-xs text-muted-foreground">
              {f.label}
              <textarea
                rows={2}
                value={draft[f.key]}
                placeholder={f.placeholder}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                className="resize-none rounded border border-input bg-background px-2 py-1 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
              />
            </label>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={withExcerpt} disabled={excerpt.trim() === ''} onChange={(e) => setWithExcerpt(e.target.checked)} />
          Include raw terminal excerpt (marked incomplete)
        </label>
        <textarea
          aria-label="Brief preview"
          value={text}
          spellCheck={false}
          onChange={(e) => setManual(e.target.value)}
          className="min-h-0 flex-1 resize-none rounded border border-input bg-background p-2 font-mono text-xs outline-none focus:ring-1 focus:ring-ring"
        />
        <div className="flex items-center justify-end gap-2">
          {manual !== null && <span className="mr-auto text-xs text-muted-foreground">Preview edited by hand — field changes are not applied.</span>}
          {manual !== null && <Button variant="ghost" size="sm" onClick={() => setManual(null)}>Regenerate</Button>}
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
          <Button
            variant="outline"
            size="sm"
            title="Start another agent or account in a new pane and send this brief after you confirm"
            onClick={() => {
              useHandoffStore.getState().begin({ leafId: props.leafId, terminalId, cwd, brief: text })
              onClose()
            }}
          >
            Hand off…
          </Button>
          <Button size="sm" onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
        </div>
      </div>
    </div>
  )
}
