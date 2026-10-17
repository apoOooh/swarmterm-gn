/** Keys of a terminalId-keyed map whose terminal is no longer in any layout. */
export function staleKeys(keys: Iterable<string>, live: ReadonlySet<string>): string[] {
  const stale: string[] = []
  for (const key of keys) if (!live.has(key)) stale.push(key)
  return stale
}
