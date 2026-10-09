# Astera migration into Swarmterm GN

This fork adds Astera's seven visual themes and its terminal-linked file workflow
to Swarmterm's existing Tauri application. Select a terminal, browse that pane's
project/worktree, inspect or edit agent output and run a file without replacing
the agent's shell. The [user guide](user-guide.md#files-and-editing) describes the UI.

The port preserves Swarmterm's upstream Git history and GPL-3.0 license. Copied
Astera code remains attributed, with Apache-2.0 and font license texts bundled.
The source snapshots reviewed were:

- Swarmterm: `89f9bb780c0aa0b99cfe638235c580de2f1a1319`.
- Astera: `debc3098acd5098299ca956fe024763b2decaf3b`.

## Source mapping and use cases

| Astera source | GN implementation | Purpose |
| --- | --- | --- |
| `src/core/theme/`, renderer theme provider | `src/lib/theme/`, `theme-adapter.ts`, appearance store and CSS | Vega, Orion, Umbra, Aurora, Antares, Quasar, Sirius; fonts, palette, density, corners, shadows |
| `FileExplorer.tsx`, `useFileOps.ts`, `src/core/files/` | `components/Files/FileExplorer.tsx`, explorer store, pure file rules | Navigate large trees, manage files, move/copy across agent projects |
| `FileEditor.tsx`, pure edit rules | `CodeEditor.tsx`, document store, pane workbench | Inspect generated code, edit shared buffers and resolve disk conflicts |
| `MarkdownSplit.tsx`, Markdown/media helpers | `FileView.tsx`, `MediaView.tsx`, code fences and search | Review agent documents and generated media without leaving the workspace |
| `src/main/ipc.ts`, filesystem/history services | `src-tauri/src/files/`, typed `src/tauri/files.ts` | Replace Electron filesystem IPC with native, root-confined Tauri services |
| `fileWatcher.ts`, `gitWatcher.ts` | Rust notify watcher and porcelain status parser | Refresh after agents change files, index or worktree metadata |

Copied pure rules include path handling, selection, operation validation, EOL
and conflict rules, theme definitions, and stable media reload bookkeeping.
Electron APIs and Node filesystem calls are replaced rather than emulated.
Astera accounts, jobs and its full saved run configuration system are outside
this migration. File Run supports Python/pytest, Node, Compose and .NET commands.

## Integration

The left navbar contains vertically resizable Workspaces, Terminals and Files
regions. A pane's configured spawn directory is the explorer root, falling back
to workspace cwd. Rust reads that directory from its managed terminal and checks
the expected directory during pane restart using canonical paths. Shell `cd`
does not move the root. Expanded folders are cached per root for the launch.

Each pane keeps its Terminal tab mounted in `PaneWorkbench`; xterm and PTY state
remain owned by the existing terminal registry. File tabs can move between panes
and share a single buffer per context/path. CodeMirror states retain undo,
selection and scrolling across tab changes. An optional split displays terminal
and editor together. Focus ownership gates both window shortcuts and the xterm
shortcut handler; file navigation never becomes shell input.

Appearance settings persist using Swarmterm's existing settings mechanism.
The original VS Code Dark remains the default. Live theme changes update xterm
options and host backgrounds in place; terminal font preferences and ANSI colors
remain separate. Every appearance card renders using its own palette.

## Native file service

All filesystem IPC goes through `src/tauri/files.ts`. Commands in `commands.rs`
restrict access to the main webview and delegate blocking work to testable file
modules. Context IDs authorize configured roots, not arbitrary frontend roots.
Canonical component checks reject sibling-prefix escapes, `..`, and symlinks or
junctions resolving outside the root. Rename/unlink guard the entry's parent so
a link can be removed without operating on its target.

Creates use exclusive creation. Rename/move publication uses atomic no-replace
operations on Windows, Linux and macOS. Copies stage in an owned temporary
directory and select a collision-free destination. Partial results retain
successful items and expose failures; retrying cut/paste or undo does not repeat
completed moves. Copying symbolic links is unsupported. Native file clipboard
imports are explicit, re-check clipboard paths after confirmation, and are the
only filesystem operation allowed to read sources outside authorized roots.

The editor reads at most 1 MiB plus a sentinel byte. Binary/non-UTF-8 and larger
files are read only. Saves preserve CRLF/LF, UTF-8 BOM and permissions, stage
bytes in the destination directory and check content versions before and after
staging. Dirty buffers receive a conflict banner after external changes. A
deleted open file retains its buffer. Save/Discard/Cancel protects closing the
last shared tab, pane/workspace and tray Quit.

Notify watches actual project directories without traversing symlinks, skips
large generated/dependency folders, and adds explicitly open files' parent
directories when needed. Git metadata watches include worktree `.git` pointers
and refs, excluding the object database. Reference-counted watch leases stop
the worker when the final consumer closes. Events are debounced and async
responses cannot replace a newer root or listing.

Deletion snapshots live in GN's application-data directory, indexed by root
identity. Retention is 30 days and 200 MiB per root, with 50 MiB and 5,000 entries
per snapshot. Snapshots cannot contain symbolic links. Confirmed deletions proceed
when a snapshot is skipped, with a visible warning. Restore recreates guarded
parents and chooses a collision-safe name. Explorer undo is limited to 50
operations in this launch; snapshots persist independently. This does not record
deletions made by shells or other applications.

Markdown uses GFM, raw HTML parsing followed by sanitization, generated heading
IDs and rendered-text search. Project images/videos use a root-confined custom
protocol with a MIME whitelist, byte ranges for video seeking, and bounded reads.
SVG is not served by this protocol. Video formats depend on native codecs.
Media reload waits for two stable stat samples and preserves playback position.

## Fork and verification

The product name is Swarmterm GN and the application identifier is
`com.apooooh.swarmterm.gn`. The upstream updater plugin, endpoint, permissions,
tray action and generated updater artifacts are disabled. Workspaces remain
ephemeral as in upstream; only settings and local deletion history persist.

Run `npm test` for pure rules and store races, `npm run build` for TypeScript and
production bundling, and `npm run test:e2e` for headless Chromium integration.
The browser fixture runs the real React application against in-memory filesystem,
clipboard and PTY mocks. It verifies worktree following, CRLF save, conflicts,
dirty guards, file operations/history, drag-and-drop/shared buffers, virtual
trees, all themes, Markdown sanitization/search, image reload, editor undo and
dedicated runners without writing user files or launching native app windows.

Rust tests exercise root guards, versioned writes, no-replace collisions,
snapshots/restores, git status parsing and media ranges. CI checks frontend,
headless tests and Rust on Windows/Linux/macOS; Windows also builds the desktop
executable. Native OS clipboard, webview codecs, live watcher behavior and tray
interactions still require the platform [manual smoke checks](manual-smoke-tests.md#astera-themes-and-files-gn).

`dev` integrates `feat/astera-themes` and `feat/astera-explorer` with merge commits.
Upstream changes should be merged through `upstream`, preserving fork history.
Private workspace notes, research clones, credentials and local toolchains are
not included in the public product repository.
