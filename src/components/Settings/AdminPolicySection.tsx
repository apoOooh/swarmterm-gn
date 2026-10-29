import type { ReactElement } from 'react'
import { describeActivePolicies } from '@/lib/policy'
import { usePolicyStore } from '@/store/policy-store'

/**
 * Settings header listing the administrator's active policies (registry /
 * GPO, read once at startup). Hidden on an unmanaged install, so it costs
 * nothing for everyone else.
 */
export function AdminPolicySection(): ReactElement | null {
  const policy = usePolicyStore((s) => s.policy)
  if (!policy.locked) return null
  return (
    <section
      data-testid="admin-policy"
      className="mb-6 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm"
    >
      <h2 className="font-semibold text-foreground">Managed by your administrator</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        These restrictions come from your organisation's policy and cannot be changed here. Changes to the policy apply
        after restarting Swarmterm.
      </p>
      <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-foreground">
        {describeActivePolicies(policy).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </section>
  )
}
