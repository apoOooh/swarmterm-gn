import { invoke } from '@tauri-apps/api/core'
export interface CatalogEntryStatus { id: string; status: 'available' | 'configured' | 'conflict' }
export interface CatalogStatus { version: number; entries: CatalogEntryStatus[] }
export const configureAccountMcp = (agentId: string, accountId: string | undefined, entryId: string, directories: string[] = []): Promise<void> =>
  invoke('configure_account_mcp', { agentId, accountId: accountId ?? null, entryId, directories })
export const inspectAccountMcp = (agentId: string, accountId?: string): Promise<CatalogStatus> =>
  invoke('inspect_account_mcp', { agentId, accountId: accountId ?? null })
