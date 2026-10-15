import { MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { budgetUsed, planLabel, statusLamp, type LampColor } from '@/lib/account-status'
import { dropExpiredWindows, usageAge, type AccountUsage, type UsageWindow } from '@/lib/account-usage'
import type { AccountStatus } from '@/tauri/accounts'

const LAMP: Record<LampColor, string> = {
  green: 'bg-emerald-500', yellow: 'bg-amber-400', red: 'bg-red-500', grey: 'bg-muted-foreground/40'
}

function Budget({ label, window, checkedAt }: { label: string; window: UsageWindow | null | undefined; checkedAt?: number }): React.ReactElement {
  const used = budgetUsed(window)
  const reset = window?.resetsAt ? `Resets ${new Date(window.resetsAt * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : ''
  const age = checkedAt ? `As of ${new Date(checkedAt).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}` : ''
  const tone = used === undefined ? 'bg-muted' : used > 85 ? 'bg-red-500' : used > 60 ? 'bg-amber-400' : 'bg-emerald-500'
  return <div className="w-20" title={used === undefined ? 'No usage reported yet' : [`${used}% used`, reset, age].filter(Boolean).join(' · ')}>
    <div className="flex justify-between text-[11px] text-muted-foreground"><span>{label}</span><span className="tabular-nums text-foreground">{used === undefined ? '—' : `${used}%`}</span></div>
    <div className="mt-1 h-1 rounded bg-muted"><div className={`h-1 rounded ${tone}`} style={{ width: `${used ?? 0}%` }} /></div>
  </div>
}

export interface AccountCardProps {
  agentName: string
  name: string
  status: AccountStatus | undefined
  usage: AccountUsage | undefined
  configDir?: string
  onLogin: () => void
  onRename?: () => void
  onShowFolder?: () => void
  onRemove?: () => void
}

export function AccountCard({ agentName, name, status, usage, configDir, onLogin, onRename, onShowFolder, onRemove }: AccountCardProps): React.ReactElement {
  const lamp = statusLamp(status)
  const plan = planLabel(status?.plan)
  const connected = status?.state === 'connected'
  // Usage is a sample, not a live feed: say when it is old instead of implying it is current.
  const now = Date.now()
  const age = connected && usage ? usageAge(usage.at, now) : undefined
  // Codex samples come from session logs and can be a day old: a window whose
  // reset has passed would show a long-gone number, so drop it at render too.
  const live = usage && dropExpiredWindows(usage, now)
  return <div className="flex items-center gap-3 rounded border border-border px-3 py-2" title={configDir}>
    <span role="img" aria-label={lamp.label} title={lamp.label} className={`h-2.5 w-2.5 shrink-0 rounded-full ${LAMP[lamp.color]}`} />
    <div className="min-w-0 flex-1">
      <div className="truncate text-sm"><span className="text-muted-foreground">{agentName} · </span><span className="font-medium">{name}</span></div>
      <div className="truncate text-xs text-muted-foreground">{status?.email ?? lamp.label}{age && ` · usage ${age}`}</div>
    </div>
    {plan && <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">{plan}</span>}
    {connected
      ? <><Budget label="5h" window={live?.fiveHour} checkedAt={live?.at} /><Budget label="7d" window={live?.sevenDay} checkedAt={live?.at} /></>
      : status && <Button size="sm" variant="outline" onClick={onLogin}>Log in</Button>}
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label={`${name} actions`}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onLogin}>{connected ? 'Log in again' : 'Log in'}</DropdownMenuItem>
        {onRename && <DropdownMenuItem onSelect={onRename}>Rename</DropdownMenuItem>}
        {onShowFolder && <DropdownMenuItem onSelect={onShowFolder}>Show folder</DropdownMenuItem>}
        {onRemove && <><DropdownMenuSeparator /><DropdownMenuItem onSelect={onRemove} className="text-destructive">Remove</DropdownMenuItem></>}
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
}
