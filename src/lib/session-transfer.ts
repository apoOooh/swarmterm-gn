import type { AgentEngineState } from '@/lib/agent-state/types'

/** Chosen subscription per resume row (SWA-64), keyed like the tick set.
 *  `null` = the default profile; a missing key = where the session already is. */
export type SessionTargets = Readonly<Record<string, string | null>>

export interface ResumePane { agentId: string; sessionId: string; cwd: string; accountId?: string }

/** Re-bind resume panes to their chosen subscription. A moved pane carries
 *  `fromAccountId` so the caller copies the session over before it spawns. */
export function retargetResumePanes<T extends ResumePane>(
  panes: T[],
  targets: SessionTargets,
  keyOf: (pane: T) => string
): (T & { fromAccountId?: string })[] {
  return panes.map(pane => {
    const key = keyOf(pane)
    if (!(key in targets)) return pane
    const accountId = targets[key] ?? undefined
    return accountId === pane.accountId ? pane : { ...pane, accountId, fromAccountId: pane.accountId }
  })
}

/** Why a live pane's session can't be carried to another subscription yet,
 *  or undefined when it can. The copy is taken while the old agent still
 *  runs, so mid-turn it would miss the turn being written; idle is safe. */
export function carryBlockedReason(state: AgentEngineState | undefined): string | undefined {
  if (state === 'working') return 'The agent is still working. Switch once it has finished its turn.'
  if (state === 'blocked') return 'The agent is waiting for your answer. Answer or cancel it, then switch.'
  return undefined
}

export interface MovablePane extends ResumePane { moved: boolean; fromAccountId?: string }

/** Copy every moved resume pane's session into its chosen subscription.
 *  A failed copy keeps that pane on its original subscription, so the
 *  conversation is never dropped; the failures are returned for reporting. */
export async function carryResumePanes(
  panes: MovablePane[],
  transfer: (agentId: string, sessionId: string, from: string | undefined, to: string | undefined) => Promise<boolean>
): Promise<{ panes: ResumePane[]; failed: string[] }> {
  const failed: string[] = []
  const out = await Promise.all(panes.map(async ({ moved, fromAccountId, ...pane }) => {
    if (!moved) return pane
    try {
      if (!await transfer(pane.agentId, pane.sessionId, fromAccountId, pane.accountId)) throw new Error('Session not found in the source subscription')
      return pane
    } catch (error) {
      failed.push(String(error))
      return { ...pane, accountId: fromAccountId }
    }
  }))
  return { panes: out, failed }
}
