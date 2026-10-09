type CloseGuard = (paneIds: string[]) => boolean | Promise<boolean>
let closeGuard: CloseGuard | undefined
export function registerCloseGuard(guard: CloseGuard): () => void {
  closeGuard = guard
  return () => { if (closeGuard === guard) closeGuard = undefined }
}
export function withCloseGuard(paneIds: string[], close: () => void): void {
  const result = closeGuard?.(paneIds) ?? true
  if (typeof result === 'boolean') { if (result) close() }
  else void result.then((allowed) => { if (allowed) close() }).catch((e) => console.warn('Close was cancelled:', e))
}
