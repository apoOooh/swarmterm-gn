import { useRef, useState, type ReactElement, type SetStateAction } from 'react'
import { Copy, Folder, FolderSearch, Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AgentCountEditor } from '@/components/Welcome/AgentCountEditor'
import { TEMPLATES, isTemplateAvailable, templateById } from '@/lib/templates'
import { presetSummary, type WorkspacePreset, type WorkspacePresetTemplate } from '@/lib/workspace-presets'
import type { AccountSelection } from '@/lib/agent-accounts'
import { useWorkspacePresetsStore } from '@/store/workspace-presets-store'
import { useAgentAvailabilityStore } from '@/store/agent-availability-store'
import { useAgentPrefStore } from '@/store/agent-pref-store'
import { pickFolder } from '@/store/folder-picker-store'

function resolve<T>(next: SetStateAction<T>, prev: T): T {
  return typeof next === 'function' ? (next as (p: T) => T)(prev) : next
}

/** Every composer choice, as a form over one preset value. */
function PresetEditor({ value, onChange }: { value: WorkspacePreset; onChange: (next: WorkspacePreset) => void }): ReactElement {
  const availability = useAgentAvailabilityStore((s) => s.availability)
  const globalSplitAgent = useAgentPrefStore((s) => s.defaultAgentId)
  // The count editor clamps agent counts right after changing the terminal
  // count, within one event — chain every update off the latest emitted value,
  // not this render's.
  const latest = useRef(value)
  latest.current = value
  const emit = (next: WorkspacePreset): void => {
    latest.current = next
    onChange(next)
  }
  const patch = (p: Partial<WorkspacePreset>): void => emit({ ...latest.current, ...p })

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">Working folder</label>
        <div className="flex items-center gap-2 rounded-lg border border-input bg-background px-3 py-2 focus-within:ring-1 focus-within:ring-ring">
          <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            value={value.folder}
            onChange={(e) => patch({ folder: e.target.value })}
            placeholder="Home directory"
            spellCheck={false}
            aria-label="Working folder"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void pickFolder(value.folder).then((picked) => { if (picked) patch({ folder: picked }) })}
          >
            <FolderSearch className="h-4 w-4" />
            Browse
          </Button>
        </div>
      </div>

      <AgentCountEditor
        terminalCount={value.terminalCount}
        setTerminalCount={(n) => patch({ terminalCount: n })}
        counts={value.agentCounts}
        setCounts={(next) => patch({ agentCounts: resolve(next, latest.current.agentCounts) })}
        accountSelections={value.accountSelections}
        setAccountSelections={(next) =>
          patch({ accountSelections: resolve<Record<string, AccountSelection>>(next, latest.current.accountSelections) })}
      />

      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          checked={value.isolateWorktrees}
          onChange={(e) => patch({ isolateWorktrees: e.target.checked })}
          className="mt-0.5 accent-current"
        />
        <span>
          <span className="block text-sm font-medium text-foreground">Isolate features in git worktrees</span>
          <span className="block text-xs text-muted-foreground">Each agent pane starts in its own worktree and branch.</span>
        </span>
      </label>

      <label className="flex items-center justify-between gap-3">
        <span>
          <span className="block text-sm font-medium text-foreground">Split opens</span>
          <span className="block text-xs text-muted-foreground">What a new split pane starts with.</span>
        </span>
        <select
          value={value.splitAgent}
          onChange={(e) => patch({ splitAgent: e.target.value })}
          className="h-8 rounded-md border border-pane-border bg-card px-2 text-sm text-foreground"
        >
          <option value="">Settings default ({templateById(globalSplitAgent).name})</option>
          {TEMPLATES.filter((t) => isTemplateAvailable(t, availability) || t.id === value.splitAgent).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {isTemplateAvailable(t, availability) ? '' : ' (not installed)'}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}

interface Draft {
  /** null ⇒ a new template. */
  id: string | null
  name: string
  preset: WorkspacePreset
}

function TemplateEditor({ draft, onCancel }: { draft: Draft; onCancel: () => void }): ReactElement {
  const [name, setName] = useState(draft.name)
  const [preset, setPreset] = useState(draft.preset)
  const save = (): void => {
    const store = useWorkspacePresetsStore.getState()
    if (draft.id === null) store.addTemplate(name, preset)
    else store.updateTemplate(draft.id, name, preset)
    onCancel()
  }
  return (
    <div className="space-y-4 rounded-lg border border-border bg-card p-4">
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-foreground">Name</span>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onCancel() } }}
          aria-label="Template name"
          spellCheck={false}
          className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus:ring-1 focus:ring-ring"
        />
      </label>
      <PresetEditor value={preset} onChange={setPreset} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button size="sm" onClick={save} disabled={name.trim() === ''}>Save template</Button>
      </div>
    </div>
  )
}

function TemplateRow({ template, onEdit }: { template: WorkspacePresetTemplate; onEdit: () => void }): ReactElement {
  const [confirming, setConfirming] = useState(false)
  const store = useWorkspacePresetsStore.getState()
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{template.name}</div>
        <div className="truncate text-xs text-muted-foreground">
          {presetSummary(template, (id) => templateById(id).name)}
          {template.folder !== '' && ` · ${template.folder}`}
        </div>
      </div>
      {confirming ? (
        <>
          <span className="text-xs text-muted-foreground">Delete?</span>
          <Button variant="destructive" size="sm" onClick={() => store.removeTemplate(template.id)}>Delete</Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>Cancel</Button>
        </>
      ) : (
        <>
          <Button variant="ghost" size="icon-sm" aria-label={`Edit ${template.name}`} title="Edit" onClick={onEdit}>
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Duplicate ${template.name}`}
            title="Duplicate"
            onClick={() => store.addTemplate(`${template.name} copy`, template)}
          >
            <Copy className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={`Delete ${template.name}`} title="Delete" onClick={() => setConfirming(true)}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </>
      )}
    </div>
  )
}

/** Settings → Workspaces: defaults for the new-workspace composer, and named templates. */
export function WorkspacesPanel(): ReactElement {
  const defaults = useWorkspacePresetsStore((s) => s.defaults)
  const templates = useWorkspacePresetsStore((s) => s.templates)
  const [draft, setDraft] = useState<Draft | null>(null)

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Workspaces</h1>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted-foreground">
          What a new workspace starts with, and templates you can pick when creating one.
        </p>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Defaults</h2>
          <Button variant="ghost" size="sm" onClick={() => useWorkspacePresetsStore.getState().resetDefaults()}>
            Reset to built-in
          </Button>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <PresetEditor value={defaults} onChange={(next) => useWorkspacePresetsStore.getState().setDefaults(next)} />
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Templates</h2>
          {draft === null && (
            <Button variant="outline" size="sm" onClick={() => setDraft({ id: null, name: 'New template', preset: defaults })}>
              <Plus className="h-4 w-4" />
              Add template
            </Button>
          )}
        </div>
        <div className="space-y-2">
          {draft !== null && draft.id === null && <TemplateEditor draft={draft} onCancel={() => setDraft(null)} />}
          {templates.length === 0 && draft === null && (
            <p className="text-sm text-muted-foreground">
              No templates yet. Add one here, or use “Save as template…” when creating a workspace.
            </p>
          )}
          {templates.map((t) =>
            draft?.id === t.id ? (
              <TemplateEditor key={t.id} draft={draft} onCancel={() => setDraft(null)} />
            ) : (
              <TemplateRow key={t.id} template={t} onEdit={() => setDraft({ id: t.id, name: t.name, preset: t })} />
            )
          )}
        </div>
      </section>
    </div>
  )
}
