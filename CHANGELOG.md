# Changelog

## [Unreleased]

- Pin each Codex pane to its own app's MCP server, so a development build
  running next to the installed app no longer redirects Codex away from the
  War Room. Codex session hooks start without a nested PowerShell, stale
  duplicate hook entries are removed, and Codex asks once to trust the
  updated hook.

## [1.4.0] - 2026-10-11

- Keep terminal creation and account configuration off the UI thread, combine
  concurrent profile/agent refreshes, and delay project scans until folder
  typing settles. Workspace macros share a single fresh metadata probe.

- Manage separate Claude Code and Codex account profiles, select or rotate
  accounts when composing panes, and restore conversations with their owning
  profile. Credentials stay in the agent CLI's configuration.
- Customize app shortcuts, detect conflicting bindings and save workspace
  macros for common pane layouts without storing terminal commands.
- Add reviewed MCP server definitions to default or named accounts through
  Settings. Preserve existing configuration, show conflicts and complete
  authentication in the agent CLI; Playwright runs headless.

- Save up to 24 workspaces locally and reopen them from Welcome with their
  split layout, shells, agents, folders, launch modes and worktree bindings.
  Rename or forget saved entries without stopping an open workspace.
- Capture exact Claude Code and Codex session identities through lifecycle
  hooks so panes in the same folder reopen their own conversations. Codex
  hooks use the normal `/hooks` trust flow and supported panes run with
  `--no-daemon`. Missing folders, sessions or CLIs show a fallback notice.

## [1.3.1] - 2026-10-10

- Release 1.3.0 again; its release checks failed on two browser tests still
  using HTML5 drop events. 1.3.0 was never published.

## [1.3.0] - 2026-10-10

- Fix a stray `^[[I` / `^[[O` above the Claude Code banner when focus moved
  while the agent was starting. Focus reports are no longer fanned out to
  broadcast members or counted as typing for War Room deliveries.

- Ctrl+drag a detected file path from a terminal onto another pane to insert
  it there; Ctrl+click still opens it. File names in a PowerShell `dir` /
  Get-ChildItem listing are links too, resolved against its Directory header;
  folders (rows and header path) can be Ctrl+dragged, Ctrl+click shows them
  expanded in Files.
- Fix Ctrl+click on absolute Windows paths opening the file externally
  instead of in the editor (verbatim `\\?\` paths failed the project check).

- Dragging from Files now shows a proper copy/move cursor and a label under
  the pointer instead of the Windows "no-drop" sign; Ctrl copies into a
  folder, Esc cancels. No OS drag loop is involved any more. File tabs
  drag between panes the same way (that HTML5 drag never landed on Windows).

- Sidebar "Auto" layout (new default): Workspaces and Terminals take their
  content height, Files fills the rest. "Manual" keeps the resizable
  sections (Settings → Appearance → Sidebar).

- Maximize a pane to fill its workspace (header button, header double-click
  or Ctrl+Shift+Enter); the other panes keep running.

- Ctrl+Shift+Backspace clears the pending input line of the focused terminal
  without quitting a running agent.
- Fix the last terminal row slipping under the pane border after resizing.

- SVG and HTML files open with Editor / Split / Preview modes, updated live
  while typing. SVG preview with wheel zoom, pan, Fit/100 % and background
  choice; HTML preview with relative assets and sandboxed scripts. New
  "Browser" button opens the file in the system default app.
- Drag files or folders from Files onto a terminal pane to insert their
  quoted paths, like a drop from the OS file manager. Claude Code panes get
  relative `@` mentions instead (`@src/foo.ts`).
- Ctrl+clicking a file path in a terminal also selects it in Files, expanding
  its folders and scrolling to it.

- Codex panes start in a selectable launch mode (Auto, Safe, YOLO) passed as
  CLI flags; switching restarts Codex and continues the session. "Resume previous chat…"
  takes over an older Codex chat in the pane.

## [1.2.0] - 2026-10-10

- Open Markdown files rendered by default in a MarkText-style reading view;
  the default view is configurable under Settings → Files.
- Add "Open in MarkText" to the file toolbar and explorer context menu, with
  auto-detection of the MarkText install and an optional path override.
- Hash the published installer filename in the release checksums.

## [1.1.0] - 2026-10-10

- Add all seven Astera themes, bundled UI fonts and theme-specific density,
  corners, shadows and preview cards. Running terminals change palette in place.
- Add a resizable Files section that follows the selected terminal's configured
  project/worktree, with a virtual tree, git badges, multi-selection and file operations.
- Add native file clipboard import/export, internal drag-and-drop, progress,
  undo and bounded local deletion history with collision-safe restore.
- Add shared CodeMirror file tabs, language highlighting, find/replace, CRLF/BOM
  preservation, dirty-close guards and external-change conflict resolution.
- Add sanitized GFM Markdown previews, synchronized split scrolling, heading
  links and preview search, plus image/video previews with stable-change reload.
- Run supported files in a dedicated plain-shell pane, and open project paths
  printed in terminals in the integrated editor without respawning the PTY.
- Brand the fork as Swarmterm GN and disable upstream updater endpoints.
- Add headless integration coverage and Windows Rust CI checks.
- Add a tag-triggered Windows installer release workflow with version checks,
  release notes, SHA-256 checksums and publication after successful checks.
- Support Windows x64 in the GN fork; retain upstream platform code and history.
