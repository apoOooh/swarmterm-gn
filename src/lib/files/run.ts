import { quoteForShell, type ShellFlavor } from '@/lib/agent-spawn-command'
export interface FileRun { label: string; command: string }
export function fileRun(path: string, flavor: ShellFlavor): FileRun | null {
  // Never interpolate control characters into a typed shell line. cmd expands % and ! even inside quotes.
  if (/[\r\n\x00]/.test(path) || (flavor === 'cmd' && /[%!"]/.test(path))) return null
  const name = path.replace(/\\/g, '/').split('/').pop() ?? ''
  const q = quoteForShell(path, flavor)
  if (/^(compose|docker-compose)(\.[^.]+)?\.ya?ml$/i.test(name)) return { label: 'Compose up', command: `docker compose -f ${q} up` }
  if (/^(test_.*|.*_test)\.py$/i.test(name)) return { label: 'Run tests', command: `python -m pytest ${q}` }
  if (/\.py$/i.test(name)) return { label: 'Run Python', command: `python ${q}` }
  if (/\.(js|mjs|cjs)$/i.test(name)) return { label: 'Run Node', command: `node ${q}` }
  if (/\.(csproj|fsproj)$/i.test(name)) return { label: 'Run .NET', command: `dotnet run --project ${q}` }
  if (/\.(sln|slnx)$/i.test(name)) return { label: 'Build .NET', command: `dotnet build ${q}` }
  return null
}
