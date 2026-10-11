// Attach to the existing Dev app; create and clean only this script's workspaces.
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import path from 'node:path'
import { stat } from 'node:fs/promises'
const cwd=process.argv[2]
assert(cwd&&path.isAbsolute(cwd)&&(await stat(cwd)).isDirectory(),'Pass an existing isolated test folder.')
const browser=await chromium.connectOverCDP('http://127.0.0.1:9333')
const page=browser.contexts()[0].pages().find(p=>/^http:\/\/(localhost|127\.0\.0\.1):1420/.test(p.url()))
assert(page,'Dev page missing')
await page.waitForFunction(()=>window.__swarmtermDev)
const snapshot=await page.evaluate(async()=>{
  const {useAppStore}=await import('/src/store/app-store.ts')
  const {useNavbarVisibilityStore}=await import('/src/store/navbar-visibility-store.ts')
  const st=useAppStore.getState()
  return { ids:st.workspaces.map(w=>w.id),active:st.activeWorkspaceId,welcome:st.welcomeFocused,navbar:useNavbarVisibilityStore.getState().visible,raw:localStorage.getItem('swarmterm-shortcuts-v1') }
})
const savedIds=[]
try{
  const created=await page.evaluate(async cwd=>{
    const {useAppStore}=await import('/src/store/app-store.ts')
    const {useShortcutStore}=await import('/src/store/shortcut-store.ts')
    if(!useShortcutStore.getState().bind('toggle-navbar','Mod+Shift+K'))throw new Error('Cannot bind isolated test shortcut')
    useAppStore.getState().createWorkspace({cwd,terminalCount:1,agentIds:['terminal'],startupCommands:["Write-Output 'SWA10_READY'"]})
    const ws=useAppStore.getState().workspaces.at(-1)
    useAppStore.getState().renameWorkspace(ws.id,'SWA10 native shortcut check')
    return {terminalId:ws.layout.terminalId,savedId:ws.savedId}
  },cwd.replaceAll('\\','/'))
  const {terminalId}=created;savedIds.push(created.savedId)
  await page.waitForFunction(id=>window.__swarmtermDev.terminalText(id,60).includes('SWA10_READY'),terminalId)
  const toggled=await page.evaluate(async id=>{
    const {focusTerminal}=await import('/src/lib/terminal-registry.ts')
    const {useNavbarVisibilityStore}=await import('/src/store/navbar-visibility-store.ts')
    focusTerminal(id)
    const before=useNavbarVisibilityStore.getState().visible
    const event=new KeyboardEvent('keydown',{key:'K',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true})
    document.activeElement.dispatchEvent(event)
    return {before,after:useNavbarVisibilityStore.getState().visible,claimed:event.defaultPrevented}
  },terminalId)
  assert(toggled.claimed&&toggled.before!==toggled.after,'Native shortcut must be claimed and toggle sidebar')
  const macroId=`macro:${crypto.randomUUID()}`
  await page.evaluate(async({macroId,cwd})=>{
    const {useShortcutStore}=await import('/src/store/shortcut-store.ts')
    const {requestAppAction}=await import('/src/lib/app-actions.ts')
    if(!useShortcutStore.getState().saveMacro({id:macroId,name:'SWA10 native squad',steps:[{type:'workspace',agentIds:['terminal','terminal','terminal','terminal'],cwd,accounts:'round-robin'}]}))throw new Error('Cannot save test recipe')
    requestAppAction(macroId)
  },{macroId,cwd:cwd.replaceAll('\\','/')})
  await page.waitForFunction(n=>window.__swarmtermDev.workspaces().length===n,snapshot.ids.length+2)
  const squad=await page.evaluate(()=>window.__swarmtermDev.workspaces().at(-1))
  savedIds.push(squad.savedId)
  const leaves=n=>n.type==='leaf'?[n]:n.children.flatMap(leaves)
  assert.equal(leaves(squad.layout).length,4)
  assert(leaves(squad.layout).every(l=>l.agentId==='terminal'&&!l.accountId))
  await page.waitForFunction(ids=>ids.every(id=>window.__swarmtermDev.terminalText(id,40).length>0),leaves(squad.layout).map(l=>l.terminalId))
  const saved=await page.evaluate(async id=>{
    const {useShortcutStore}=await import('/src/store/shortcut-store.ts')
    useShortcutStore.setState({macros:[],bindings:{}});useShortcutStore.getState().hydrate()
    return useShortcutStore.getState().macros.find(m=>m.id===id)
  },macroId)
  assert.equal(saved.steps[0].agentIds.length,4)
  console.log('Native shortcuts and macros passed: claimed chord, sidebar action, persisted recipe, four real PTYs and clean account allocation.')
}finally{
  await page.evaluate(async ({snapshot,savedIds})=>{
    const {useAppStore}=await import('/src/store/app-store.ts')
    const {useSavedWorkspacesStore}=await import('/src/store/saved-workspaces-store.ts')
    const {useShortcutStore}=await import('/src/store/shortcut-store.ts')
    const {useNavbarVisibilityStore}=await import('/src/store/navbar-visibility-store.ts')
    for(const ws of useAppStore.getState().workspaces.filter(w=>!snapshot.ids.includes(w.id))){if(ws.savedId)useSavedWorkspacesStore.getState().forget(ws.savedId);useAppStore.getState().closeWorkspace(ws.id)}
    for(const id of savedIds)if(id)useSavedWorkspacesStore.getState().forget(id)
    if(snapshot.raw===null)localStorage.removeItem('swarmterm-shortcuts-v1');else localStorage.setItem('swarmterm-shortcuts-v1',snapshot.raw)
    useShortcutStore.setState({bindings:{},macros:[],error:null});useShortcutStore.getState().hydrate()
    useNavbarVisibilityStore.setState({visible:snapshot.navbar})
    if(snapshot.active)useAppStore.getState().setActiveWorkspace(snapshot.active)
    if(snapshot.welcome)useAppStore.getState().openWelcome()
  },{snapshot,savedIds})
  await browser.close()
}
