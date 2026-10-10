# Changelog

## [Unreleased]

- Ctrl+drag a detected file path from a terminal onto another pane to insert
  it there; Ctrl+click still opens it.
- Fix Ctrl+click on absolute Windows paths opening the file externally
  instead of in the editor (verbatim `\?\` paths failed the project check).

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
