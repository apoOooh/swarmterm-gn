import type { ReactElement } from 'react'
import { productName } from '@/lib/edition'
import { splitActivePolicies } from '@/lib/policy'
import { useEdition, usePolicyStore } from '@/store/policy-store'

/**
 * Settings header: the edition (docs/editions.md) and the active policies,
 * split into locks compiled into the Corp edition and the administrator's
 * registry / GPO values (read once at startup). Hidden on an unmanaged
 * standard install, so it costs nothing for everyone else.
 */
export function AdminPolicySection(): ReactElement | null {
  const policy = usePolicyStore((s) => s.policy)
  const edition = useEdition()
  if (!policy.locked && edition === 'standard') return null
  const { builtIn, admin } = splitActivePolicies(policy)
  return (
    <section
      data-testid="admin-policy"
      className="mb-6 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm"
    >
      {edition === 'corp' && (
        <div data-testid="edition">
          <h2 className="font-semibold text-foreground">{productName(edition)}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            The Corp edition has these restrictions built in. No setting or policy can lift them; the voice companion
            installer and speech model downloads are not part of this build.
          </p>
          <PolicyList lines={builtIn} />
        </div>
      )}
      {admin.length > 0 && (
        <div className={edition === 'corp' ? 'mt-4' : undefined}>
          <h2 className="font-semibold text-foreground">Managed by your administrator</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            These restrictions come from your organisation's policy and cannot be changed here. Changes to the policy
            apply after restarting Swarmterm.
          </p>
          <PolicyList lines={admin} />
        </div>
      )}
    </section>
  )
}

function PolicyList({ lines }: { lines: string[] }): ReactElement {
  return (
    <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-foreground">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  )
}
