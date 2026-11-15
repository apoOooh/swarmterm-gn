import { useEffect, useState, type ReactElement } from 'react'
import { Button } from '@/components/ui/button'
import {
  canConfirm,
  describeTeamPackageError,
  mentionsCodex,
  type TeamPackageOp,
  type TeamPackagePreview
} from '@/lib/team-package'
import {
  getTeamPackage,
  previewTeamPackage,
  runTeamPackage,
  setTeamPackageSource,
  type TeamPackageState
} from '@/tauri/team-package'

const WRITING_OPS: { op: TeamPackageOp; label: string }[] = [
  { op: 'install', label: 'Install' },
  { op: 'update', label: 'Update' },
  { op: 'uninstall', label: 'Remove' }
]

/**
 * Team package (SWA-98): rules, skills and command guards for agent CLIs,
 * installed by the package's own install script. Every writing action shows
 * the script's --dry-run first and runs only after confirmation, with exactly
 * the files that were previewed (Rust compares the fingerprint).
 */
export function TeamPackageSection(): ReactElement {
  const [state, setState] = useState<TeamPackageState | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<TeamPackagePreview | null>(null)
  const [result, setResult] = useState<TeamPackagePreview | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    void getTeamPackage().then(
      (s) => {
        setState(s)
        setDraft(s.source ?? '')
      },
      () => setState(null)
    )
  }, [])

  const locked = state?.locked ?? null
  const hasSource = !!state?.source
  const sourceDirty = draft.trim() !== (state?.source ?? '')

  const act = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      await work()
    } catch (err) {
      setMessage(describeTeamPackageError(err).text)
    } finally {
      setBusy(false)
    }
  }

  const saveSource = (value: string | null): Promise<void> =>
    act(async () => {
      const s = await setTeamPackageSource(value)
      setState(s)
      setDraft(s.source ?? '')
      setPreview(null)
      setResult(null)
    })

  const startPreview = (op: TeamPackageOp): Promise<void> =>
    act(async () => {
      setPreview(null)
      setResult(null)
      const p = await previewTeamPackage(op)
      if (op === 'check') setResult(p)
      else setPreview(p)
    })

  const confirm = (): Promise<void> =>
    act(async () => {
      if (!preview) return
      const p = preview
      setPreview(null)
      setResult(await runTeamPackage(p.op, p.fingerprint))
    })

  const shown = preview ?? result
  return (
    <section className="rounded-xl border border-border bg-card/40 p-5 sm:p-6">
      <h2 className="text-sm font-semibold text-foreground">Team package</h2>
      <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted-foreground">
        Fetch your team&apos;s shared rules, skills and command guards for agent CLIs from a Git repository (https) or a
        local folder. Swarmterm only runs the package&apos;s own install.mjs with Node.js; what it writes is up to the
        package. Every change shows the script&apos;s --dry-run preview first and runs only after you confirm it. The
        preview already runs the package&apos;s script (asking it to change nothing), so use only sources you trust.
      </p>
      {locked && <p className="mt-3 text-xs text-amber-300">{locked}</p>}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          className="min-w-[280px] flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs"
          placeholder="https://… or C:\path\to\package"
          value={draft}
          disabled={busy || !!locked}
          aria-label="Team package source"
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button size="sm" disabled={busy || !!locked || !sourceDirty || !draft.trim()} onClick={() => void saveSource(draft)}>
          Save
        </Button>
        {hasSource && (
          <Button size="sm" variant="ghost" disabled={busy || !!locked} onClick={() => void saveSource(null)}>
            Clear
          </Button>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy || !!locked || !hasSource || sourceDirty} onClick={() => void startPreview('check')}>
          Check
        </Button>
        {WRITING_OPS.map(({ op, label }) => (
          <Button
            key={op}
            size="sm"
            variant="outline"
            disabled={busy || !!locked || !hasSource || sourceDirty}
            onClick={() => void startPreview(op)}
          >
            {label}…
          </Button>
        ))}
        {busy && <span className="self-center text-xs text-muted-foreground">Working…</span>}
      </div>

      {message && <p className="mt-3 text-xs text-amber-300">{message}</p>}

      {shown && (
        <div className="mt-4 rounded-md border border-border bg-background/60 p-3">
          <div className="text-xs text-muted-foreground">
            {preview ? `Dry run of ${shown.op}` : `Result of ${shown.op}`}
            {shown.commit ? ` · commit ${shown.commit}` : ''}
            {shown.timedOut ? ' · timed out' : shown.exitCode !== 0 ? ` · exit code ${shown.exitCode ?? '?'}` : ''}
          </div>
          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-foreground">
            {shown.output.trim() || '(no output)'}
          </pre>
          {mentionsCodex(shown.output) && (
            <p className="mt-2 text-xs text-muted-foreground">
              Codex: approve new hooks yourself in Codex with /hooks; Swarmterm never approves them for you.
            </p>
          )}
          {preview && (
            <div className="mt-3 flex gap-2">
              <Button size="sm" disabled={busy || !canConfirm(preview)} onClick={() => void confirm()}>
                Run {preview.op}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPreview(null)}>
                Cancel
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
