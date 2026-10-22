# Swarmterm GN user guide

Everything the [README](../README.md) summarises, in detail: workspaces and panes,
running several agents at once, worktree isolation, the web preview, the War Room,
settings, keyboard shortcuts, troubleshooting and current limits.

Swarmterm GN supports **Windows x64**. Use the Ctrl bindings where inherited
shortcut labels show both Ctrl and Command. macOS and Linux are not supported.

## Create a workspace

Swarmterm opens on the **composer**: pick a folder (the working directory for every pane), choose how many terminals, and use the steppers to assign AI agents — **Claude Code**, **Codex**, **OpenCode**, **GitHub Copilot**, **Qwen Code**, **Amp**, **Gemini CLI**, **Cursor Agent**, **Antigravity** or **OMP (Oh My Pi)** — the rest stay plain shells. Only agents whose CLI is installed are listed. Turn on **Isolate features in git worktrees** for parallel work, then press `⌘/Ctrl + Enter`.

Agent detection re-runs every time the composer opens, so installing a CLI needs no restart. Workspace layouts and known agent conversations can be reopened from **Saved workspaces** on Welcome. Settings persist too; terminal output and unsaved editor buffers do not.

### Defaults and templates

The composer starts from your **workspace defaults**. Below the options, **Save as default** stores everything you've chosen (folder, terminal count, agents and their accounts, worktree isolation, *Split opens*) as the starting point for every new workspace. With no default folder the composer starts in your home directory.

**Save as template…** stores the current choices under a name. Saving under an existing name (case doesn't matter) offers to overwrite it. Once you have templates, a **Template** picker appears above *How many terminals?*; choosing one fills in all its choices, and *Defaults* goes back to your defaults. Agents whose CLI isn't installed are left out when a default or template is applied.

**Name** (optional, under *Working folder*) sets the new workspace's name; left blank, the workspace is named after its folder. Duplicate names get a ` (1)`, ` (2)` suffix.

Edit both under **Settings → Workspaces**: change the defaults in place (or **Reset to built-in**), and add, edit, duplicate or delete templates.

### Choosing a folder

Every **Browse** / **Choose path** button opens Swarmterm's own folder picker instead of the Windows dialog. The left column holds your **Favorites** (star the folder you are viewing to pin it; hover a favorite to unpin it) and **Recent** folders from the composer and your saved workspaces — click one to open it, double-click to select it straight away. The box on top filters the subfolders by name; type an absolute path such as `C:\Code\` to jump there. Arrow keys move the highlight, `Enter` opens the highlighted subfolder, `Ctrl + Enter` selects the folder being shown, `Backspace` in the empty box goes up, `Esc` cancels. **Windows dialog** falls back to the native picker.

## Panes

- **Pane numbers and names:** every open pane of a workspace carries a small number in its header and in the sidebar's terminal list, in the list's order (drawered panes have none, so parking one renumbers the rest). Double-click a pane's title — in the header or the sidebar — to give it your own name, for example "Backend"; Enter saves, Escape cancels, an empty name goes back to the automatic title. In the pane header the name is shown in bold with the agent's own title muted beside it ("**Backend** · Fixing login tests"); the sidebar shows just the name. Names are kept with saved workspaces. A name that is only a number ("3", "zwei") is not accepted, since it would clash with the pane numbers. Renaming never restarts the shell. Numbers and names are what you say to dictate into a pane by voice (see **Voice dictation**).
- **Pane identity (icon + name + color):** to tell at a glance who does what, give a pane an identity. Hover the header and click the small smiley left of the title (or right-click the pane → **Set identity…**). The dialog sets the name, an icon — scroll the grid of all ~2,000 Lucide icons (suggestions first, then A–Z) or search them by name ("rocket", "arrow up"; Enter takes the best match) — or any single emoji, and an optional color from 20 — tick **Tint the top bar** to color the pane's whole header bar with it, so a pane is recognisable from across the screen — with a live preview; **Save** (Enter) applies it, **Clear identity** removes all three. The icon also replaces the agent icon in the sidebar list and tints the pane's War Room avatar. Identity is kept with saved workspaces and never restarts the shell. Click the icon or the name in the header to change it again.
- **Split** from the pane header, drag the separator to resize, and drag a header onto another pane to swap the two — shells keep running.
- **Corner resize:** where two separators meet, a small handle lights up on hover. Drag it to resize width and height in one move; every pane touching that corner follows.
- **Even out with a double-click:** double-click a separator to give the panes on both sides of it equal room, along that separator only (left/right for a vertical bar, top/bottom for a horizontal one). With two panes that is 50/50; with one pane beside two, each of the three gets a third. Double-clicking a corner handle evens out both directions at once. Panes further inside keep their own sizes — use **Tidy layout** to even out everything.
- **Floating panes:** the picture-in-picture button in a pane header lifts the pane out of the layout into a floating window above the others — the shell keeps running. Drag the grip bar on top to move it anywhere, drag its edges or bottom corners to resize. Drag its header onto another pane to dock it there (left, right, top, bottom or swap), or press the button again to put it back where it was. Floating panes come back docked when a saved workspace is restored.
- **Drag to split:** while you drag a pane over another one, a small picker appears in its middle. Drop on the **left, right, top or bottom** tile and the two panes share that slot, split that way — the dragged pane takes the highlighted half and its old spot closes up. The **Swap** tile in the centre (or anywhere else on the pane) swaps them as before.
- **Snap layouts:** while a pane is dragged, a bar of layout previews appears at the top of the workspace (like Windows 11's snap layouts): side by side and stacked, plus grid, main-left and main-top from three panes up. Each preview is split into slots — drop on one and every visible pane is rearranged into that layout, the dragged pane in the slot you chose and the others in their current order. Hovering a slot outlines the result first. Split sizes come out even; drawered panes stay in the drawer.
- **Tidy layout:** the workspace's **⋮ → Tidy layout** menu entry in the sidebar evens out the split sizes so every pane in a row or column ends up the same size — also after you dragged separators around or split a pane several times. Panes that sit side by side share the width equally, panes that sit above each other share the height, however unevenly the layout was built: three panes split as one on the left and two on the right become a third each, not a half and two quarters. A group of stacked panes counts as one column when it sits beside other panes. Drawered and floating panes do not count, and a zoomed pane is restored first so you see the result. Only sizes change; no pane moves and no shell restarts. The action is also listed as **Tidy layout (equal pane sizes)** in Settings → Keyboard Shortcuts, where you can give it a key (none is set by default) or use it as a step of a custom action. Because of the thin gap between panes, nested panes can differ by a few pixels.
- **Default AI provider for splits:** by default a split opens a plain terminal. Pick an agent under **Settings → Terminal → Default AI provider** (for example Claude Code or Codex) and both split buttons open that agent instead; the split tooltip names it. A workspace can override the setting: choose **Split opens** in the composer when you create it, or later from the workspace's **⋮ → Split opens…** menu in the sidebar (**Settings default** follows the global choice). **Alt+click** a split button for a plain terminal. If the chosen agent's CLI is not installed, the split falls back to a plain terminal. Split panes start in the workspace folder, also with worktree isolation on — they never create a new worktree.
- **Handoff brief:** the clipboard button in a pane header opens an editable brief for handing the work to another agent or person. Fill in task, status, open items and tests; Swarmterm adds the agent, account, folder, session id, branch, HEAD and a `git diff` reference with the changed files. These four fields are always labelled as stated by you — Swarmterm never claims them as proven by the terminal. A raw tail of the scrollback can be added on request and is marked incomplete. Edit the preview freely, then **Copy**; nothing is sent anywhere.
- **Prompt library:** the speech-bubble button in the title bar (or the "Open prompt library" action, bindable under Settings → Shortcuts) keeps prompts you save, stored only on this machine. Pick one, edit it if you like, then choose where it goes: a running Claude Code or Codex pane (in any workspace) gets it through the same one-shot delivery as a handoff brief — it waits while you type there or the agent is busy, never goes into a plain shell, and is not retried; or **New pane next to the focused one** starts Claude Code or Codex with the prompt, optionally **In a new git worktree** (if no worktree can be created, nothing is started). The result appears in the notification bell.
- **Routines:** the calendar button in the title bar (or the "Open routines" action) runs Claude Code or Codex on a schedule: give the routine a name, an agent and account profile, a brief (typed or taken from a saved prompt) and either a time of day with optional weekdays or an interval of at least 5 minutes. Each run starts a new pane next to the focused one in the **active** workspace with the brief as its first prompt, optionally **In a new git worktree** (if none can be created, the run is reported and nothing starts). Routines run only while Swarmterm is open. A routine never overlaps itself: while the previous run's agent is still working or waiting for you, the slot is skipped, not queued. If slots were missed while the app was closed or the computer slept, only the latest one counts — **run once on return** starts it once, **skip it** drops it; there is never a burst of catch-up runs. Saving a changed schedule or switching a routine on counts from that moment. **Run now** starts a run immediately. Every start, skip and failure lands in the notification bell. Routines are stored only on this machine. **Command routines** run a shell command instead of an agent: choose **Shell command** as the kind, enter one command line, its working folder and a time limit (1–60 minutes). The line runs through `cmd.exe` in the background, without a window, a pane or an agent, so it uses no tokens; at the time limit the command and everything it started are stopped. Only failures (non-zero exit code, timeout, start error) go to the bell, with the last output line; the routine's **Last run** line shows the exit code and duration of every run. Commands are typed only in this dialog; agents cannot create or change them.
- **Conversation view:** once a Claude Code or Codex pane has reported its session, the speech-bubble button in its header opens the conversation as a read-only list, read from the CLI's own session file (for long sessions only the newest part). **Show tool steps** adds collapsed tool calls; **Refresh** re-reads the file. The view cannot type into the pane, answer prompts or approve tools.
- **Account and agent handoff:** in the Handoff brief dialog, **Hand off…** lets you pick Claude Code or Codex with any account profile (or Default), then **Start pane** opens a new pane in the same folder. The old pane keeps running. **Send brief** unlocks only after the new CLI itself reports its session to Swarmterm (a plain shell, a missing CLI or one that quit never qualifies). If the agent waits on a trust or login prompt, **Go to pane** tucks the dialog into a small chip and focuses the new pane; **Open** brings the handoff back. After a while the dialog reminds you to answer the prompt in the pane — it never sends on its own. Then **Send brief** pastes the brief as its first prompt and submits it. It is sent at most once: it waits while the agent is working, asks a question, or you are typing in that pane, and it is cancelled — never retried — if the pane stops or restarts first. The result (sent or not sent) appears in the notification bell. Account usage for the selected target is shown only when a CLI reports it in structured form: Claude Code passes its 5-hour and 7-day rate limits to the Swarmterm status line, so any Claude pane on that account profile keeps the number current (shown with the time it was taken). Codex has no such source, and without the Swarmterm status line it reads "Usage unknown" with the time checked. A usage-limit message in the old pane's output is shown only as an unverified hint.
- Closing a pane closes the gap; closing the last pane closes the workspace.
- **Drawer:** the archive button in the pane header (or `⌘/Ctrl + Shift + D`) parks a pane for later. It leaves the screen like a close and the other panes fill the gap, but the shell, agent session, scrollback and any preview keep running. Parked panes are listed under **Drawer** at the bottom of the sidebar's terminal list (dimmed, state dots still live) and the workspace row shows how many are parked; one click on a row puts the pane back in its original spot. Jumping to a pane that needs attention restores it too. Drawers are not kept across restarts.
- The left navbar lists workspaces (add, rename, reorder) and the current workspace's terminals — click one to jump to it. `⌘/Ctrl + B` hides the sidebar. While it is hidden, rest the mouse on the left edge of the window to slide it in over the workspace; move away and it slides out again. Turn this off under **Settings → Appearance → Peek sidebar on left edge** (on by default). Peek is mouse-only; from the keyboard use `⌘/Ctrl + B`. The right panel (Preview, Git, War Room) peeks the same way: while it is closed, rest the mouse on the right edge. The pin button docks it; Preview needs the docked panel. Turn it off under **Settings → Appearance → Peek right panel on right edge**.
- A pane can switch to a different agent, shell or folder from its header menu — note this restarts the shell.
- **Narrow panes:** by default the agent icon and mode, title and folder stay in the header, and maximize and ✕ always do (see *Customize the title bar* below). When the pane is too narrow for the rest, a `⋯` button appears and the less important controls (by default shell, worktree, context %, actions…) move out of the row. Hover the header to drop them in a second row over the terminal, or click `⋯` to keep that row open until you click `⋯` again or click elsewhere. From the keyboard, `Enter` on `⋯` moves focus into the row and `Esc` closes it; an `Esc` typed into the terminal always goes to the shell.
- **Customize the title bar:** in **Settings → Title bar** you can drag the header controls (or use the arrow buttons) into any order, and set each one to **Core** (always stays in the bar), **Can hide** (moves to the `⋯` row when space runs out; once you reorder, the lowest in the list go first), **⋯ only** (never in the bar, always in the `⋯` row — hover the header or click `⋯`) or **Off** (not shown at all; its keyboard shortcut, if it has one, still works). The title is always core; maximize and ✕ always stay at the right. **Reset to defaults** restores the original layout. Changes apply to every pane at once and are remembered.

## Files and editing

The left sidebar has three sections: **Workspaces**, **Terminals** and
**Files**. Click a terminal to show its files, or press `⌘/Ctrl + Shift + E` to
focus the tree. In the default **Auto** layout the two lists take the height
they need (up to about a third each, then they scroll) and Files fills the rest,
so adding a workspace or pane pushes the explorer down. **Settings → Appearance
→ Sidebar → Manual** (or the small toggle next to the Workspaces heading) brings back draggable section separators. Drag the
sidebar edge to change its width.
The root is the terminal's configured starting folder, including isolated
worktrees. Running `cd` in its shell does not change the explorer root.
Expanded folders are remembered separately for each root during this launch.

Click a folder to expand it; click a file to open an editor tab in that pane.
The tree loads directories on demand and renders only visible rows. Its filter
searches loaded entries. Git badges indicate modified, added, deleted, renamed,
untracked and conflicted files, including changes inside folders.

Use the toolbar or context menu to create files/folders, rename, duplicate,
cut/copy/paste, delete, copy paths, reveal files in your OS file manager and undo.
`⌘/Ctrl + click` toggles selection; `Shift + click` selects a range. Arrow keys,
Home/End and typing a name navigate; `F2` renames and Delete asks before deleting.
`⌘/Ctrl + A/C/X/V/Z` select all, copy, cut, paste and undo while the tree has focus.
Drag selected entries onto a folder to move them; hold `⌘/Ctrl` to copy.
Copies and restores choose a new name on collision; renaming cannot overwrite
an existing entry. Errors and copy progress appear in the Files section.

Copy also exports native file references to the system clipboard. **Paste from
system clipboard** imports files copied in your file manager after showing the
destination and asking for confirmation. Internal cut/paste works between
project roots without relying on an OS cut protocol. Symbolic links can be
removed or renamed, but recursive copies containing links are refused.

Text files open in CodeMirror with language highlighting and find/replace.
`⌘/Ctrl + S` saves; text buffers preserve their original CRLF/LF and UTF-8 BOM.
Opening the same file in two panes shares its buffer. Drag file tabs between
panes, or use **Split terminal and editor** to keep both visible. Returning to
the Terminal tab restores its running session and scrollback. File edits,
shortcuts and explorer navigation stay with the focused UI.

External agent changes reload a clean buffer automatically. A dirty buffer
instead shows **changed on disk** with **Reload disk** and **Keep my buffer**
choices; it is never silently replaced. Closing the last tab for a dirty file,
closing its pane/workspace or quitting from the tray offers Save/Discard/Cancel.
The embedded editor supports UTF-8 files up to 1 MiB. Binary, non-UTF-8 and larger
files are read only; use an external editor for those.

### Markdown, SVG, HTML and media

Markdown supports Editor, Split and Preview modes (`⌘/Ctrl + Shift + V` cycles
them). Split scrolling follows source lines in both directions. The preview
supports GFM tables/tasks, heading anchors, project links and images, highlighted
code blocks with Copy, and text search. HTML is sanitized and script URLs are
removed. Relative files/images must resolve inside the configured project root.
Remote HTTP(S) images may be loaded by the preview.

Markdown files open rendered by default, in a centred reading column styled
after MarkText. **Settings → Files → Open Markdown as** switches the default to
Split or Source; the toolbar still switches each file individually.

**Open in MarkText** (file toolbar, or the explorer context menu on a `.md`
file) hands the file to the external [MarkText](https://www.marktext.cc/) app.
Unsaved edits are saved first. Swarmterm looks in the standard install
locations (`%LOCALAPPDATA%\Programs\marktext`, `Program Files\MarkText`); a
different install can be set under **Settings → Files → MarkText**. Only a file
named `marktext.exe` is accepted there, so the setting cannot launch another
program.

SVG and HTML files get the same Editor / Split / Preview modes and follow the
same **Open … as** default. Both previews update as you type, before saving.
The SVG preview zooms with the mouse wheel around the cursor, pans by dragging,
and offers **Fit** (also a double-click), **100 %** and a dark (default), light or
checkerboard background; SVG scripts never run there. The HTML preview loads the page
from its own folder, so relative stylesheets, scripts, fonts and images work.
Page scripts run in a sandbox without access to Swarmterm; popups, forms and
pages outside the project are blocked. **Browser** saves unsaved changes and
opens the file in the system default app for `.html`/`.svg`.

PNG/JPEG/GIF/WebP images and MP4/M4V/MOV/WebM videos open in a media viewer.
Video playback depends on the platform's codecs. Generated media reloads after
two matching file-stat samples, preserving video position and active playback.
Inactive workspaces pause video. **Open in default app** and **Reveal file** are
explicit buttons available for media; previewing a file does not execute it.

**Run** on a supported file starts a separate plain-shell pane in its folder:
Python files, pytest naming conventions, JavaScript/Node files, Docker Compose
YAML, .NET projects and solutions. Dirty files must be saved first. The required
interpreter/tool must already be installed in that shell. Astera's saved run
configuration system is not included.

### Local deletion history

Explorer deletions attempt a snapshot before removal. **Local deletion history**
lists snapshots for the current root and restores them with a collision-safe
name. `⌘/Ctrl + Z` in the tree undoes the latest explorer operation in this launch.
Snapshots persist in this fork's application-data directory for 30 days, with a
200 MiB budget per root and a maximum 50 MiB / 5,000 entries per snapshot.
Skipped or failed snapshots are shown; a confirmed deletion still proceeds.
Symbolic links and unsupported filesystem entries cannot be snapshotted.
Deletes performed by shell commands or other programs are not captured.

## Running several agents at once

- **Activity dots** light up while a pane produces output, so you can see who is working — for agent panes this becomes the richer [agent state dot](#agent-state-dots) instead (every agent except OMP, which keeps the plain dot).
- **Broadcast input** — `⌘/Ctrl + Shift + B`, then `Alt + Click` panes into the group and type once; every pane receives the same keystrokes ("now run the tests" × 5). `Esc` leaves.
- A badge counts War Room messages queued for a pane that is busy.

## Agent state dots

An agent pane shows a coloured dot instead of the plain activity dot: **red** — the agent is blocked and needs your input (a permission prompt, a question); **yellow** — it's working; **green** — it finished while you were looking elsewhere, and clears the moment you focus that pane; **no dot** — idle, nothing to report. Right after a pane spawns (and again if the agent process exits) state is briefly unknown, so it falls back to the plain output-activity dot until detection catches up. Plain Terminal panes always use that plain dot — they never get colours. One known limit: **OMP** panes also keep the plain dot — its screen exposes no reliable state signals, so Swarmterm doesn't guess.

**Claude Code** panes also receive exact signals from Claude's own hooks, not just from reading the screen. At every launch Swarmterm merge-writes `swarmterm --hook` entries into `~/.claude/settings.json` (the same file as the status line; additive — hooks you already have are never touched). That makes a permission prompt turn the dot red the instant it appears and a finished reply clear it at once, while screen reading still fills the gaps — for example a question Claude asks without a permission prompt.

A workspace tab in the navbar rolls this up across all its panes and shows the highest-priority dot — blocked beats done, done beats working, working beats plain activity — but only while that tab is **inactive**; the tab you're looking at never needs a dot. War Room member rows show the same coloured dot, or a muted grey dot labelled "Connected, idle" when a member has nothing to report.

The sidebar header also shows a small counter across **all** workspaces — a red pill for blocked panes and a green one for panes that finished while you were away. Hover any dot to see how long the pane has been in that state ("Blocked for 4m — needs your input"), and hover the red pill to see the longest wait among them. Click a pill, or press `⌘/Ctrl + Shift + J`, to jump to the next pane that needs you: blocked panes first — the one that has waited longest ahead of the rest — then finished (earliest first), then working, then idle in sidebar order, cycling on repeat presses (and switching workspaces when needed). Landing on a finished pane marks it seen, so the green count drops as you go. Hiding the sidebar hides the counter; the shortcut keeps working.

### Pane highlighting

Turn on **Settings → Appearance → Highlight panes by agent state** to frame the agent panes themselves in the same colours as their dots — a thin inner border with a soft glow, so you can tell at a glance across a split layout which pane needs you: **red** while it's blocked, **green** after it finished in the background (cleared the moment you focus it, like the dot), and **yellow** while it's working. A long turn drifts from yellow to orange over the **Working gradient** you pick (5, 10 or 30 minutes, or off to stay yellow), so the pane that has been busy for a while stands out. Idle panes and plain Terminal panes are never framed, and the focus and broadcast borders stay visible underneath. On by default; switch it off there if you prefer plain panes.

## Notifications

A background agent pane chimes when it blocks (needs your input) or finishes — a short WebAudio tone, so you don't have to keep watching the dots. The chime fires about a second after the state change, and Swarmterm re-checks at that moment: a blocked flash that resolves itself, or a pane you've since switched to, never sounds. Several panes changing within about half a second share one chime and one banner — a pane that needs your input wins the tone, and the banner lists them ("Claude Code needs your input · Codex finished", "2 Claude Code panes finished").

A system notification (banner) only appears while the Swarmterm window is **unfocused** — it's sent silent, since the chime is already the audible part; focus the window and you get the chime alone. macOS asks for notification permission the first time a banner would show, and declining it still leaves the chime working.

Turn channels on or off in **Settings → Notifications**: **Sound** and **System notifications** apply everywhere, and a **per-agent** toggle below silences one CLI without touching the others — every agent with a state dot gets a row, and all default to on. A plain Terminal pane has no agent state, but once its shell has **shell integration** set up (see below) it chimes the same way when a command that ran for more than 10 seconds finishes while you were elsewhere — the banner reads "Command finished (42s)" or "Command failed (exit 1 · 42s)" — and the **Terminal** row in the per-agent list turns that off.

### Notification center

The **bell** in the title bar keeps a list of what happened while you looked elsewhere, across every workspace: a pane that needs your input, an agent that finished, a long command that finished, a pane whose process exited (with its exit code), and a War Room message held for a pane. The red counter shows unread entries. Click an entry to jump to its pane — Swarmterm switches workspace or brings the pane back from the drawer — and the entry is marked read. Looking at a pane marks its entries read as well; a held War Room message resolves itself once it is delivered. Repeated events of the same pane collapse into one entry. **Mark all read** and **Clear** sit at the top of the list. The bell also reports app problems that belong to no pane — the MCP server stopped, voice input failed (marked read again once it recovers), or a pane stopped reading input so typed or pasted text was dropped. These entries show the reason; clicking one only marks it read.

The list records independently of the sound and banner settings above, so muting chimes keeps the history. It lasts for the app session and is not saved on quit. Entries of a closed pane stay visible but can no longer be opened.

## Launch modes

Claude Code and Codex panes run in a **launch mode** that sets how much the agent may do without asking. The current mode is shown next to the agent icon, and the agent menu in the pane header switches it: the pane restarts the CLI with the new flags and continues the conversation (the pane's own session id or the folder's latest session). **Resume previous chat…** in the same menu restarts the pane into the CLI's own session picker (current mode kept), so an older conversation can be taken over.

**Settings → Terminal → Default launch mode** picks, per provider, the mode new panes start in. It applies to new panes only — running panes keep the mode they started with. Worker panes spawned by an agent (`worktree.spawn`) inherit the spawning pane's mode when they run the same agent.

### Claude Code

A Claude Code pane starts in **Default** (`--permission-mode default`, Claude asks before edits and commands). The menu also offers **Accept edits** (`--permission-mode acceptEdits`), **Plan** (`--permission-mode plan`), **Auto** (`--permission-mode auto`, a classifier approves safe actions and blocks risky ones) and **Bypass permissions** (`--dangerously-skip-permissions`). Earlier versions always started Claude with bypass; choose **Bypass permissions** as the default launch mode to keep that behaviour.

### Codex

A Codex pane starts in **Auto** (`-s workspace-write -a on-request`). The agent menu in the pane header also offers **Safe** (`-s read-only -a on-request`) and **YOLO** (`--dangerously-bypass-approvals-and-sandbox`); switching continues the conversation via `codex resume`. Plan mode is not a Codex CLI flag — use `/plan` inside the session.

## Resume past agent sessions

Picking a working folder also lists that folder's recent Claude Code, Codex, OpenCode and Qwen Code sessions, read from each CLI's own history (never modified). Tick any of them — each reopens as an extra pane, right where the conversation left off. Tabs filter by agent, and "Show all" opens a searchable dialog over the full list.

## Saved workspaces

Workspaces save automatically as you change their layout, name, agents, shells,
folders or launch modes. Welcome shows up to 24 **Saved workspaces** above Recent.
Open a card to restore its split sizes and panes; opening an already running
workspace brings it into focus. Rename changes its saved name. Forget removes
the card and stops saving that open instance; its terminals keep running.

**Open on startup:** pin a card (pin icon), choose **Open on startup** in an
open workspace's **⋯** menu in the navbar, or tick it under **Settings →
Workspaces → Open on startup** to open it automatically every time Swarmterm
starts. Tick **Open new workspaces on startup by default** in the same place
to pin every newly created workspace automatically (existing ones are not
changed). They open in the navbar, in the order set there, with agents resuming their
sessions. While at least one workspace opens on startup, Welcome is skipped;
**New workspace** still brings it up. If none of them can be opened, Welcome
appears with the reason. Startup workspaces are never pushed out of the
saved list by newer ones.

Claude Code and Codex session hooks record each pane's exact conversation,
including when several panes share a folder. For Codex, review and trust the
Swarmterm hooks in **`/hooks`**, then send a message so its session is recorded.
Hook-capable Codex panes run with their own process environment. Older CLIs or
disabled or untrusted hooks still save the layout, but cannot record new
conversations. Existing user hook definitions and trust settings are preserved.
See the [Codex hook documentation](https://learn.chatgpt.com/docs/hooks).

A missing working folder stops reopening and shows a notice. A missing pane or
worktree folder falls back to the working folder with a fresh session. A missing
conversation starts the same agent fresh; an unavailable agent opens a plain
terminal. An unavailable shell uses the default shell. These fallbacks are shown
in a notice. Saved data stays on this computer; terminal output, prompts, file
tabs and unsaved editor buffers are not saved. Closing the window hides it to
the tray; use **Quit** to test a full app restart.

## Worktree isolation

With the composer toggle on, every agent pane is created **inside its own worktree** at `<repo>.worktrees/<name>` on a fresh `swarm/<agent>-<n>` branch — separate diffs from the very first edit. Plain Terminal panes stay at the repo root; a folder that isn't a git repository yet is initialised with a first commit for you. Worktree panes carry a 🌿 badge.

Two rules protect your work: closing a pane or workspace **never deletes a worktree**, and a worktree with **uncommitted changes cannot be removed** — not by you, not by an agent. Once a branch is merged, clean up with **Clear worktree** in the pane menu or let an agent do it.

## The Git panel

The **Git** tab in the right panel shows, for the focused pane: its worktree and branch (and which agent owns each branch), changed files with an inline diff, and how many commits it is ahead of the main line. It follows your focus between panes and refreshes itself when an agent working in that worktree finishes, pauses for input, or exits (a command typed by hand in a plain Terminal pane counts too once that shell has **shell integration** set up — see below; otherwise use the ↻ button). For a worktree branch, a footer line also tells you whether it **merges cleanly into the main branch** or lists the conflicting files, plus how many commits it is behind — a dry run that never touches your files (needs git ≥ 2.38).

## Web preview

The **Preview** tab is a browser column docked beside the terminals, with a real address bar and working back/forward/reload.

- **Each terminal keeps its own page** and the preview follows your focus; an agent in a background pane updates its own preview without stealing the one you're looking at.
- Type into the address bar yourself — `localhost:3000` opens as a page, free text becomes a Google search.
- **Sites that refuse to be embedded render anyway** — GitHub, Google, most SaaS dashboards.
- Popups and `window.open` navigate the preview in place (press Back to return); the pop-out button breaks the page out into a real OS window.

## War Room

Drag a pane by its header onto the right panel and the agent joins the room, receiving a short introduction to who else is there. The tab strip holds multiple rooms — `+` adds, double-click renames, `✕` deletes (two-step confirm; the last room stays) — each with its own transcript, members and moderator seat. **A pane belongs to at most one room**; dragging it onto another room's tab moves it.

Agents talk in two modes:

- **Probe** — lands in the peer's inbox and nudges it to read: questions, debate, coordination.
- **Execute** — pasted into the peer's terminal and run as its next prompt: a handover ("we agreed, now do it"). Refused if the target is a plain shell.

You are a member too — the **Moderator**. The composer at the bottom of the Discussion tab sends to one agent or the whole room, in either mode; replies land in the transcript instead of someone's terminal.

Deliveries never interrupt you: if the target pane has a half-typed — or pasted but not yet sent — command, the message is **held** — a pill in the pane, `⏸N` on the room tab — retries by itself once the pane is free, and "Deliver now" releases it immediately. The same hold applies while the agent is still working or is waiting on a permission/question prompt (so a delivery can never answer a prompt for you); those holds release on their own once the agent is idle and have no "Deliver now". Held messages are never dropped.

No setup is needed: Claude Code, Codex, OpenCode and Qwen Code panes connect to Swarmterm when the agent starts, so a dragged-in agent is ready immediately. Each member chip — and a dot in the pane header — shows **connected**, **waiting** (the agent is still starting) or an error with the reason when the pane has not reached Swarmterm after 15 seconds, for example a plain shell, an agent Swarmterm cannot configure, or a switched-off profile in **Settings → MCP**. An agent can re-read messages it already consumed with `war_room.read_inbox` and `includeRead`. A message is limited to 64k characters. An unread inbox keeps at most 200 messages; if more arrive, the oldest are dropped and the next `read_inbox` says how many were lost.

Drag a member chip out (or press its `✕`) and the agent instantly loses access. Closing a pane removes it automatically — and so does restarting one (switching its agent, shell or folder); just drag it back in.

A full walkthrough — Claude Code and Codex negotiating an API contract — is in [`war-room-demo.md`](war-room-demo.md).

## Status line in Claude Code panes

Every Claude Code pane gets a one-line readout under its prompt:

```
mcp ✓  ·  ctx 84k/200k 42%
```

The left half tells you whether Claude actually connected to Swarmterm — and therefore has the War Room and worktree tools: `✓` connected, `…` never reached Swarmterm (tools missing), `✗` Swarmterm no longer answering. The right half is the session's context window — tokens used, limit, percentage — amber past 70 %, red past 90 %.

Toggle it in **Settings → Terminal**. Swarmterm merge-writes the entry into `~/.claude/settings.json` and never touches a status line you already have.

The pane header mirrors the percentage as a small `ctx 63%` chip (same amber / red bands) once the first reply lands, so you can compare panes without reading each status line. It needs the status line enabled — that is where the number comes from — and disappears on `/clear` and when `claude` exits; on very narrow panes it moves into the header's `⋯` row.

## Voice dictation

A local dictation app (buzzkey) can type what you say straight into Swarmterm. Start dictating while a pane has the keyboard; the text lands in **that** pane even if you click another one while it transcribes.

- Dictation arrives as a **draft**: it sits in the prompt and is never sent on its own. In a plain shell, line breaks and tabs become spaces, so nothing runs or completes.
- A pane that waits for a permission answer gets nothing — dictation must never answer a prompt for you. If the pane was closed or restarted, the text is not redirected anywhere else. Either way the notification bell says why, and buzzkey keeps the text on the clipboard.
- With Settings, Welcome, the file editor, a search field or any dialog holding the keyboard, Swarmterm refuses rather than guesses.
- **Talk to a pane by name or number:** start the dictation with "Pane 2: …" or "Pane Backend: …" (also "An Backend: …") and the text goes to that pane of the workspace in front, whichever pane has the keyboard. Numbers can be spoken as digits or words ("zwei", "two"). Your own pane names are matched first, then the titles. Names you gave are reliable; titles are not, since a program can set its own — a name that another pane also carries as its title is refused. While a pane is maximized, only that pane can be addressed. If a name fits more than one pane, or no pane, nothing is typed — Swarmterm never picks one for you — and buzzkey keeps the text on the clipboard. End the dictation with "… senden" (or "… send") to press Enter after the draft — only with **auto-Enter** allowed in Settings → Voice, in agent panes only and only if you did not type there meanwhile; plain shells always get a draft. Needs a buzzkey version that supports addressing.

While you speak, the target pane shows a **Listening…** pill. Its **Stop** button (also reachable with Tab) throws the dictation away; buzzkey's own hotkey works as before. The pill disappears when the text arrives, when you cancel, when the pane closes or restarts, and after two minutes at the latest. Older buzzkey versions dictate without the pill.

**Announce finished agents** (Settings → Voice, off by default) lets the dictation app tell you when an agent finishes or waits for your input, using the same rules as the bell: nothing for the pane you are looking at, and nothing if the fact resolved itself within a second. Only the pane title (as in its header; agents such as Claude Code set it to the topic of the conversation), the agent and the status are sent; output from the pane never leaves Swarmterm.

**Speak announcements** (Settings → Voice, off by default) lets Swarmterm say the same facts itself — "Backend: fertig." or "Backend wartet auf Eingabe." — with a voice installed in Windows (Settings → Time & language → Speech; German voices such as Hedda come with the German language pack). It works without buzzkey. Pick the voice and volume there; **Test voice** plays a sample. English voices say "Backend is done." instead. Paths and URLs in the pane title are left out.

- An announcement stops as soon as you type, focus the pane it is about, start a dictation, or press **Ctrl+Shift+M**. Swarmterm never speaks while a dictation records or transcribes — so it never dictates its own voice — and what came in meanwhile is dropped, not read out later. Announcements older than ten seconds are dropped too; at most three wait in line, and a newer one for the same pane replaces the older.
- When Swarmterm speaks, buzzkey's own announcement voice stays quiet for that event; buzzkey only fills in (if you enabled its fallback voice) when Swarmterm does not speak.

**Allow excerpts** (Settings → Voice, off by default, needs **Speak announcements**): after each Claude Code turn Swarmterm says the agent's reply instead of just "fertig" — for example "Backend: Ich habe den Login-Test repariert, alle Tests laufen. Soll ich committen?" — also for the pane you are looking at. To make that possible, Claude is asked to end every answer with a short line `<voice>…</voice>`; you see that line in the terminal, and it costs a few tokens per turn. Without the line Swarmterm quotes the first one or two sentences of the answer as "Backend schreibt: …"; with nothing speakable it says the plain status. A turn that failed is said as "Backend: Da ist leider etwas schiefgegangen, ich bin nicht fertig geworden.", a turn you stopped with Esc as "Backend: Alles klar, ich habe aufgehört."; both also land in the bell. The same stop rules apply (typing, focusing another pane, dictating, **Ctrl+Shift+M**), and a reply never talks over another announcement. Replies currently work for Claude Code; Codex and OpenCode get the status only.

#### What is read

This is the contract for **Allow excerpts**:

- **Read:** only with the setting on, only for a Claude Code turn Swarmterm saw start, and only that turn's final answer — or, when the turn went idle without finishing, whether its last entry is Claude Code's "interrupted by user" marker. Swarmterm reads it from the agent's own session file (`projects/…/<session>.jsonl` in the pane's Claude config folder; the last 2 MiB of it, for at most 200 ms) and checks that it is exactly the answer Claude Code reported when it stopped.
- **Sent to Claude:** only a fixed instruction asking for the `<voice>` line, on each prompt while the setting is on. Nothing from your prompt or the answer.
- **Never read:** tool output, thinking, your prompts, subagent conversations, other files, or any file outside the Claude config folder (links pointing out of it are refused).
- **Never spoken:** code, tables, paths, file names, links, hashes and shell lines — also not inside the `<voice>` line. A sentence containing one is skipped whole; at most 300 characters are spoken.
- **Kept:** only the line to be spoken, in memory, until it is said (at most ten seconds in the queue) or the pane's next prompt, a restart, or switching the setting off. It is never written to disk or a log, and never sent to buzzkey, the War Room or any agent. buzzkey's status feed is unchanged: it gets "done" and "needs input" of panes you are not watching, never a reply, error or interruption.
- **Nothing is read** when the setting is off, for panes that were already running when Swarmterm started (until their next prompt), when Claude Code continued after a Stop hook, or when the answer is not in the file in time. In those cases only the status is announced.

**Settings → Voice** turns the endpoint on or off and can allow auto-Enter (off by default; never in plain shells, and only if you did not touch the prompt in the meantime). Only apps running as your Windows user can connect: Swarmterm opens a named pipe restricted to your account and writes its name and a fresh per-launch key to `%LOCALAPPDATA%\<app id>\voice-endpoint.json`.

### Installing buzzkey from Swarmterm

**Settings → Voice → buzzkey** shows whether buzzkey is installed, running or connected (with its version) and offers the next step: **Install buzzkey**, **Start**, **Quit**, **Check for update**, **Start buzzkey with Windows** and **Update buzzkey automatically**. Installing is always a click; the only background access is the update check below.

- Downloads come only from buzzkey's GitHub releases. Swarmterm first checks the release's signature against a key built into Swarmterm, then each file against the signed checksums, and only then installs into `%LOCALAPPDATA%\Programs\buzzkey` (no admin rights). A release that fails any check installs nothing; an update that fails half-way keeps the previous version.
- buzzkey stays its own program with its own tray icon. **Quit** asks it to close itself; older buzzkey versions are quit from their tray menu instead. Swarmterm never kills it.
- While the original whisper-key runs, Swarmterm offers nothing: both would fight over the hotkey and the microphone.
- The autostart switch is the same entry as buzzkey's own tray setting. To uninstall, quit buzzkey, turn autostart off and delete the folder.
- **Update notice.** While buzzkey is installed and connected, Swarmterm looks for a newer signed buzzkey release about 20 seconds after start and then once a day. A newer one shows a notice in the bottom right: **Update now** runs the same verified install (buzzkey is asked to quit and started again), **Later** hides it until the *next* version. Without a connection or on a network error nothing is shown.
- **Update buzzkey automatically** (in the notice and in Settings, off by default) installs new versions without asking, but never while a dictation is recording or transcribing — the update then waits a minute and tries again. A major new version (for example 1.x → 2.0) is always asked first, once; **Later** silences that version too.
- Once installed, buzzkey's hardware check (if the version has one) suggests a model; buzzkey makes the final choice on first start.

### Built-in speech recognition

Swarmterm can also dictate on its own, without buzzkey. Under **Settings → Voice → Built-in speech recognition**, download a Whisper model once (**Base**, 142 MB, is the recommended choice; **Small** is more accurate and about three times slower) and switch **Enable built-in speech** on. Only downloaded models can be selected; a model you download here is selected once it is on disk. A model is checked against a fixed checksum before it is used and stays in `%LOCALAPPDATA%\<app id>\models`; **Delete** removes it again. Recognition runs locally on the CPU — no audio leaves your computer.

Click into a pane and press **Ctrl+Shift+Space** (or the microphone in the pane header), speak, then press it again. The pane shows **Listening…** while you speak and **Transcribing…** while Whisper works (about a second for a short sentence with Base); the text then lands in that pane as a draft, exactly like buzzkey's, even if you clicked elsewhere meanwhile. The pill's **Stop** discards the dictation. Built-in speech never presses Enter. **Language** defaults to automatic detection; pinning it helps with very short phrases. Windows must allow desktop apps to use the microphone (Settings → Privacy & security → Microphone). If nothing arrives, the bell says why (no microphone, no speech recognised, model missing, …).

## Terminal essentials

- **Real PTYs with 24-bit truecolor** — agent CLIs, emoji and box drawing render exactly as in your normal terminal, and IMEs (Vietnamese Telex, CJK) work without dropped characters.
- `⌘/Ctrl + C` copies when text is selected and otherwise interrupts; `⌘/Ctrl + V` pastes — like VS Code.
- `Shift + Enter` in an agent pane (Claude Code, Codex, OpenCode, …) starts a new line in the prompt instead of sending it; plain shells treat it as Enter.
- **Paste a screenshot** into a Claude Code or Codex pane with `Ctrl + V`: when the clipboard holds an image and no text, Swarmterm saves it as a PNG under your temp folder (`%TEMP%\swarmterm-paste`, pruned after a day) and pastes its path, which the agent attaches as an image. Other panes paste text only.
- **Programs can copy to your clipboard** — nvim `"+y`, tmux `set -s set-clipboard on`, yazi and `gh` copy through OSC 52, exactly as in VS Code's terminal. Only writes are honoured: a program can never read your clipboard.
- **Click a URL** to open it in your browser; `⌘/Ctrl + click` a file path (`src/foo.ts:42:9`, `src/foo.ts(42,9)`, `File "x.py", line 42`) to open project files in the integrated editor at that line; the file is also selected in **Files**, with its folders expanded and the row scrolled into view. Hold `⌘/Ctrl` on a detected path and drag it onto another pane to insert it there (as a path, or an `@` mention in Claude Code). Paths outside the configured project retain the external-editor behavior.
- **Drop a file or folder** onto a pane — from your OS file manager or from **Files** (several selected entries at once) — to insert its path, quoted for that pane's shell. While dragging from **Files** a label follows the pointer and the cursor shows what a release does: insert into a terminal, move into a folder (hold `Ctrl` to copy), or nothing; `Esc` cancels. Dragged from **Files** onto a Claude Code pane, entries become `@` mentions relative to the pane's folder (`@src/foo.ts`), so Claude attaches them; paths with spaces stay quoted.
- **Zoom the text with `Ctrl` + mouse wheel** over a terminal (shell or agent CLI): scroll up for bigger, down for smaller (8–32 px). Settings → Terminal → *Ctrl + scroll zoom* picks whether only the pane under the mouse changes (default; the pane keeps its zoom on top of the global size until the app restarts), all panes change (moves the global *Size*, saved), or nothing. `Ctrl + 0` in the focused pane resets the zoom (global mode: back to 13 px).
- **Scrollback** (Settings → Terminal) sets how many lines each pane keeps (default 5,000). Memory grows with it in every pane: roughly 12 bytes per cell, so 5,000 lines of a 200-column pane are about 12 MB and the maximum of 50,000 about 120 MB. Lowering it trims every open pane at once.
- **GPU rendering follows visibility.** A pane draws with WebGL only while it is on screen; panes in hidden workspaces, in the drawer or behind a zoomed pane release their GPU context and texture cache, and get it back when shown. At most 12 panes hold one at a time; past that, the pane shown or focused longest ago falls back to the slower DOM renderer until it is hidden and shown again.
- **Choose your shell** — PowerShell, cmd, PowerShell 7 or Git Bash — per pane, or as a default in Settings.

## Shell integration

A plain Terminal pane has no agent, so Swarmterm cannot tell when a command you typed has finished — unless your shell says so. If it emits the standard **OSC 133** prompt marks (the same ones VS Code, WezTerm, Ghostty, kitty and Windows Terminal read), Swarmterm follows each command from prompt to exit and uses that to refresh the **Git panel** when a command finishes inside the selected worktree — a hand-typed `git commit` shows up just like an agent's — and to notify you when a command that ran for more than 10 seconds finishes in a pane you weren't watching (see §Notifications). Nothing is injected into your shell: add the snippet for yours, guarded so it only runs inside Swarmterm (`SWARMTERM_SESSION` is set in every pane). If you already use another terminal's shell integration that emits these marks, there is nothing to add.

**zsh** (`~/.zshrc`)

```zsh
if [[ -n $SWARMTERM_SESSION ]]; then
  __swarmterm_precmd()  { printf '\033]133;D;%s\a\033]133;A\a' "$?"; }
  __swarmterm_preexec() { printf '\033]133;C\a'; }
  precmd_functions+=(__swarmterm_precmd)
  preexec_functions+=(__swarmterm_preexec)
fi
```

**bash** (`~/.bashrc`; bash ≥ 4.4 for `PS0`)

```bash
if [[ -n $SWARMTERM_SESSION ]]; then
  __swarmterm_prompt() { printf '\033]133;D;%s\a\033]133;A\a' "$?"; }
  PROMPT_COMMAND="__swarmterm_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
  PS0='\[\e]133;C\a\]'"$PS0"
fi
```

**fish** (`~/.config/fish/config.fish`)

```fish
if set -q SWARMTERM_SESSION
    function __swarmterm_prompt --on-event fish_prompt
        printf '\e]133;A\a'
    end
    function __swarmterm_preexec --on-event fish_preexec
        printf '\e]133;C\a'
    end
    function __swarmterm_postexec --on-event fish_postexec
        printf '\e]133;D;%s\a' $status
    end
end
```

**PowerShell 7** (`$PROFILE`; the least-tested of the four — `cmd.exe` has no equivalent)

```powershell
if ($env:SWARMTERM_SESSION) {
  $global:__swarmtermPrompt = $function:prompt
  function global:prompt {
    $code = [int](-not $?)
    "$([char]27)]133;D;$code`a$([char]27)]133;A`a" + (& $global:__swarmtermPrompt)
  }
  Set-PSReadLineKeyHandler -Key Enter -ScriptBlock {
    [Console]::Write("$([char]27)]133;C`a")
    [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
  }
}
```

The marks are `A` (prompt drawn), `C` (command started) and `D;<exit>` (command ended); `B` (end of prompt) is optional and omitted above. The very first prompt's `D` is ignored, and a machine you `ssh` into without the snippet simply sends nothing until you are back.

## Settings, tray and quitting

**Settings** (from the navbar) covers appearance, terminal font and default shell with a live preview, the status line toggle, and the full shortcut list — these preferences persist between launches.

**Closing the window hides Swarmterm to the tray** and everything keeps running; tray → **Quit** is what actually exits. Launching a second copy just focuses the window you already have. On Windows, closing a pane kills the entire process tree it started — no orphaned build servers.

**Terminal host (preview).** Settings → Terminal → **Run new panes in the terminal host** starts new panes in a separate background process, `swarmterm-host.exe`, instead of inside Swarmterm. It is off by default. Panes that are already open keep running where they started, so you can switch at any time. If the host cannot be started, new panes open inside Swarmterm as before and the setting shows why. The installer does not include `swarmterm-host.exe` yet, so in installed versions the setting reports *terminal host not found*; it works in source builds after `cargo build -p swarmterm-host`.

Hosted panes outlive Swarmterm itself: if the app crashes or is ended from Task Manager, the programs in them keep running. Open the saved workspace again (workspaces set to open on startup do so by themselves) and its panes are taken over where they are, instead of starting again: the output so far is shown again, a full-screen program such as Claude Code repaints, and an agent keeps its Swarmterm connection. A dim line *older output is not available* marks a pane whose history was longer than the host keeps (512 KiB per pane). Running panes that no saved workspace knows are closed shortly after startup; forgetting a saved workspace closes its running panes too. If you switch the host off before starting Swarmterm again, the panes it still runs are closed at startup. Pane ids are stored with saved workspaces only while the host is on. **Quit** in the tray still closes every pane; the idle host then exits on its own after ten minutes.

## Updates

Swarmterm GN disables the upstream updater, including its tray entry, endpoint
and update artifacts. Install new versions from this fork's GitHub Releases, or rebuild from its `main` branch (the latest release).
Upstream Swarmterm releases do not contain the GN additions.

## Telemetry

Official release builds send an anonymous usage ping so we can see how many
people actually run Swarmterm: one `app_open` event at launch, then a
heartbeat every five minutes while the app is open. Each event carries a
random id, the app version and the OS name (`macos` / `windows` / `linux`) —
nothing else. No paths, no terminal content, no hostname, no account.
Google Analytics infers a country from the request's IP, as any website does;
Swarmterm never sends the IP itself.

The random id lives in one small file so restarts count as the same person —
`~/Library/Application Support/com.swarmterm.app/telemetry-id` on macOS,
`%APPDATA%\com.swarmterm.app\telemetry-id` on Windows,
`~/.config/com.swarmterm.app/telemetry-id` on Linux. Delete it any time to
start over as a new anonymous user.

**Builds from source contain no telemetry at all.** The analytics keys are
injected only when official releases are built; compile Swarmterm yourself
(`npm run tauri dev` or `npm run tauri build`) and the reporting code
compiles to nothing. Offline use is fine too — a failed ping is silently
dropped, never retried loudly, and never blocks the app.

## What your agents can do

Every pane is automatically connected to the app over MCP for exactly as long as it lives — nothing to configure for Claude Code, Codex and Qwen Code, which Swarmterm enrolls automatically; other MCP-capable CLIs can be pointed at the per-pane URL by hand (the War Room panel shows the hint). Enrolled agents can drive Swarmterm themselves: **open a web preview** beside their own pane, **spawn / list / remove worktrees** to hand tasks to fresh parallel agents (removal refuses uncommitted changes), and use the **War Room** — list peers, message them in probe or execute mode, read their inbox and reply, wait for a peer to need input or finish (`wait_peer`) and peek at what its screen shows (`read_peer`). An execute hand-off to a peer that is sitting on a prompt is refused until that prompt is answered — the sender is told to wait first.

War Room abilities only work for panes you dragged into a room, worktree abilities only in workspaces with isolation enabled — and removing a pane from a room revokes its access instantly.

## Swarmterm MCP

The top of **Settings → MCP** has one switch per agent and account for Swarmterm's own server (War Room, browser and worktree tools). On is the default. Off removes only Swarmterm's entry from that profile's configuration and keeps it from being written again; restart running panes afterwards. A server of your own that happens to be called `swarmterm` is never changed. **Details** shows the configuration file and the server address.

## MCP catalogue

Open **Settings > MCP** and choose a Default account or a named Claude Code or Codex profile. The catalogue offers Playwright, GitHub, Context7, Filesystem, Memory, Sequential Thinking and Fetch. Each entry links to its official documentation and lists its requirements.

Choose **Add configuration** to add the server to that account's CLI configuration. Start a new pane using the account to load it. **Configured** means the definition is present; check the agent CLI to confirm connectivity. A different existing definition appears as **Existing configuration** and remains untouched. Use the agent CLI to change or remove existing servers.

For **Filesystem**, choose between one and sixteen existing absolute directories, or enter one directory per line. The server can read and write within those directories. Paths containing shell metacharacters are rejected. **Playwright** uses headless mode, so it does not open a browser window.

GitHub and Context7 authentication happens separately in the agent CLI. Swarmterm has no token fields and stores no MCP credentials. Adding a definition does not install or start a server. When the CLI first starts a local server, `npx` or `uvx` may download its package; install the listed runtime separately if it is missing.

## Keyboard shortcuts

Settings > Keyboard Shortcuts lists app actions and their current bindings.
Click a binding button and press a modifier chord to record a replacement.
Unbind removes it; Reset restores that action's default, and Reset all shortcuts
restores every default. Conflicts are rejected, including a reset whose default
is already used by another action. Escape cancels recording. Copy/paste, reload
and Windows close-window chords stay reserved. The table below shows defaults.

Custom actions combine up to 16 app-action steps and workspace recipes. Give an
action a name, add steps in order, save it, then run it or assign a shortcut.
A recipe accepts 1–12 comma-separated agent IDs (`terminal`, `claude-code`,
`codex`), an optional folder and Default or Auto accounts. Auto rotates each
CLI's profiles independently, including its default. An empty folder uses the
current workspace or composer folder. All recipe folders and agent availability
are checked before any workspace is created. Recipes store structure, not shell
commands, prompts, terminal output or credentials.

Bindings and up to 24 custom actions persist locally. Rebinding an app shortcut
releases its old chord to the terminal. Holding a chord does not repeat the app
action or send its control bytes to the shell. Editor actions apply only while
the file editor owns the keyboard.

| Shortcut | Action |
|---|---|
| `⌘/Ctrl + B` | Show or hide the sidebar |
| `⌘/Ctrl + Shift + E` | Open and focus the Files tree |
| `⌘/Ctrl + S` | Save the focused file |
| `⌘/Ctrl + Shift + V` | Cycle Editor / Split / Preview (Markdown, SVG, HTML) |
| `⌘/Ctrl + Shift + B` | Toggle broadcast input |
| `Alt + Click` | Add or remove a pane from the broadcast group |
| `Esc` | Leave broadcast mode · close Settings |
| `⌘/Ctrl + Enter` | Create the workspace from the composer |
| `⌘/Ctrl + C` · `⌘/Ctrl + V` | Copy (when text is selected) · paste |
| `⌘/Ctrl + Click` | Open a file path in your editor, at that line, and select it in Files |
| `⌘/Ctrl + F` | Find in the focused editor/Markdown preview or terminal |
| `⌘/Ctrl + Shift + Enter` | Maximize / restore the focused pane (also the header button or a double-click on the header). Hidden panes keep running; focusing one from the sidebar restores the layout. While maximized the pane header gets a violet bottom border, the restore button turns violet and shows how many panes are hidden (`+N`), and the sidebar marks the maximized row (violet edge and icon), dims the hidden rows (crossed-out eye; their status dots stay bright) and shows a *Maximized* badge on the Terminals heading |
| `⌘/Ctrl + Shift + D` | Move the focused pane to the drawer (keeps running; click it in the sidebar to restore) |
| `⌘/Ctrl + Shift + Space` | Start / stop a dictation with built-in speech recognition (only while it is enabled; without its model on disk the bell says so) |
| `⌘/Ctrl + Shift + Backspace` | Clear the pending input line of the focused terminal (e.g. after a submit hook refused a prompt). Agents get one Ctrl+C, shells their line-kill; a second press within 2 s is ignored so an agent never quits |
| `Ctrl + mouse wheel` | Zoom the terminal text (pane under the mouse or all panes, see Settings → Terminal) |
| `⌘/Ctrl + 0` | Reset the terminal text zoom (not claimed while wheel zoom is off) |
| `⌘/Ctrl + Shift + J` | Jump to the next pane needing attention (longest-waiting blocked → done → working → idle) |

On macOS the modifier is `⌘`, which deliberately leaves `Ctrl + B` to the terminal for tmux.

## Troubleshooting

- **An agent is missing from the composer** — its CLI isn't on your `PATH`; install it and reopen the composer. A default or template that assigns it uses those slots for plain terminals meanwhile, and picks the agent up again once it's installed — unless you edit and save that default or template before then.
- **A War Room message never arrived** — look for the pill in the pane or `⏸N` on the room tab: it's held behind an unsubmitted prompt line, or the agent is working / sitting on a prompt (the pill says which). Press Enter or click "Deliver now" for a typing hold; answer the prompt or wait for the agent to finish otherwise.
- **An agent says its execute was refused** — the target pane is blocked on a permission or question; answer that prompt (or let the sending agent `wait_peer`) and the hand-off goes through on re-send.
- **A War Room send was refused for a "control character"** — the message contained an escape code or other terminal control byte, which Swarmterm never types into a pane (it could break out of the paste and run as keystrokes). Resend as plain text; quote escape sequences as the literal text `ESC[…` instead.
- **An agent says it isn't in the War Room** — its pane was removed or restarted; drag it back in.
- **A relative path isn't clickable after `cd`** — a PowerShell quirk; absolute paths (everything agents print) still work.
- **The app disappeared** — it's in the tray; click the icon to bring it back.

## Known limits

- **Terminal output, previews and unsaved editor buffers are transient.** Saved workspaces restore the pane layout and known agent conversations; they do not restore every running process or open file tab.
- **Eight visual styles** — VS Code Dark Modern plus all seven Astera themes; terminal fonts remain a separate preference.
- **War Room membership doesn't survive a pane restart** — re-drag the pane.
- **The preview column has no devtools, zoom, tabs, or per-terminal cookie isolation**, and a failed page shows the platform's own error view.
- **Terminal search covers the visible scrollback only** — matches beyond xterm's own buffer, and search-and-replace, aren't available.
- **Windows x64 only** — this fork does not support macOS or Linux releases.
- **Claude Code hooks are written at every launch** — the `swarmterm --hook` entries in `~/.claude/settings.json` are re-checked on each boot (no write when nothing changed; your own hooks are left alone). The installed app always points them (and the status line) at itself, which also repairs entries left by a moved or deleted Swarmterm binary — if every Claude Code tool call reports `swarmterm.exe: No such file or directory`, restart Swarmterm and then the Claude sessions. A development build (`npm run tauri dev`) never takes these entries over from an installed Swarmterm that still exists.
- **`claude` started by hand in a plain Terminal pane gets no coloured dot or pane highlight** — only panes created as Claude Code agents are wired to the hooks.
- **After Esc (interrupt) a Claude Code pane can read "working" for up to 30 s** — Claude fires no Stop hook on an interrupt, so the working signal has to time out before screen reading takes over again.
- **Find widget with regex on shows "Invalid regex" while you type** — a pattern that does not parse yet (for example `foo(`) reads **Invalid regex** in the counter and clears the previous highlights until the pattern is valid again. Toggle regex off to search it as literal text.
- **Any program in any pane can overwrite the clipboard via OSC 52** — like VS Code, there is no per-pane gate. Reads are refused and empty writes never clear it; copies larger than 1 MiB are ignored.
- **Shell integration is opt-in** — a hand-typed command in a plain Terminal pane is only noticed if that shell emits OSC 133 marks (§Shell integration). Nothing is injected, `cmd.exe` cannot do it, and an interrupted command that redraws the prompt without a `D` mark is simply forgotten.
- **The explorer's root folder can't be renamed while its tree is open** — live refresh holds one handle on the root (and the repo's `.git` metadata), and Windows refuses to rename a folder with an open handle. Everything below the root renames and moves freely. Close the explorer for that root (or quit from the tray) to rename the root itself. During very heavy churn (a large `npm install`) the tree re-reads its open folders once things go quiet, because Windows may drop individual change events.
- **Built-in speech recognition runs on the CPU only** — no GPU acceleration yet; larger models (Small, Large v3 Turbo) take several seconds per sentence. One dictation runs at a time, and a recording stops after two minutes.
- **Hosted panes survive a crash, not a quit** — Quit still closes every pane, and if the host process itself ends, its panes end like an exited shell. Only panes of saved workspaces can be taken over; a running pane of a saved workspace that does not open on startup keeps running unseen until you open that workspace.
- **What a taken-over pane loses** — its War Room membership (drag it in again) and a dictation that was in progress. If another program took Swarmterm's previous connection port in the meantime, the agent in it shows `mcp offline` until it restarts — and keeps sending its pane token to that program, which could use it to act as that pane toward Swarmterm. Only a program running under your own account can do this.
- **Claude Code's cursor can lag after a resize** — Claude draws its own cursor block and only redraws it on the next keystroke, so right after dragging a window or pane edge the old block may stay visible. Output and prompt are correct; press any key to refresh.

## Astera themes

Settings → Appearance includes Vega, Orion, Umbra, Aurora, Antares, Quasar and
Sirius from Astera, alongside the original VS Code Dark default. Each preview
uses its own palette. A theme also changes UI fonts, density, corners and shadows.
Switching themes keeps running shells and terminal scrollback intact. Terminal
font preferences remain separate.


## Account profiles

Open **Settings > Accounts** to see every login at a glance, grouped by agent. Each card shows a status light (green connected, yellow login expired, red not logged in, grey not checked yet), the subscription plan, and the 5-hour and 7-day budget **still available** with a small bar; hover for reset time and how old the number is. Claude Code reports its budget through the Swarmterm status line while one of its panes runs; Codex's is read from its own session logs, again whenever a Codex pane finishes a turn and every minute while the panel is open. The last numbers are kept across restarts; once they are older than a few minutes the card says so ("usage 2 h ago"), and a window whose reset time has passed is dropped. If you use your own Claude Code status line, Swarmterm only sees the budget when that script forwards it to `/status` the way `swarmterm --statusline` does. Swarmterm reads only plan and login state from the CLI's files — tokens never leave them.

Choose **Add account**, pick Claude Code or Codex, confirm the suggested name (a dedicated configuration folder is optional under **Advanced**; blank creates an isolated one), then **Continue & log in**. A terminal opens with the CLI's own login; once it finishes the card turns green. The **⋯** menu on a card offers log in again, rename, show folder and remove. The **Default** account uses the CLI's existing configuration.

A named Claude Code profile has its own configuration folder, so Swarmterm carries two things over from the Default account each time a pane starts with that profile: your own status line (if Default uses one that is not Swarmterm's) and your user-level MCP servers. Both are only added, never overwritten: a status line you set for the profile itself stays, and so does a server the profile already defines under the same name. A server you remove only from the profile returns on the next pane start; remove it from Default as well.

Your hooks and your `permissions.deny` and `permissions.ask` rules come along the same way, so a guard or block you set up in Default also protects sessions under the profile. Swarmterm never copies `permissions.allow` or any other setting: a profile is never allowed more than Default. The profile's own hooks and rules stay untouched. If you change or remove a hook or rule in Default, the copy Swarmterm added to the profile follows on the next pane start. Sessions already running keep the hooks they started with.

Choose **Log in** to open a regular terminal pane running the CLI's own login command with that profile's configuration. Complete the normal login flow there. Swarmterm never asks for passwords or stores access tokens; credentials remain in the CLI's configuration files. CLI login flows may request that you visit a URL outside Swarmterm.

In the workspace composer, each supported agent has an account selector. Pick a fixed profile for every new pane of that agent, or choose **Round robin** to rotate through its Default account and named profiles independently of the other agents. The workspace keeps this choice: a pane split off later uses the fixed profile, or continues the rotation after the workspace's panes of that agent. With the Default account selected, a split pane takes the account of the pane it was split from, when both run the same agent. Saved workspaces keep the choice too. Resumed conversations keep the account that owns them. The sessions dialog can filter conversations by account.

Pane headers and the terminal list show account names. Changing the account from a pane header restarts that agent under the selected profile and carries the current conversation along (see Sessions across subscriptions). It starts a fresh conversation only when there is nothing to carry yet (no known session, or one that has not had a turn, such as a pane just split off) or the pane runs another agent than Claude Code or Codex. Saved workspaces retain each pane's profile and exact session reference together.

Removing a profile leaves its configuration folder and credentials on disk, and currently running panes keep running. If a saved workspace references a removed profile, restore reports the missing account and starts that pane fresh with the Default account; it never resumes the old account's conversation under another profile.

### Sessions across subscriptions

Each subscription keeps its own session history, so by default a conversation started under one subscription can't be resumed under another. There are two ways around that:

- **Switch a running pane.** Click the subscription label in a Claude Code or Codex pane's title bar and pick another subscription. The conversation is copied to that subscription and the pane resumes it there. Switch once the agent has finished its turn; while it is working or waiting for your answer, Swarmterm refuses and says why. The original copy stays where it was, so the two continue independently from then on. If the copy fails, the pane stays on its current subscription and the bell says why.
- **Open in when resuming.** In the composer's "Resume sessions" list (and the all-sessions dialog), a ticked Claude Code or Codex session shows an "Open in" choice. Pick another subscription, and the session is copied there before its pane starts.
- **Share everything (Claude Code).** Turn on **Settings > Accounts > Share Claude Code sessions between all subscriptions**, and optionally include the Default subscription. Every subscription then sees and can resume every session, including in Claude Code's own `/resume` list. Swarmterm merges each profile's session folders into one shared store and keeps each original next to it, renamed `projects.pre-share-…` / `file-history.pre-share-…`. Close that subscription's panes before switching the setting, because Windows won't move a folder that's in use. Turning it off gives every subscription a full copy of the shared store.

Codex sessions can only be copied one at a time. Codex may refuse a session from another OpenAI account; if it does, it reports the error in the pane.
