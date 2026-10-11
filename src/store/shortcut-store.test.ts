import {beforeEach,afterEach,it,expect,vi} from 'vitest'
import {useShortcutStore,matchConfiguredShortcut} from './shortcut-store'
const key='swarmterm-shortcuts-v1'
let values:Record<string,string>
beforeEach(()=>{values={};vi.stubGlobal('localStorage',{getItem:(k:string)=>values[k]??null,setItem:(k:string,v:string)=>{values[k]=v}});useShortcutStore.setState({bindings:{},macros:[],error:null})})
afterEach(()=>vi.unstubAllGlobals())
it('persists replacements, rejects conflicting reset, and restores all defaults',()=>{
  const s=useShortcutStore.getState()
  expect(s.bind('toggle-navbar','Mod+Shift+K')).toBe(true)
  expect(s.bind('new-workspace','Mod+B')).toBe(true)
  s.reset('toggle-navbar')
  expect(useShortcutStore.getState().error).toContain('already assigned')
  expect(useShortcutStore.getState().bindings['toggle-navbar']).toBe('Mod+Shift+K')
  useShortcutStore.setState({bindings:{}});s.hydrate()
  expect(matchConfiguredShortcut({key:'k',ctrlKey:true,shiftKey:true,altKey:false,metaKey:false},false)).toBe('toggle-navbar')
  s.reset();expect(useShortcutStore.getState().bindings).toEqual({})
})
it('does not change live bindings when persistence fails',()=>{
  vi.stubGlobal('localStorage',{setItem:()=>{throw new Error('Quota')}})
  expect(useShortcutStore.getState().bind('new-workspace','Mod+Shift+N')).toBe(false)
  expect(useShortcutStore.getState().bindings).toEqual({})
})
it('rejects corrupt overrides before detecting conflicts with restored defaults',()=>{
  values[key]=JSON.stringify({version:1,bindings:{'toggle-navbar':'bad','new-workspace':'Mod+B'},macros:[]})
  useShortcutStore.getState().hydrate()
  expect(useShortcutStore.getState().bindings).toEqual({})
  expect(matchConfiguredShortcut({key:'b',ctrlKey:true,shiftKey:false,altKey:false,metaKey:false},false)).toBe('toggle-navbar')
})
it('keeps macro recipes only and ignores unknown actions',()=>{
  const m={id:'macro:11111111-2222-4333-8444-555555555555',name:' Squad ',steps:[{type:'workspace' as const,agentIds:['terminal'],accounts:'default' as const,startupCommand:'private'}],terminalOutput:'private'}
  expect(useShortcutStore.getState().saveMacro(m)).toBe(true)
  expect(values[key]).not.toContain('private')
  expect(useShortcutStore.getState().bind('unknown','Mod+K')).toBe(false)
})
