import { describe,it,expect } from 'vitest'
import { bindingConflict,bindingFromEvent,normalizeBinding,reservedBinding,resolveShortcut } from './custom-shortcuts'
import { readShortcutSettings,validateMacro } from './workspace-macros'
const ctrl = (key:string,shiftKey=false) => ({key,ctrlKey:true,metaKey:false,altKey:false,shiftKey})
describe('configurable shortcut ownership',()=>{
  it('replaces old shortcuts and shares current bindings with the terminal gate',()=>{
    const bindings={'toggle-navbar':'Mod+Shift+N'}
    expect(resolveShortcut(ctrl('b'),false,bindings)).toBeNull()
    expect(resolveShortcut(ctrl('N',true),false,bindings)).toBe('toggle-navbar')
    expect(resolveShortcut({...ctrl('N',true),altKey:true},false,bindings)).toBeNull()
    expect(resolveShortcut(ctrl('b'),false,{'toggle-navbar':''})).toBeNull()
  })
  it('detects conflicts including explicit platform modifier aliases',()=>{
    expect(bindingConflict('new-workspace','Ctrl+B',{})).toBe('toggle-navbar')
    expect(bindingConflict('new-workspace','Meta+B',{},[],true)).toBe('toggle-navbar')
    expect(bindingConflict('new-workspace','Mod+B',{'toggle-navbar':''})).toBeNull()
  })
  it('records modified keys without claiming plain text, dead keys or clipboard keys',()=>{
    expect(bindingFromEvent(ctrl('k',true),false)).toBe('Mod+Shift+K')
    expect(bindingFromEvent({...ctrl('k'),ctrlKey:false},false)).toBeNull()
    expect(bindingFromEvent(ctrl('Dead'),false)).toBeNull()
    expect(normalizeBinding('Shift+A')).toBeNull()
    expect(normalizeBinding('Ctrl+Ctrl+A')).toBeNull()
    expect(reservedBinding('Ctrl+C',false)).toBe(true)
    expect(reservedBinding('Meta+V',true)).toBe(true)
    expect(reservedBinding('Alt+F4',false)).toBe(true)
  })
  it('custom actions receive bindings and unknown storage is ignored',()=>{
    const id='macro:11111111-2222-4333-8444-555555555555'
    expect(resolveShortcut(ctrl('k'),false,{[id]:'Mod+K'},[{id}])).toBe(id)
    expect(readShortcutSettings('{')).toEqual({bindings:{},macros:[]})
    expect(readShortcutSettings(JSON.stringify({version:1,bindings:{unknown:'Mod+K'},macros:[]})).bindings).toEqual({})
  })
})
describe('workspace action recipes',()=>{
  const macro={id:'macro:11111111-2222-4333-8444-555555555555',name:'Mixed squad',steps:[{type:'workspace',agentIds:['claude-code','codex','claude-code','codex'],accounts:'round-robin'}]}
  it('accepts a mixed squad with automatic accounts but rejects shell code and unsafe app actions',()=>{
    expect(validateMacro(macro)).toBe(true)
    expect(validateMacro({...macro,steps:[{type:'shell',command:'anything'}]})).toBe(false)
    expect(validateMacro({...macro,steps:[{type:'action',actionId:'close-workspace'}]})).toBe(false)
    expect(validateMacro({...macro,steps:[{type:'workspace',agentIds:Array(13).fill('codex'),accounts:'default'}]})).toBe(false)
  })
  it('deduplicates persisted IDs and skips malformed steps',()=>{
    expect(readShortcutSettings(JSON.stringify({version:1,macros:[macro,macro,{...macro,id:'bad'}]})).macros).toHaveLength(1)
  })
})
