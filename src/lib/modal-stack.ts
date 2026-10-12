/**
 * Which app modal owns the keyboard. Modals stack (Settings via Ctrl+Comma
 * over a handoff dialog, the folder picker over the brief dialog); only the
 * top one may trap focus or close on Esc — otherwise the lower trap pulls
 * focus back out of the newer modal and Esc closes the wrong one.
 *
 * Modals using useModalFocus register here in open order. Modals that do not
 * (Settings, Welcome dialogs, FileDialog) are seen only as foreign
 * `aria-modal` nodes. Only one that appeared AFTER ours opened is on top:
 * the folder picker opened from Settings → Accounts sits over a Settings
 * modal that was already there, and must keep its trap and Esc.
 */
export type ModalStack = readonly number[]

export const pushModal = (stack: ModalStack, id: number): ModalStack => [...stack.filter((x) => x !== id), id]

export const removeModal = (stack: ModalStack, id: number): ModalStack => stack.filter((x) => x !== id)

export function ownsKeyboard(stack: ModalStack, id: number, foreignModalOpen: boolean): boolean {
  return !foreignModalOpen && stack.length > 0 && stack[stack.length - 1] === id
}

/** A foreign modal open now that was not yet open when ours opened. */
export function foreignModalAbove<T>(openNow: readonly T[], openAtOurOpen: ReadonlySet<T>): boolean {
  return openNow.some((n) => !openAtOurOpen.has(n))
}
