// MUST stay the first import: it installs the boot-failure screen, and anything
// imported above it could throw before the listeners exist (see boot-guard.ts).
import './boot-guard'
import ReactDOM from "react-dom/client";
import App from "./App";
import './index.css'
import { installScrollbarActivity } from './lib/scrollbar-activity'
import { applyVisualStyle } from './lib/theme-adapter'
import { useAppearanceStore } from './store/appearance-store'

// Reveal the minimal-overlay scrollbars while any element is actively scrolling
// (they are hidden at rest and otherwise only show on hover). One global
// listener covers every scroll container, including terminal viewports.
installScrollbarActivity()
applyVisualStyle(useAppearanceStore.getState().style)

// NOTE: intentionally NOT wrapped in <React.StrictMode>. Each TerminalPane owns a
// real OS pty; StrictMode's dev-only double-mount would spawn a shell, kill it,
// and spawn another (and run a template's initialCommand twice), and the rapid
// re-create races the async pty teardown ("Terminal already exists").
// Dev builds only: mirror renderer warnings/errors into SWARMTERM_DEV_LOG.
if (import.meta.env.DEV) {
  void Promise.all([import('./lib/dev-log'), import('./tauri/devlog')]).then(([{ installDevLog }, { writeDevLog }]) => installDevLog(writeDevLog))
  // Read-only probe for the external testlab (Playwright over CDP): state the
  // DOM cannot show, e.g. terminal text drawn by the WebGL renderer.
  void Promise.all([import('./lib/terminal-registry'), import('./store/app-store'), import('./store/document-store'), import('./store/routine-store'), import('./store/saved-workspaces-store'), import('./store/agent-state-store')]).then(([reg, app, docs, routines, saved, agentState]) => {
    Object.assign(window, { __swarmtermDev: {
      terminalText: (id: string, lines?: number) => reg.readTerminalText(id, lines),
      terminalGeometry: (id: string) => reg.terminalGeometry(id),
      hoveredPathLink: (id: string) => reg.getHoveredPathLink(id) ?? null,
      workspaces: () => app.useAppStore.getState().workspaces.map((w) => ({ id: w.id, savedId: w.savedId, name: w.name, cwd: w.cwd, layout: w.layout, worktreeMode: w.worktreeMode, focusedLeafId: w.focusedLeafId, zoomedLeafId: w.zoomedLeafId, floating: w.floating })),
      activeWorkspaceId: () => app.useAppStore.getState().activeWorkspaceId,
      // The one write: lets a scenario remove the workspace it created.
      closeWorkspace: (id: string) => app.useAppStore.getState().closeWorkspace(id),
      // Makes a routine due without waiting for its schedule (SWA-24 scenario).
      backdateRoutine: (id: string, ms: number) => routines.useRoutineStore.getState().patch(id, { lastScheduledAt: Date.now() - ms }),
      routines: () => routines.useRoutineStore.getState().routines,
      // Saved workspaces through the app's own store instance: a dynamic
      // import from the testlab gets a second copy after HMR.
      savedWorkspaces: () => saved.useSavedWorkspacesStore.getState().entries,
      savedAutostarting: () => saved.useSavedWorkspacesStore.getState().autostarting,
      savedNotice: () => saved.useSavedWorkspacesStore.getState().notice,
      setSavedAutoOpen: (id: string, on: boolean) => saved.setOpenWorkspaceAutoOpen(id, on),
      openSavedAutostart: () => saved.useSavedWorkspacesStore.getState().openAutostart(),
      forgetSavedWorkspace: (id: string) => saved.useSavedWorkspacesStore.getState().forget(id),
      // Drives a plain shell pane's agent state (no detector publishes there),
      // so the pane-highlight scenario needs no real agent or prompt.
      publishAgentState: (id: string, state: 'working' | 'blocked' | 'idle' | 'unknown', paneWatched = true, sinceMs = Date.now()) =>
        agentState.useAgentStateStore.getState().publish(id, state, { paneWatched, nowMs: sinceMs }),
      markAgentSeen: (id: string) => agentState.useAgentStateStore.getState().markSeen(id),
      documents: () => Object.values(docs.useDocumentStore.getState().documents).map((d) => ({ path: d.path, mode: d.mode, dirty: d.dirty }))
    } })
  })
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
