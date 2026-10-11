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
  void Promise.all([import('./lib/terminal-registry'), import('./store/app-store'), import('./store/document-store')]).then(([reg, app, docs]) => {
    Object.assign(window, { __swarmtermDev: {
      terminalText: (id: string, lines?: number) => reg.readTerminalText(id, lines),
      terminalGeometry: (id: string) => reg.terminalGeometry(id),
      hoveredPathLink: (id: string) => reg.getHoveredPathLink(id) ?? null,
      workspaces: () => app.useAppStore.getState().workspaces.map((w) => ({ id: w.id, savedId: w.savedId, name: w.name, cwd: w.cwd, layout: w.layout, worktreeMode: w.worktreeMode, focusedLeafId: w.focusedLeafId, zoomedLeafId: w.zoomedLeafId, floating: w.floating })),
      activeWorkspaceId: () => app.useAppStore.getState().activeWorkspaceId,
      // The one write: lets a scenario remove the workspace it created.
      closeWorkspace: (id: string) => app.useAppStore.getState().closeWorkspace(id),
      documents: () => Object.values(docs.useDocumentStore.getState().documents).map((d) => ({ path: d.path, mode: d.mode, dirty: d.dirty }))
    } })
  })
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
