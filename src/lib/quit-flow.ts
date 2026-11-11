import type { FileDialog } from '@/store/file-dialog-store'

/** What Quit does with the panes (SWA-57). */
export type QuitChoice = 'close' | 'keep' | 'cancel'

/**
 * The quit question. "Close all" is the first choice, so Enter in the form
 * keeps today's behaviour; the dialog focuses Cancel, so a reflexive Enter
 * right after the click quits nothing.
 */
export function keepTerminalsDialog(hosted: number): FileDialog {
  const panes = hosted === 1 ? '1 terminal runs' : `${hosted} terminals run`
  return {
    title: 'Keep terminals running?',
    detail: `${panes} in the terminal host. Keep running leaves them open in the background; the next start reattaches them. Panes outside the host close either way.`,
    choices: [
      { label: 'Close all', value: 'close' },
      { label: 'Keep running', value: 'keep' }
    ]
  }
}

/**
 * Ask only when something could survive. A failed count falls back to the
 * old behaviour (close everything) instead of blocking the quit.
 */
export async function chooseQuit(
  hostedCount: () => Promise<number>,
  ask: (dialog: FileDialog) => Promise<string | null>
): Promise<QuitChoice> {
  const hosted = await hostedCount().catch(() => 0)
  if (hosted <= 0) return 'close'
  const answer = await ask(keepTerminalsDialog(hosted))
  return answer === 'keep' ? 'keep' : answer === 'close' ? 'close' : 'cancel'
}
