import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useFileDialogStore } from '@/store/file-dialog-store'

export function FileDialog(): React.ReactElement | null {
  const dialog = useFileDialogStore((s) => s.dialog)
  const answer = useFileDialogStore((s) => s.answer)
  const [value, setValue] = useState('')
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!dialog) return
    setValue(dialog.input ?? '')
    const previous = document.activeElement as HTMLElement | null
    const timer = setTimeout(() => {
      const input = root.current?.querySelector('input')
      if (input) { input.focus(); input.select() } else root.current?.querySelector('button')?.focus()
    }, 0)
    return () => { clearTimeout(timer); if (previous?.isConnected) previous.focus() }
  }, [dialog])
  if (!dialog) return null
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onMouseDown={(e) => { if (e.target === e.currentTarget) answer(null) }}>
      <div ref={root} role="dialog" aria-modal="true" aria-labelledby="file-dialog-title" className="theme-elevated w-[420px] max-w-[90vw] rounded-lg border border-border bg-card p-4 text-foreground" onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') { e.preventDefault(); answer(null) }
        if (e.key === 'Tab') {
          const nodes = Array.from(root.current?.querySelectorAll<HTMLElement>('input, button') ?? [])
          const first = nodes[0], last = nodes[nodes.length - 1]
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
          if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
        }
      }}>
        <h2 id="file-dialog-title" className="text-sm font-semibold">{dialog.title}</h2>
        {dialog.detail && <p className="my-3 whitespace-pre-wrap break-words text-xs text-muted-foreground">{dialog.detail}</p>}
        <form onSubmit={(e) => { e.preventDefault(); const choice = dialog.choices[0]; if (choice) answer(dialog.input === undefined ? choice.value : value) }}>
          {dialog.input !== undefined && <input aria-label="Name" className="my-3 w-full rounded border border-input bg-background px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-ring" value={value} onChange={(e) => setValue(e.target.value)} />}
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="rounded px-3 py-1.5 text-xs hover:bg-accent" onClick={() => answer(null)}>Cancel</button>
            {dialog.choices.map((choice, i) => <button key={choice.value} type={i === 0 ? 'submit' : 'button'} onClick={i === 0 ? undefined : () => answer(choice.value)} className={`rounded px-3 py-1.5 text-xs ${choice.destructive ? 'bg-destructive text-destructive-foreground' : 'bg-primary text-primary-foreground'}`}>{choice.label}</button>)}
          </div>
        </form>
      </div>
    </div>, document.body)
}
