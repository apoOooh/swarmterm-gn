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
