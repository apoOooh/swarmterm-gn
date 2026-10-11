import { create } from 'zustand'
import { bindingConflict, normalizeBinding, reservedBinding, resolveShortcut, type ShortcutOverrides } from '@/lib/custom-shortcuts'
import { readShortcutSettings, validateMacro, cleanMacro, type WorkspaceMacro } from '@/lib/workspace-macros'
import { isMacPlatform } from '@/lib/platform'
import type { ShortcutKeyEvent } from '@/lib/keybindings'
import { APP_ACTIONS } from '@/lib/app-actions'
const KEY = 'swarmterm-shortcuts-v1'
interface ShortcutState { bindings: ShortcutOverrides; macros: WorkspaceMacro[]; error: string | null; hydrate: () => void; bind: (id:string,binding:string) => boolean; reset: (id?:string) => void; saveMacro: (macro:WorkspaceMacro) => boolean; removeMacro: (id:string) => void }
function persist(bindings: ShortcutOverrides, macros: WorkspaceMacro[]): boolean { try { localStorage.setItem(KEY, JSON.stringify({version:1,bindings,macros})); return true } catch { return false } }
export const useShortcutStore = create<ShortcutState>((set,get) => ({
  bindings: {}, macros: [], error: null,
  hydrate: () => {
    try {
      const parsed = readShortcutSettings(localStorage.getItem(KEY)), bindings: ShortcutOverrides = {}
      for (const [id,raw] of Object.entries(parsed.bindings)) { const b = normalizeBinding(raw); if (b !== null && !reservedBinding(b,isMacPlatform())) bindings[id] = b }
      // Dropping one override restores its default, which may conflict with a
      // different override. Recheck against only the actual, sanitized state.
      let changed = true
      while (changed) { changed = false; for (const [id,b] of Object.entries(bindings)) if (bindingConflict(id,b,bindings,parsed.macros,isMacPlatform())) { delete bindings[id]; changed = true } }
      set({...parsed,bindings})
    } catch { set({error:'Could not load keyboard shortcuts.'}) }
  },
  bind: (id,raw) => {
    const s=get(), binding=normalizeBinding(raw)
    if (!APP_ACTIONS.some(a=>a.id===id) && !s.macros.some(m=>m.id===id)) {set({error:'Unknown action.'});return false}
    const conflict=binding === null ? null : bindingConflict(id,binding,s.bindings,s.macros,isMacPlatform())
    if (binding === null || reservedBinding(binding,isMacPlatform()) || conflict) { set({error: conflict ? `Already assigned to ${conflict}.` : 'Use a modifier chord; clipboard and reload shortcuts are reserved.'}); return false }
    const bindings={...s.bindings,[id]:binding}
    if (!persist(bindings,s.macros)) {set({error:'Could not save keyboard shortcuts.'});return false}
    set({bindings,error:null}); return true
  },
  reset: id => { const s=get(),bindings={...s.bindings}; if(id) {delete bindings[id];const conflict=bindingConflict(id,APP_ACTIONS.find(a=>a.id===id)?.defaultBinding??'',bindings,s.macros,isMacPlatform());if(conflict){set({error:`Default shortcut is already assigned to ${conflict}. Reset that action first.`});return}} else for(const key of Object.keys(bindings)) delete bindings[key]; if(persist(bindings,s.macros)) set({bindings,error:null});else set({error:'Could not save keyboard shortcuts.'}) },
  saveMacro: macro => { const s=get();if(!validateMacro(macro) || s.macros.length >= 24 && !s.macros.some(m=>m.id===macro.id)) {set({error:'Use a name and 1–16 valid steps (up to 24 actions).'});return false}; const macros=[...s.macros.filter(m=>m.id!==macro.id),cleanMacro(macro)];if(!persist(s.bindings,macros)){set({error:'Could not save custom action.'});return false};set({macros,error:null});return true },
  removeMacro: id => { const s=get(),macros=s.macros.filter(m=>m.id!==id),bindings={...s.bindings};delete bindings[id];if(persist(bindings,macros))set({macros,bindings,error:null});else set({error:'Could not save custom actions.'}) }
}))
export function matchConfiguredShortcut(e: ShortcutKeyEvent,isMac:boolean): string|null { const s=useShortcutStore.getState();return resolveShortcut(e,isMac,s.bindings,s.macros) }
