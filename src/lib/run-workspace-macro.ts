import { validateMacro, type WorkspaceMacro, type MacroStep } from './workspace-macros'
export interface MacroRuntime { prepare: (step:Extract<MacroStep,{type:'workspace'}>) => Promise<()=>void>; action: (id:string) => void }
/** Preflight every recipe before changing app state; then execute steps in order. */
export async function runWorkspaceMacro(macro:WorkspaceMacro,runtime:MacroRuntime):Promise<void> {
  if(!validateMacro(macro))throw new Error('Invalid custom action.')
  const prepared = new Map<number,()=>void>()
  for(let i=0;i<macro.steps.length;i++) { const step=macro.steps[i];if(step.type==='workspace')prepared.set(i,await runtime.prepare(step)) }
  for(let i=0;i<macro.steps.length;i++){const step=macro.steps[i];if(step.type==='workspace')prepared.get(i)!();else runtime.action(step.actionId)}
}
