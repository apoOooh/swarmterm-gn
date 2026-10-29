import { invoke } from '@tauri-apps/api/core'
import { parseAdminPolicy, type AdminPolicy } from '@/lib/policy'

/** Admin policy (read once by Rust at startup; never changes while running). */
export const getAdminPolicy = async (): Promise<AdminPolicy> => parseAdminPolicy(await invoke('policy_get'))
