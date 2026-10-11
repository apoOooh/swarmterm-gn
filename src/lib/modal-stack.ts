/**
 * Which app modal owns the keyboard. Modals stack (Settings via Ctrl+Comma
 * over a handoff dialog, the folder picker over the brief dialog); only the
 * top one may trap focus or close on Esc — otherwise the lower trap pulls
 * focus back out of the newer modal and Esc closes the wrong one.
 *
 * Modals using useModalFocus register here in open order. Modals that do not
 * (Settings, Welcome dialogs, FileDialog) are seen only as foreign
 * `aria-modal` nodes; one that is open while ours is, was opened over it
 * (ours would have kept focus otherwise), so it counts as on top.
 */
export type ModalStack = readonly number[]

export const pushModal = (stack: ModalStack, id: number): ModalStack => [...stack.filter((x) => x !== id), id]

export const removeModal = (stack: ModalStack, id: number): ModalStack => stack.filter((x) => x !== id)

export function ownsKeyboard(stack: ModalStack, id: number, foreignModalOpen: boolean): boolean {
  return !foreignModalOpen && stack.length > 0 && stack[stack.length - 1] === id
}
