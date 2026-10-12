import { useEffect, useRef } from 'react'
import { focusTrapTarget } from '@/lib/handoff-flow'
import { focusTerminal } from '@/lib/terminal-registry'
import { foreignModalAbove, ownsKeyboard, pushModal, removeModal, type ModalStack } from '@/lib/modal-stack'

let stack: ModalStack = []
let nextId = 1

const FOCUSABLE = 'textarea, input, select, button, [tabindex]:not([tabindex="-1"])'

/**
 * Keyboard ownership for an app modal. The pane-header click that opens a
 * modal is inside a `data-focus-return` region, so App hands focus back to the
 * xterm behind it; without this, Enter/Esc/typing reach the shell. On open the
 * first field is focused, Tab is trapped, Esc closes (captured before the
 * terminal sees it), and on close focus returns to `returnTo`'s terminal.
 * terminal-focus also stands down while an aria-modal dialog is open.
 * Only the top modal (lib/modal-stack) traps focus and handles Esc.
 */
export function useModalFocus(open: boolean, onClose: () => void, returnTo: string | undefined): React.RefObject<HTMLDivElement | null> {
  const root = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  // Read at close time: the target may change while open (handoff spawns a pane).
  const back = useRef(returnTo)
  back.current = returnTo

  useEffect(() => {
    if (!open) return
    const modalId = nextId++
    stack = pushModal(stack, modalId)
    const foreign = (): Element[] =>
      Array.from(document.querySelectorAll('[aria-modal="true"]')).filter(
        (n) => root.current !== null && !root.current.contains(n) && !n.contains(root.current) && !n.hasAttribute('data-modal-stack')
      )
    // Foreign modals already open below us (Settings under its folder picker)
    // must not count as on top. Captured after mount, before any newer modal.
    const below = new Set(foreign())
    const foreignOpen = (): boolean => foreignModalAbove(foreign(), below)
    const top = (): boolean => ownsKeyboard(stack, modalId, foreignOpen())
    const nodes = (): HTMLElement[] =>
      Array.from(root.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((n) => !n.hasAttribute('disabled'))
    const claim = (): void => {
      if (!top()) return
      if (root.current && !root.current.contains(document.activeElement)) nodes()[0]?.focus()
    }
    // After the opening click's own focus work (App defers its return-focus).
    const timer = setTimeout(claim, 0)
    const onKey = (e: KeyboardEvent): void => {
      if (!top()) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close.current()
        return
      }
      if (e.key !== 'Tab') return
      const list = nodes()
      const at = focusTrapTarget(list.length, list.indexOf(document.activeElement as HTMLElement), e.shiftKey)
      if (at !== null) {
        e.preventDefault()
        list[at]?.focus()
      }
    }
    // Focus leaving the dialog (e.g. a late return-focus to the xterm) is pulled back.
    const onFocusIn = (e: FocusEvent): void => {
      if (root.current && e.target instanceof Node && !root.current.contains(e.target)) claim()
    }
    root.current?.setAttribute('data-modal-stack', '')
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      clearTimeout(timer)
      stack = removeModal(stack, modalId)
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('focusin', onFocusIn)
      const id = back.current
      if (id) setTimeout(() => focusTerminal(id), 0)
    }
  }, [open])

  return root
}
