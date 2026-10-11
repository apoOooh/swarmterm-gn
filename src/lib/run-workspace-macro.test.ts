import {it,expect} from 'vitest'
import {runWorkspaceMacro} from './run-workspace-macro'
import type {WorkspaceMacro} from './workspace-macros'
const macro:WorkspaceMacro={id:'macro:11111111-2222-4333-8444-555555555555',name:'Squad',steps:[{type:'workspace',agentIds:['terminal'],accounts:'default'},{type:'action',actionId:'split-vertical'},{type:'workspace',agentIds:['codex'],accounts:'round-robin'}]}
it('preflights all recipes and executes actions in user order',async()=>{const calls:string[]=[];await runWorkspaceMacro(macro,{prepare:async s=>{calls.push(`prepare:${s.agentIds[0]}`);return()=>{calls.push(`create:${s.agentIds[0]}`)}},action:id=>{calls.push(id)}});expect(calls).toEqual(['prepare:terminal','prepare:codex','create:terminal','split-vertical','create:codex'])})
it('does not create a partial squad when a later recipe is unavailable',async()=>{const calls:string[]=[];await expect(runWorkspaceMacro(macro,{prepare:async s=>{if(s.agentIds[0]==='codex')throw new Error('Unavailable account');return()=>{calls.push('created')}},action:()=>{calls.push('action')}})).rejects.toThrow('Unavailable account');expect(calls).toEqual([])})
