import { useState, type ReactElement } from 'react'
import { APP_ACTIONS, requestAppAction, type BuiltinActionId } from '@/lib/app-actions'
import { bindingFromEvent } from '@/lib/custom-shortcuts'
import { isMacPlatform } from '@/lib/platform'
import { useShortcutStore } from '@/store/shortcut-store'
import type { MacroStep, WorkspaceMacro } from '@/lib/workspace-macros'
const field='rounded border border-input bg-background px-2 py-1 text-sm'
export function KeyboardShortcutsPanel(): ReactElement {
  const { bindings, macros, error, bind, reset, saveMacro, removeMacro }=useShortcutStore()
  const [recording,setRecording]=useState<string|null>(null)
  const [draft,setDraft]=useState<WorkspaceMacro|null>(null)
  const [name,setName]=useState('')
  const [steps,setSteps]=useState<MacroStep[]>([])
  const [action,setAction]=useState<BuiltinActionId>('split-horizontal')
  const [agents,setAgents]=useState('claude-code,codex,claude-code,codex')
  const [cwd,setCwd]=useState('')
  const [accounts,setAccounts]=useState<'default'|'round-robin'>('round-robin')
  const record=(id:string,label:string,defaultBinding?:string):ReactElement => <span className="flex flex-wrap items-center gap-2">
    <button aria-label={`Record shortcut for ${label}`} className={`${field} min-w-24 font-mono`} onClick={()=>setRecording(id)} onBlur={()=>{if(recording===id)setRecording(null)}} onKeyDown={e=>{
      if(recording!==id)return
      e.preventDefault();e.stopPropagation()
      if(e.key==='Escape'){setRecording(null);return}
      const b=bindingFromEvent(e,isMacPlatform());if(b&&bind(id,b))setRecording(null)
    }}>{recording===id?'Press a chord…':bindings[id]??defaultBinding??'Unassigned'}</button>
    <button aria-label={`Unbind ${label}`} className="text-xs text-muted-foreground" onClick={()=>{bind(id,'');setRecording(null)}}>Unbind</button>
    <button aria-label={`Reset ${label}`} className="text-xs text-muted-foreground" onClick={()=>{reset(id);setRecording(null)}}>Reset</button>
  </span>
  return <div className="space-y-6">
    <section><h1 className="text-2xl font-semibold">Keyboard Shortcuts</h1><p className="mt-2 text-sm text-muted-foreground">Record a modifier chord, unbind it, or restore its default. Conflicting bindings are rejected. Clipboard keys stay available to the terminal.</p></section>
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
    <button className={field} onClick={()=>reset()}>Reset all shortcuts</button>
    {[...new Set(APP_ACTIONS.map(a=>a.group))].map(group=><section key={group}><h2 className="mb-2 text-sm font-semibold">{group}</h2><div className="divide-y divide-border">{APP_ACTIONS.filter(a=>a.group===group).map(a=><div key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"><span>{a.label}</span>{record(a.id,a.label,a.defaultBinding)}</div>)}</div></section>)}
    <section className="space-y-3"><h2 className="font-semibold">Custom actions</h2><p className="text-sm text-muted-foreground">Combine app actions and workspace recipes. Empty folders use the current workspace or composer folder. Auto accounts rotate each agent independently.</p>
      {macros.map(m=><div key={m.id} className="space-y-2 rounded border border-border p-3"><div className="flex items-center justify-between gap-2"><span>{m.name} <span className="text-xs text-muted-foreground">({m.steps.length} steps)</span></span><div className="flex gap-3 text-xs"><button onClick={()=>requestAppAction(m.id)}>Run</button><button onClick={()=>{setDraft(m);setName(m.name);setSteps(m.steps)}}>Edit</button><button onClick={()=>removeMacro(m.id)}>Delete</button></div></div>{record(m.id,m.name)}</div>)}
      <div className="space-y-3 rounded border border-border p-3">
        <label className="block text-sm">Action name<input className={`${field} mt-1 block w-full`} aria-label="Custom action name" maxLength={80} value={name} onChange={e=>setName(e.target.value)}/></label>
        <ol className="space-y-1 text-sm">{steps.map((s,i)=><li key={i} className="flex justify-between gap-2"><span>{i+1}. {s.type==='action'?APP_ACTIONS.find(a=>a.id===s.actionId)?.label:`Workspace: ${s.agentIds.join(', ')} (${s.accounts})`}</span><button aria-label={`Remove step ${i+1}`} onClick={()=>setSteps(steps.filter((_,n)=>n!==i))}>Remove</button></li>)}</ol>
        <div className="flex flex-wrap gap-2"><select aria-label="App action step" className={field} value={action} onChange={e=>setAction(e.target.value as BuiltinActionId)}>{APP_ACTIONS.filter(a=>a.macro).map(a=><option value={a.id} key={a.id}>{a.label}</option>)}</select><button className={field} disabled={steps.length>=16} onClick={()=>setSteps([...steps,{type:'action',actionId:action}])}>Add action step</button></div>
        <label className="block text-sm">Workspace agents (one per pane, comma-separated)<input aria-label="Workspace recipe agents" className={`${field} mt-1 block w-full`} value={agents} onChange={e=>setAgents(e.target.value)}/></label>
        <label className="block text-sm">Folder (optional)<input aria-label="Workspace recipe folder" className={`${field} mt-1 block w-full`} value={cwd} onChange={e=>setCwd(e.target.value)}/></label>
        <div className="flex flex-wrap gap-2"><select className={field} aria-label="Workspace recipe accounts" value={accounts} onChange={e=>setAccounts(e.target.value as typeof accounts)}><option value="round-robin">Auto accounts</option><option value="default">Default accounts</option></select><button className={field} disabled={steps.length>=16} onClick={()=>setSteps([...steps,{type:'workspace',agentIds:agents.split(',').map(a=>a.trim()),cwd:cwd.trim()||undefined,accounts}])}>Add workspace step</button></div>
        <div className="flex gap-2"><button className={field} onClick={()=>{if(saveMacro({id:draft?.id??`macro:${crypto.randomUUID()}`,name:name.trim(),steps})){setDraft(null);setName('');setSteps([])}}}>{draft?'Save changes':'Save custom action'}</button>{draft&&<button className={field} onClick={()=>{setDraft(null);setName('');setSteps([])}}>Cancel edit</button>}</div>
      </div>
    </section>
    <p className="text-xs text-muted-foreground">Escape closes overlays and exits broadcast. Alt+click changes broadcast membership. These contextual gestures remain fixed.</p>
  </div>
}
