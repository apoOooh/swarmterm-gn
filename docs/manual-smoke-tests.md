# Manual smoke tests

Swarmterm GN supports Windows x64 only. Run the Windows checks here; retained
macOS/Linux notes describe upstream behavior and are outside GN support.

Run this by hand before a release, or after touching pty, focus, War Room or
worktree code. Start with `npm run tauri dev` (or `npm run tauri:dev:isolated`
when an installed Swarmterm is running — otherwise it swallows the launch).

A longer scripted War Room scenario lives in [`war-room-demo.md`](war-room-demo.md).

GN's automated browser tests are headless and mock native IPC. The following
platform checks require an intentional desktop launch and disposable test files.
Do not mark them passed from the in-memory fixture alone.

## Drag to split and snap layouts

- [ ] Two panes on top, one full-width below; drag a top pane's header onto the
      bottom pane → the picker appears; hover each side tile → the matching half
      is shaded; drop on **left** → the other top pane widens, the bottom slot
      is split side by side with the dragged pane on the left. Shells keep
      running (a `ping -t localhost` keeps counting).
- [ ] Drop on the picker's **Swap** centre → the two panes swap, layout shape
      unchanged.
- [ ] Two side-by-side panes: drag one → the snap bar shows **Side by side** and
      **Stacked**; drop on the bottom slot of **Stacked** → stacked, dragged pane
      at the bottom. With 3+ panes the bar also offers grid, main-left and
      main-top, and hovering a slot outlines the resulting layout.
- [ ] Maximize a pane with 3+ panes: header has a violet bottom border, violet
      restore button shows `+N` (floating panes counted, drawered ones not);
      sidebar marks the maximized row, dims the others with a crossed-out eye
      while their state dots stay bright, and the heading shows *Maximized*.
      Clicking a dimmed row ends the zoom and clears all markers.
- [ ] Snap/dock a zoomed pane (zoom ends), with a pane in the drawer (it stays
      parked and restores at the end), and drop a pane on a War Room tab while
      the bar is showing (still joins the room).

## Tidy layout

- [ ] Split a pane right, then split the new pane right again, so three panes
      sit in a row with the first at half width. Sidebar **⋮ → Tidy layout** →
      all three become equal thirds right away (the separators move, no
      shell restarts).
- [ ] In a 2×2 grid drag the separators to odd positions, then Tidy layout →
      rows and columns are even again. Entry is greyed out in a one-pane
      workspace.
- [ ] Tidy a workspace you are not looking at, then switch to it → already
      even. With a pane in the drawer or floating, Tidy sizes only the panes
      on screen; after restoring the pane, Tidy layout again evens out all.
- [ ] Zoom a pane, then Tidy layout → the zoom ends and the even layout shows.

## Corner resize and floating panes

- [ ] In a 2×2 grid, hover where the separators meet → a handle lights up;
      dragging it resizes width and height together.
- [ ] Float pane (header button) → the pane floats above the layout, its
      shell keeps running; the grip bar moves it, edges and bottom corners
      resize it.
- [ ] Drag the floating pane's header onto another pane's dock tile → it
      docks on that side. Float again, press the button → it returns to its
      original slot.
- [ ] Maximize another pane while one floats → the float hides; restore
      brings it back.

## Pane header overflow

- [ ] Split a Claude pane right three or four times until the panes are narrow:
      agent icon + mode, title (truncated), folder name, maximize and ✕ stay
      fully on screen in every header; a `⋯` button appears.
- [ ] Hover a narrow header: after a short pause a second row drops over the
      terminal with the hidden controls; moving the mouse into it keeps it open,
      leaving closes it. Widen the pane: `⋯` and the row disappear.
- [ ] From the dropped row open the shell menu and pick a shell, then split
      right: both work, the row stays up while the menu is open.
- [ ] Click `⋯`: the row stays open after the mouse leaves; clicking `⋯` again
      or elsewhere closes it. Typing in the terminal afterwards still works, and
      `Esc` in the terminal (e.g. vim) leaves the pinned row open.
- [ ] Dragging a narrow pane by its header still swaps/docks it; double-clicking
      bare header space still maximizes.
- [ ] Pane identity: hover a header, click the smiley left of the title, set
      name "Reviewer", the bug icon and a color, Enter. Header shows icon +
      **Reviewer** · agent title; the sidebar row shows the icon; the pane is
      not restarted. Right-click → Set identity… opens the same dialog; an emoji
      works, text in the emoji field is refused; Clear identity restores the
      plain title. Restart the app: the identity is kept.
- [ ] Identity dialog: pick a color and tick *Tint the top bar* — the preview
      and then the header bar take the color (bottom border full color); the
      checkbox is disabled with No color. Search icons for "arrow up": matches
      appear, Enter picks the first without saving the dialog; the chosen
      icon shows in the header, sidebar and after a restart. Scroll the grid
      to the end: icons appear as you scroll. Maximize the pane: the zoom
      border stays violet. Light and dark theme: header text stays readable.
      Clicking the bold identity name also opens the dialog.
- [ ] Composer: type a Name, create — the tab uses it (with its case); leave it
      blank — the tab is named after the folder.
- [ ] Open a file in the focused pane's editor, then rename a workspace (tab
      double-click and sidebar ⋯ → Rename): click into the field, Home/End,
      type "Alpha" and "alphA" — capitals at both ends stick, focus stays in the
      field until Enter.
- [ ] Settings → Title bar: mark Split right as Core — it stays in a narrow
      header; drag Shell to the bottom — it moves to the end of every header and
      is first to collapse. Restart the app: the layout is kept. Reset to
      defaults restores the original header.
- [ ] Settings → Title bar: set Float pane to "⋯ only" — even a wide header
      shows `⋯` and Float sits only in the hover row; set Handoff brief to
      "Off" — it is gone from the header and the hover row.

## Pane drawer

- [ ] In a 3-pane workspace run `ping -t localhost` in one pane, click its
      archive button: it vanishes, the others fill the gap, it is listed under
      Drawer in the sidebar and the workspace row shows the archive count.
- [ ] Wait, click the drawer row: the pane returns to the same slot and size,
      the ping kept counting, scrollback is intact, keyboard focus is in it.
- [ ] `Ctrl+Shift+D` parks the focused pane; bare `Ctrl+D` still reaches the
      shell. Park every pane: the workspace shows the empty drawer message.
- [ ] Park a zoomed pane, a broadcast member and a pane with an open web
      preview; restore each. Park a Claude pane mid-task: its state dot still
      updates in the drawer row and `Ctrl+Shift+J` restores it when it needs you.

## Default launch mode

- [ ] Fresh profile: a new Claude Code pane starts in normal mode (header shows
      "Default"; Claude asks before an edit).
- [ ] Settings → Terminal → Default launch mode → Claude Code = Bypass permissions:
      a new Claude pane starts bypassed; an already running pane is not restarted
      and keeps its mode. Restart the app: the choice is kept.
- [ ] Pane header → Plan on a Claude pane: Claude restarts in plan mode and
      continues the conversation.
- [ ] Codex default = Safe: a new Codex pane runs `-s read-only -a on-request`.

## Default AI provider for splits

- [ ] Fresh profile: split right/down opens a plain shell; tooltip just "Split right".
- [ ] Settings → Terminal → Default AI provider = Codex: split opens Codex, the
      tooltip says "Split right (Codex)". Restart the app: the choice is kept.
- [ ] Alt+click a split button: a plain shell opens.
- [ ] Workspace ⋮ → Split opens… → Claude Code: splits there open Claude while
      another workspace still opens Codex. "Settings default" reverts it.
- [ ] Composer "Split opens" = Claude Code: the new workspace's ⋮ menu shows it ticked.
- [ ] Uninstall an agent's CLI (rename it off PATH, re-probe): it disappears
      from the composer's "Split opens" list unless it is the current choice,
      shown as "(not installed)"; a stale default falls back to a plain shell
      on split. A workspace default or template that assigns it creates plain
      terminals for those slots.
- [ ] Worktree isolation on: a default-agent split starts in the workspace
      folder, no new `swarm/*` branch appears.

## Astera themes and Files (GN)

- [ ] Select each of Vega, Orion, Umbra, Aurora, Antares, Quasar and Sirius;
      check palette contrast, font loading, menus, dialogs and preview cards.
      While a shell emits output, switch themes and verify PID/scrollback survive.
- [ ] Click terminals with different folders/worktrees; Files follows configured
      roots. Run `cd` in one shell; its explorer root stays fixed. Switch back
      and check expanded folders. Try a symlinked project root.
- [ ] Resize all three sidebar sections, sidebar width and terminal/editor split.
      Use separators with the keyboard and check the editor fills its whole pane.
- [ ] Browse a directory with thousands of entries; scroll, filter loaded files,
      range-select and navigate with arrows/typeahead without terminal input.
- [ ] Create, rename, duplicate, cut/paste and drag files across roots. Confirm
      existing destination files survive, errors stay visible and undo works.
- [ ] Windows Explorer: copy files into the
      OS clipboard, import through the context menu, then copy back out. Test
      long paths, spaces and Unicode. Verify explicit clipboard-unavailable errors.
- [ ] Delete nested folders and restore history after restarting the app. Test
      a destination-name collision, a symlink and a >50 MiB snapshot skip warning.
- [ ] Open a UTF-8 BOM/CRLF file in two panes, edit/save and verify original
      encoding/newlines, shared buffers and undo after switching tabs. Modify it
      from another program; clean buffers reload, dirty buffers require a choice.
- [ ] Cancel closing a dirty tab, pane, workspace and tray Quit. Save/Discard
      succeeds; closing the window to the tray keeps buffers and shells alive.
- [ ] Change files and git status from another process, including an isolated
      worktree and a renamed/recreated directory; Files and open tabs update.
- [ ] Render Markdown with GFM, source links, local/remote images, duplicate
      headings, fenced code and preview search. Check synchronized split scrolling;
      script tags and javascript URLs cannot execute.
- [ ] Open an SVG: split preview updates while typing, wheel zoom keeps the
      cursor point, drag pans, Fit/100 %/backgrounds work; an inline `<script>`
      in the SVG does not run.
- [ ] Open an HTML page with a relative stylesheet, image and inline script:
      all load, unsaved edits show after ~300 ms, Save keeps the view.
      `window.parent`/`__TAURI__` access fails; a `../` link out of the project
      root is refused. **Browser** opens the system default app.
- [ ] Preview each image/video format supported by the native webview. Seek a
      video, regenerate it, verify stable-change reload and playback position;
      switch workspaces and check background playback stops. Test missing files.
- [ ] Run Python/pytest/Node/Compose/.NET files; only a new plain-shell pane runs
      the command. Original agent panes remain running. Ctrl+click a terminal
      path opens the integrated editor at its line/column.
- [ ] With the native web preview visible, open file menus and dirty dialogs;
      preview hides beneath overlays and restores after dismissal.

## Basics

- [ ] Launch → one workspace, one terminal; run a command and see output.
- [ ] Split a pane horizontally and vertically; drag the separator; close a
      pane → the tree collapses.
- [ ] Drag a pane header onto another pane → the two swap, shells stay alive.
- [ ] Add / switch / rename / close / drag-reorder workspaces in the navbar.
- [ ] Composer: native folder picker returns the right path, recent folders
      work, agent steppers allocate correctly, the layout preview matches the
      result, `⌘/Ctrl + Enter` creates the workspace.
- [ ] Navbar terminal list: clicking an entry focuses that pane.
- [ ] Close the window → hides to tray (ptys stay alive); tray → Show restores;
      tray → Quit exits and kills every pty.
- [ ] The tray/menu-bar icon shows the box-logo mark (macOS: monochrome
      template that flips with the menu-bar theme; Windows/Linux: the color
      compact tile).
- [ ] Launch a second instance → only focuses the existing window.
- [ ] Custom titlebar renders; dragging it moves the window; edges resize
      (Windows/Linux — macOS uses native traffic lights).
- [ ] Minimize / maximize-restore toggle the right icon state (Windows/Linux).
- [ ] The close button hides to tray without quitting (Windows/Linux).

## Terminal

- [ ] **Truecolor:** run a 24-bit colour CLI → colours are exact, not
      downscaled to 256.
- [ ] **UTF-8:** print emoji, box drawing and accented text in a stream → no
      mojibake.
- [ ] **IME:** type Vietnamese with Telex (or a CJK IME) → no lost or duplicated
      characters; backspace deletes exactly one character, including NFD
      compositions.
- [ ] **Copy/paste:** with a selection `Ctrl/⌘+C` copies; with no selection
      `Ctrl+C` still sends SIGINT; `Ctrl/⌘+V` pastes exactly once.
- [ ] **Screenshot paste:** `Win+Shift+S`, then `Ctrl+V` in a Claude Code and a Codex
      pane → a `%TEMP%\swarmterm-paste\paste-*.png` path is inserted once and the
      agent attaches it as an image. Same in a plain shell → nothing happens.
- [ ] **File drop:** drop a file on a pane → the path is inserted, quoted for
      that pane's shell.
- [ ] **Shell switch:** pick another shell in the pane header → that pane
      respawns with it, other panes are untouched.
- [ ] **Keyboard focus:** click the titlebar / a tab / a pane header, then type
      immediately → characters reach the terminal; Tab triggers shell
      completion instead of walking the focus ring.
- [ ] **Activity dot:** lights while a pane streams output, clears when quiet.
- [ ] **Environment filter:** quit Swarmterm, start it from a `cmd` with
      `set FOO_API_KEY=x` → in a new cmd pane `echo %FOO_API_KEY%` prints
      `%FOO_API_KEY%` (not set). Add `FOO_API_KEY` to **Settings → Terminal →
      Environment → Always pass these variables**, open a new pane → prints
      `x`. A command routine `echo %FOO_API_KEY%` behaves the same.

## Terminal links

- [ ] URL: `echo https://example.com` → hover underlines it; a **plain click**
      opens the OS browser and does NOT open the in-app preview column.
- [ ] Drag-select that URL with the mouse → text selects, no browser opens.
- [ ] Absolute path: `ls $PWD/package.json` → plain click does nothing;
      `⌘/Ctrl + click` opens it in the editor.
- [ ] Relative path with line: `echo "src/lib/terminal-links.ts:15:1"` →
      `⌘/Ctrl + click` opens line 15. Then `cd src`, `echo
      "lib/terminal-links.ts:15"` → still resolves (bash/zsh; not PowerShell —
      see Known limits in the README).
- [ ] Non-existent path: `echo "src/lib/does-not-exist.ts:9"` → no underline,
      click does nothing.
- [ ] OSC 8 from an agent: run `claude` in a pane and have it read a file so it
      prints a path → `⌘/Ctrl + click` opens the right file.

## Broadcast and settings

- [ ] `⌘/Ctrl + Shift + B` enters broadcast; `Alt + Click` adds/removes panes;
      typing once reaches every group member; `Esc` exits.
- [ ] Settings → Terminal: changing font / size / line height / ligatures
      updates the preview and every pane.
- [ ] Ctrl + mouse wheel over a pane: *Pane under the mouse* resizes only that
      pane (shell and Claude Code reflow, plain wheel still scrolls, Claude Code
      fullscreen does not scroll), `Ctrl + 0` resets it; *All panes* moves every
      pane and the Size stepper; *Off* leaves Ctrl + wheel alone. The app UI
      itself never page-zooms.
- [ ] Settings → Keyboard Shortcuts lists the bindings for the current platform.
- [ ] `⌘/Ctrl + B` toggles the sidebar; `Esc` closes Settings.
- [ ] Sidebar hidden: resting the mouse on the left window edge slides it in over
      the terminals (no terminal resizes); moving away slides it out. Items and
      menus in it work, and it stays open while one of its menus is up. An open
      preview column never paints over it. Dragging a workspace out of the rail
      doesn't close it mid-drag.
- [ ] Settings → Appearance → *Peek sidebar on left edge* off: the edge does
      nothing; the choice survives a restart.
- [ ] Right panel closed: resting the mouse on the right window edge slides it in
      over the terminals (no terminal resizes); moving away slides it out. Git
      and War Room work in it; a pane dragged onto it joins the War Room without
      it closing mid-drag. Preview shows "Pin the panel"; the pin button docks
      the panel. *Peek right panel on right edge* off: the edge does nothing.
- [ ] Composer: *Save as default* → reopen the composer, the folder, counts,
      agents, worktree toggle and *Split opens* come back. *Save as template…*
      with a name → the *Template* picker lists it and applies it.
- [ ] Settings → Workspaces: editing the defaults changes the next composer;
      add / edit / duplicate / delete a template; *Reset to built-in* restores
      2 terminals with 1 Claude Code. Everything survives a restart.
- [ ] Restart the app → appearance and terminal preferences are remembered.

## Worktrees

- [ ] The "Isolate features in git worktrees" toggle is disabled for a
      non-repository folder (and for a repo with no commits yet).
- [ ] Toggle on + create a workspace with 3 Claude panes → 3 worktree
      directories exist next to the repo, 🌿 badges appear immediately without
      typing a prompt.
- [ ] Broadcast one prompt to the 3 panes → 3 separate, clean diffs on 3
      branches in the Git tab.
- [ ] `worktree.remove` refuses a worktree with uncommitted changes; commit and
      retry → the directory is removed.
- [ ] Create a workspace with the toggle OFF, call `worktree.spawn` → fails with
      "worktree isolation is not enabled".
- [ ] Closing a pane or workspace does NOT delete any worktree.

## Media panel

- [ ] The Swarmterm MCP server lists no `media.*` tool, and its instructions do
      not mention the Media panel.
- [ ] Run `echo C:\path with spaces\shot.png` (existing file) in a pane:
      a "1 new image/video" pill appears, the strip shows `shot.png` with its
      thumbnail, the Media panel does not open, typing continues in the shell.
- [ ] A large image (wider than the panel) shown in the Media tab is centred
      and scaled to fit the viewer, never shifted off to the right.
- [ ] Click the pill: the Media tab opens on that image and shows it, the pill
      is gone and keystrokes still land in the terminal.
- [ ] Click a second strip item: it loads and shows. An MP4 plays
      and seeking works (range requests).
- [ ] Ctrl+click a media path outside the project in the terminal: the Media
      tab opens on it. Ctrl+click a `.txt` path still opens the editor/file
      manager as before.
- [ ] Print the same path again: no new pill. Print a relative `out/x.webp`
      and a quoted `"a b.gif"`: both are picked up; a missing, `.svg` or
      `\\host\share` path is not.
- [ ] Switching from Preview to Media hides the native preview webview.
- [ ] `cat` a large log (no media paths): no visible slowdown versus before.

## Media zoom

- [ ] Wheel over an opened image in the Media tab: it zooms in/out around the
      pointer (the spot under it stays put), stopping at 10% and 2000%; the
      corner shows the percentage. A touchpad pinch zooms too.
- [ ] Wheel over the thumbnail strip, or over the viewer outside the image:
      the strip scrolls / nothing zooms. A video does not zoom.
- [ ] Zoomed in: left-drag pans, the image cannot be dragged out of the panel;
      double-click or **Fit** returns to fit, **1:1** shows real pixels.
- [ ] Keystrokes still reach the focused terminal after zooming, panning and
      clicking Fit/1:1.
- [ ] While annotating: zoom in, draw a pen stroke and a rectangle; they land
      under the pointer. Middle-drag and Space+drag pan without drawing; Space
      with the pointer elsewhere types a space in the terminal. Marks stay sharp
      after zooming; Save copy is identical to an unzoomed save.

## Media annotate

- [ ] An opened image shows **Annotate** in the viewer title; an unopened item
      and a video do not.
- [ ] Draw with pen and marker, a line, an arrow, a rectangle and an ellipse
      (drag up-left as well as down-right), with Fill on and off and different
      colours/widths: the live preview follows the pointer and each shape lands
      where it was drawn. Resize the right panel: the marks stay in place.
- [ ] Undo removes marks newest first; Clear then Undo brings them all back.
- [ ] While drawing, and right after moving the width slider or toggling
      Fill, keystrokes still go to the focused terminal (arrow keys do not
      move the slider).
- [ ] Re-print or overwrite the image file while annotating: the marks still
      sit on the picture you are drawing on, and the saved copy shows it.
- [ ] While annotating, Esc with the
      pointer over the image leaves annotate mode; Esc elsewhere reaches the agent.
- [ ] Save copy: a `<name> (marked).png` item tagged `marked` is selected, shows
      the marks at full resolution, and the original file is unchanged on disk.
- [ ] Drag the marked item (or the toolbar grip while annotating) into a Claude
      Code pane: the agent attaches the image and sees the marks.
- [ ] A very large image (e.g. 10000 px wide) saves downscaled to 8192 px
      without freezing the UI.
- [ ] Quit Swarmterm: `%TEMP%\swarmterm-marked\<pid>` is gone. The MCP server
      lists no tool for annotating or reading marked images.

## Media popup and clipboard images

- [ ] Defaults: with a fresh profile, Settings → Media shows the popup and
      Clipboard images off; a printed media path and copying a screenshot show no popup.
- [ ] Turn on Show popup, `echo` an existing image path while you type in a
      pane: the corner popup lists the item, keystrokes keep landing in the
      shell, and it hides after ~6 s.
- [ ] Hover the popup for 15 s: it stays; leave: it hides a full timeout later.
      Scroll a long list: the countdown restarts.
- [ ] Press Esc while hovering: the popup closes and the agent does NOT receive
      the Esc. Esc with the pointer elsewhere goes to the terminal.
- [ ] Click an item: the Media tab opens on it, the popup closes, typing still
      goes to the terminal and the image loads. Image rows show thumbnails;
      a video row shows the film icon.
- [ ] With the web preview open, trigger the popup: the preview hides while the
      popup is up and comes back after it hides.
- [ ] Turn on Clipboard images, press Win+Shift+S and snip: a `clipboard` item
      appears in the Media tab and the popup. Copy the same image again: no new
      item. Copy a PNG and an MP4 file in Explorer: both appear as the files.
- [ ] Copy text: nothing happens. Turn Clipboard images off and snip: nothing.
- [ ] Copy a large (4K) screenshot: the UI does not stutter.
- [ ] Quit from the tray: `%TEMP%\swarmterm-clipboard\<pid>` is gone.

## Media drag into panes

- [ ] Drag an opened image from the Media strip: after a few pixels a ghost
      with its thumbnail follows the pointer (film icon for an opened
      video, image icon for any unopened item) and the pane under it gets the drop ring.
- [ ] Release over a Claude Code pane: the path arrives as a paste and the
      CLI shows `[Image #1]` (Codex likewise); the pane has the keyboard.
- [ ] Release over a PowerShell pane: the quoted path is typed, nothing runs.
- [ ] Drag an unopened item into a pane: its path is typed, the strip still
      shows the placeholder and its media URL still answers 404.
- [ ] Release over the web-preview column, the navbar or the panel, or press
      Esc mid-drag: nothing is typed. A plain click still opens the item.
- [ ] With the popup up, drag one of its rows into a pane: same result.

## Web preview

- [ ] Preview a framing-hostile site: type `github.com` in the address bar —
      the page must render (not a blank frame).
- [ ] Click links inside the page: the address bar URL and tab title follow;
      Back returns and Forward re-advances.
- [ ] Popup handling: on a page that calls `window.open` (e.g. an OAuth
      "sign in" link), the preview navigates in place — no OS window appears;
      Back returns to the opener page.
- [ ] Overlay z-order: with a preview showing, open the workspace-tab context
      menu and the Settings dialog — both must render ABOVE the page (the
      preview hides while they're open, showing the dimmed placeholder).
- [ ] Focus: have an agent call `browser.open_preview` while you type in a
      terminal — keystrokes keep landing in the shell.
- [ ] Resize: drag the panel separator — the page stays glued to the column
      with no white gaps or smearing.
- [ ] Pane switch keeps page state: two panes with previews — switching
      between them must not reload either page.
- [ ] Kill a pane with an open preview: the webview disappears with it; other
      panes' previews are untouched.
- [ ] Welcome z-order: with a preview showing, open Welcome ("+") — the page
      must hide (no native paint over the Welcome page); closing Welcome
      brings the preview back.
- [ ] Switch agent/shell on a pane with an open preview (composer respawn) →
      the address bar clears to its empty state; opening a new URL works and
      shows.
- [ ] Type `exit` in a pane with an open preview, then respawn/restart it →
      same: address bar clears, a new URL opens and shows.

## War Room — basics

- [ ] Drag two agent panes into the War Room tab → member chips appear and an
      intro is typed into each pane.
- [ ] **Probe:** agent A sends a probe → the transcript shows it, idle agent B
      is nudged and reads its inbox.
- [ ] **Execute:** agent A sends execute → the prompt runs in pane B and the
      transcript marks it orange.
- [ ] **Revocation:** drag a chip out or press ✕ → the next tool call from that
      pane is refused with "not in the War Room".
- [ ] **PTY death:** close a member pane → the transcript logs the leave and
      `list_peers` shows no ghost.

## War Room — moderator and typing guard

- [ ] Broadcast a probe from the composer → both panes are nudged; the
      transcript shows one `Moderator → everyone` group with a crown avatar.
- [ ] Direct probe to one member → only that pane is nudged.
- [ ] Switch to Execute → the `Everyone` row disappears, the input turns orange;
      sending a short prompt pastes and runs it in that pane only.
- [ ] An agent sends to `__moderator__` → the reply lands in Discussion and
      nothing is typed into any pane.
- [ ] An agent sends `mode: "execute"` to `__moderator__` → rejected.
- [ ] Type half a line into pane A without Enter, then probe pane A from the
      composer → nothing is typed, the half line is intact, the pill appears in
      pane A, and the Members sub-tab shows `⏸1`.
- [ ] Press Enter in pane A → the nudge arrives right after.
- [ ] Repeat, then click the pill instead → delivered immediately.
- [ ] Repeat, then click into pane B → pane A's pill stays. An unsubmitted line
      holds regardless of focus.
- [ ] Close pane A while a delivery is held → no stray text, no orphan badge.

## War Room — multiple rooms

- [ ] Launch → one "War Room" tab; drag a pane into the panel body → it joins
      that room and the intro names it.
- [ ] `+` creates "Website B"; drag a second pane straight onto the B tab → it
      joins B and the first room is untouched.
- [ ] `war_room.list_peers` from each pane shows only same-room peers, with the
      correct `room` name.
- [ ] Broadcast in room A → room B's transcript receives nothing.
- [ ] Drag a member chip from A onto tab B → A logs Leave, B logs Join
      (pending), the intro is retyped, and the next tool call reconnects.
- [ ] Double-click a tab → rename inline; composer and transcript update at once.
- [ ] Press ✕ on a room with members → two-step confirm → members disconnect,
      the tab disappears, the active room falls back to a remaining one.
- [ ] With only one room left → its tab has no ✕.
- [ ] While viewing room A, queue a message into a pane being typed in in room B
      → tab B shows `⏸N`.

## Claude Code status line

- [ ] Open a workspace with a Claude Code agent pane. Within a few seconds of
      the first prompt the line under the input box reads
      `mcp ✓  ·  ctx <n>k/<n>k <n>%`.
- [ ] A fresh Claude session reads `ctx —` until its first reply.
- [ ] In a plain Terminal pane run `claude --strict-mcp-config` → `mcp …`:
      Claude is alive but never called our server.
- [ ] With a Claude pane running, quit Swarmterm from the tray (Quit, not
      close-to-tray) → the next render reads `mcp ✗`.
- [ ] Run `claude` in a system terminal → the `mcp` segment is absent, only
      `ctx …` renders.
- [ ] Let a session pass 70% context → the `ctx` segment turns amber; past 90%
      → red.
- [ ] Settings → Terminal → Agent status line → off. `statusLine` is gone from
      `~/.claude/settings.json` and every other key survived. Toggle back on →
      it returns, pointing at the current binary.
- [ ] Put your own `statusLine` in `~/.claude/settings.json`, relaunch
      Swarmterm → it is untouched (a warning is logged to the devtools console).
- [ ] Switch a pane's agent (respawns the pty under the same id) → the line
      drops to `mcp …` until the new Claude connects.

## Saved workspaces

Automated checks: `npm run test:e2e -- tests/e2e/saved-workspaces.spec.ts`
uses IPC mocks. With an already running Dev app on CDP port 9333,
`node scripts/check-saved-workspaces-native.mjs <existing folder>` exercises
real terminal creation and restore. `python scripts/check-session-hooks.py
src-tauri/target/release/swarmterm.exe` checks built hook CLIs with a loopback
server. The full Quit/restart and conversation checks below require real CLIs.

- [ ] Create four panes (two Claude Code, two Codex) in the same working folder.
      Review/trust Swarmterm's Codex hooks through `/hooks`, send a distinct
      message in every pane, and verify the Saved card reports four sessions.
      Capture must leave every existing terminal running without a respawn.
- [ ] Resize both split directions, rename the workspace, change a Codex launch
      mode and use a worktree in one pane. Quit from the tray and restart.
      Open the card: exact split sizes, agents, shells, folders, launch mode,
      worktree badge and each distinct conversation are restored.
- [ ] Open the same card while its workspace is live: focus the existing one,
      with no duplicate workspace or terminal. Rename and cancel with Escape.
- [ ] Forget an open workspace: terminals stay alive, the card disappears,
      and later layout changes, closing and restarting do not recreate it.
- [ ] Close a workspace immediately after creating/resizing it (before 500 ms),
      then reopen: the final snapshot is retained. Close one pane: the saved
      tree contains the remaining panes.
- [ ] Remove a saved pane/worktree folder or agent session, then reopen:
      show a notice and start fresh; missing pane folders use the root folder.
      Temporarily move the root folder: reopening stops with a notice.
- [ ] Use an old Codex CLI or disable hooks: no unsupported flags are added;
      layout restore works and new session capture remains unavailable.
- [ ] Keep foreign Claude/Codex hooks (including inline TOML and comments).
      App restarts retain them, repair only Swarmterm's command after a move,
      perform no steady-state config writes, and never change hook trust.
- [ ] Check saved storage: no terminal text, prompt, startup command, runtime
      terminal id, file tab, unsaved buffer or broadcast group is persisted.

## Session resume (composer)

- [ ] Pick a folder with prior Claude Code activity → "Resume sessions"
      (below Recent) lists them newest first, with agent icon, relative
      time, and All/Claude Code/Codex/OpenCode/Qwen Code tabs (0-count tabs
      disabled).
- [ ] More than 6 sessions → "Show all (N)" opens the two-column sessions
      dialog (agent rail + search); ticks made there survive Done/Esc and
      tab switches.
- [ ] More than 5 recent folders → Recent shows 5 + "Show all (N)"; it opens
      the Recent-folders dialog — search filters, clicking a row fills
      Working folder and closes, ✕ removes, Esc/backdrop/Done dismiss.
- [ ] Narrow window → session tabs wrap to a second line; rows truncate.
- [ ] Tick one + Create → the new pane runs `claude … --resume <id>` and the
      old conversation is visible.
- [ ] Folder with no sessions → no "Resume sessions" section, composer
      otherwise unchanged.
- [ ] Uninstall/rename an agent CLI → its sessions disappear from the list.
- [ ] Worktree toggle ON + a ticked session → stepper panes get worktrees,
      the resume pane spawns at the session's original folder.
- [ ] Switch agent on a resume pane via the header dropdown → pane respawns
      fresh (no --resume in the typed command).

## Agent roster (per agent, requires that CLI installed)

Run this block once per newly supported agent — GitHub Copilot, Qwen Code,
Amp, Gemini CLI, Cursor Agent, Antigravity, OMP — on a machine that has it:

- [ ] Composer shows the agent with its icon; stepper assigns panes; the
      agent list scrolls past ~9 rows without clipping the dialog.
- [ ] Uninstalled CLI → the composer does not list it at all.
- [ ] Spawn a pane → the CLI starts; state dot turns yellow while it works,
      red on a permission prompt, green when finished in background (OMP:
      plain activity dot only — expected).
- [ ] Per-pane agent switcher lists the agent and respawns onto it.
- [ ] War Room: drag the pane into a room → probe lands in inbox; execute
      pastes + runs the prompt (Copilot: verify the pasted Enter is not
      swallowed after focus loss — herdr reports it needs a focus-gained
      event first; if it reproduces, file it).
- [ ] Qwen only: "Resume sessions" lists prior qwen sessions for the folder
      and Create runs `qwen --resume <id>`.
- [ ] Qwen only (MCP): a qwen pane sees the `swarmterm` MCP server
      (`/mcp` or `qwen mcp list`) and can call `browser.open_preview`.
- [ ] Worktree toggle ON → `worktree.spawn` accepts the agent's template id.

## Signed release (macOS)

Run against the `.dmg` produced by `npm run release:mac`, ideally on a Mac that
has never run Swarmterm from source. Details in
[`release-macos.md`](release-macos.md).

- [ ] The disk image opens with no Gatekeeper warning after
      `xattr -w com.apple.quarantine "0083;00000000;Safari;" <dmg>`.
- [ ] Dragging to Applications and launching shows no "unidentified developer"
      or "damaged" dialog.
- [ ] A terminal pane spawns and runs `ls`; a split pane spawns a second shell.
- [ ] The web preview column loads `https://github.com`.
- [ ] `echo $SWARMTERM_MCP_URL` inside a pane prints a loopback URL (a pane opened within ~10 s of a restart, while the previous MCP port is awaited, may print nothing: known limit, user guide).
- [ ] A War Room message reaches a second pane.
- [ ] Prompts for Desktop/Documents/Downloads access name Swarmterm and carry a
      readable explanation (the `Info.plist` usage strings).

## Windows release

Run against the installer produced by `npm run release:win`, ideally on a
machine that never built Swarmterm. Details in
[`release-windows.md`](release-windows.md).

- [ ] A freshly downloaded `…x64-setup.exe` shows SmartScreen's "Windows
      protected your PC"; **More info → Run anyway** proceeds.
- [ ] Install completes per-user with no admin prompt; the app launches.
- [ ] A terminal pane spawns and runs `dir`; closing the pane leaves no
      orphaned shell in Task Manager.
- [ ] Uninstall via Settings → Apps removes the Start Menu entry.

## Auto-update

- [ ] GN shows no update controls or tray entry and makes no update
      requests. App name and application-data identifier are distinct.

## Agent state detection

- [ ] Claude pane: ask for a long task → dot turns yellow (working) while it runs.
- [ ] Claude pane: trigger a permission prompt (e.g. a Bash command without allow rules) → dot turns red (blocked) within ~1s.
- [ ] Answer the prompt, let the task finish while ANOTHER workspace is active → its workspace tab shows a green dot; switching to it and focusing the pane clears the green.
- [ ] Finish a task while WATCHING the pane → no green dot appears (goes straight to idle).
- [ ] Claude transcript viewer (ctrl+o): state does not flap while it is open.
- [ ] Codex pane: same working / blocked (Action Required) / done pass.
- [ ] OpenCode pane: same working / blocked (Permission required) / done pass.
- [ ] Plain terminal pane: yellow output dot behaves exactly as before.
- [ ] Respawn an agent pane (switch agent) → no stale dot; detection resumes after ~3s.
- [ ] Scroll an agent pane far up during a working task → dot still tracks the live bottom of the buffer.
- [ ] Settings → Appearance → **Highlight panes by agent state** on: a working Claude pane wears a yellow inner frame that turns orange over the chosen gradient, red on a permission prompt, green after finishing in the background (cleared on focus); idle and plain Terminal panes stay unframed; switching it off removes every frame at once.

## Notifications

- [ ] Agent blocks (permission prompt) in a background workspace → chime after ~1 s, no OS banner while the window is focused.
- [ ] Same, but with the window unfocused → chime + silent OS banner ("<Agent> needs your input").
- [ ] Agent finishes in a background pane → completion chime; banner only when window unfocused.
- [ ] Blocked flash that resolves within ~1 s → no chime.
- [ ] Blocked while you are watching that pane → nothing.
- [ ] Settings → Notifications: Sound off → banner still works; System off → chime still works; per-agent off → that agent is fully silent.
- [ ] macOS: first banner triggers the system permission prompt; denying it keeps chimes working.
- [ ] Plain Terminal pane never notifies.
- [ ] Bell: an agent in another workspace blocks → bell counter rises; the entry names workspace and pane; clicking it switches workspace, focuses the pane and clears the counter.
- [ ] Bell: type `exit 3` in a background shell pane → pane shows "Process exited", bell lists "Shell exited (code 3)".
- [ ] Bell: a drawered pane's entry restores the pane from the drawer; a closed pane's entry is shown disabled.
- [ ] Bell: Sound and System off → entries are still recorded.
- [ ] Bell: a backend alert ("MCP server stopped" / "Voice input failed") shows its reason under the title and is not disabled; clicking it only marks it read.


## Voice companion (SWA-42)

- [ ] Settings → Voice → buzzkey on a profile without buzzkey: "Not installed"; Install downloads, verifies and installs into `%LOCALAPPDATA%\Programs\buzzkey`; state becomes "Installed, not running".
- [ ] Start → buzzkey's tray icon appears; after the first dictation the state reads "Connected — buzzkey <version>".
- [ ] Quit (buzzkey with `quit` capability) closes it; an older buzzkey shows the tray hint instead.
- [ ] Check for update on the newest version → "Up to date"; Update over a running buzzkey quits, swaps and restarts it.
- [ ] Autostart switch on/off adds/removes `HKCU\…\Runuzzkey`; buzzkey's own tray toggle shows the same state.
- [ ] With whisper-key running, the section offers no action.
- [ ] Release build: no "testlab key" notice; a release signed with the buzzkey release key installs (SWA-63).

## Account profiles (SWA-9)

- Add one Claude Code and one Codex profile through Settings > Accounts; verify their names and configuration folders survive an app restart.
- Create multiple panes using a fixed profile, then using Round robin. Verify each CLI rotates independently through Default and its own profiles, with matching header and terminal-list labels.
- Use Log in only with a dedicated test profile. Verify the pane runs the normal CLI login command with that profile's configuration; never enter credentials in Swarmterm settings.
- Resume a recorded conversation from each profile and confirm its history belongs to the selected profile. Filter the sessions dialog by account.
- Save a workspace with an exact profile-bound session, quit, restart and restore. Verify both its account and conversation identity survive.
- Remove a profile, then restore its saved workspace. Verify a warning appears and its pane starts a fresh conversation using Default. Configuration files and already running panes must remain intact.
- Change a pane's account. Verify the agent restarts and no old conversation is resumed under the new profile.

## Account and agent handoff (SWA-22)

- Open a Claude pane's Handoff brief, click **Hand off…**, pick a Codex
  profile and **Start pane**. A new Codex pane opens in the same folder; the
  old pane is unchanged. **Send brief** stays disabled until it runs.
- Press **Send brief** while typing in the new pane: the dialog shows the
  typing hold; after you stop and clear the line, the brief arrives once and
  is submitted. The bell lists "Handoff brief delivered". Double-clicking
  Send never pastes twice.
- Start a handoff with an account whose CLI fails to start (or close the new
  pane before sending): the dialog shows "Not sent", the bell lists the
  failure, and nothing is retried.
- Usage reads "Usage unknown" with a time; a limit message in the old pane
  shows only as an unverified hint.

## MCP catalogue (SWA-11)

- Open Settings > MCP. Select each Default account and a dedicated named Claude Code/Codex profile; verify configuration additions target only the selected account.
- Add Playwright and verify its generated argument list contains `--headless`. Adding a definition must not launch a process, download a package or open a login/browser window.
- Add GitHub or Context7. Verify the configuration contains the official remote endpoint without a token. Authenticate separately in the agent CLI when testing connectivity.
- Add a definition twice through the typed command; verify the second call leaves file contents unchanged and the UI shows Configured. This status means configuration is present, not that a connection was tested.
- Put a different definition under the same server name in an isolated test profile. Verify Existing configuration appears and an attempted add preserves the existing definition. Foreign servers, unrelated fields and TOML comments must remain intact.
- Filesystem: try a missing directory, a relative path and a path containing shell metacharacters. Verify an error appears and the file remains unchanged. Then choose existing absolute directories, including one containing spaces; verify the saved argument list matches them.
- Create a malformed JSON/TOML test config. Verify inspection/addition reports an error without modifying it. Test only a dedicated profile's files.
- Verify settings contain no password/token inputs and inspect responses expose only catalogue IDs, statuses and version, never headers or foreign environment values.
- Start a new pane only when intentionally testing the configured MCP server. Use the agent CLI to check connectivity, manage authentication or remove definitions. Package downloads by `npx`/`uvx` at this stage are separate from adding configuration in Swarmterm.

Automated native config/UI check against an already running Dev app: `node scripts/check-mcp-catalog-native.mjs`. It creates isolated test profiles, preserves foreign entries, checks idempotence/conflicts/directory validation and removes only its own profile metadata. It does not start MCP servers or authenticate.

## Custom shortcuts and actions (SWA-10)

- Record a new sidebar chord, close Settings and press it in a terminal. Check
  that it toggles once without sending control bytes. The old chord should reach
  the shell again. Hold the new chord: no repeated toggles or leaked input.
- Record a chord already used by another action. Check the conflict error;
  Escape cancels recording while keeping Settings open. Unbind and Reset, then
  restart and verify the persisted choice. A conflicting Reset is rejected.
- Create a four-pane mixed Claude/Codex recipe using Auto accounts. Verify
  per-agent rotation and account badges; run from its shortcut and its Run button.
- Save an action containing workspace and split steps. Verify step order. An
  unavailable recipe folder or CLI aborts before any workspace is created.
- Leave a dirty file open, open the composer and type in its folder field.
  File save/Markdown chords must not change the hidden document. Return to the
  editor and check its current save and preview bindings.
- Verify action persistence contains only names, chords and recipe/action steps,
  with no startup commands, prompt text, terminal output or credentials.

Native check against a stable, running Dev app:
`node scripts/check-custom-shortcuts-native.mjs <existing isolated test folder>`.
It restores previous shortcut settings and removes only its own workspaces.

## Built-in speech recognition (SWA-38)

- [ ] Settings → Voice: download **Base**; the bar fills, the row then reads "downloaded".
- [ ] Enable built-in speech; the pane header shows a microphone.
- [ ] Click into a shell, Ctrl+Shift+Space, say a sentence, Ctrl+Shift+Space: "Listening…" then
      "Transcribing…", the sentence arrives as a draft (no Enter).
- [ ] Start again, click the pill's Stop: nothing is typed.
- [ ] Windows microphone access off for desktop apps: the bell reports "no microphone available".

## Process priority

Use Task Manager → Details → "Base priority" (or Process Explorer).

- [ ] Default (Strict): agent pane, let the agent run `cargo build -j 8` → cargo/rustc "Low", the agent CLI and its
      shell "Below normal", Swarmterm "Normal". Typing in another pane and the desktop stay smooth.
- [ ] Terminal pane: `cargo build` directly in the shell → cargo "Low", the shell "Below normal".
- [ ] In a pane, `powershell -c "$p=[Diagnostics.Process]::GetCurrentProcess(); $p.PriorityClass='Normal'; $p.Refresh(); $p.PriorityClass"`
      prints "BelowNormal".
- [ ] npm-installed Claude Code (`node …\@anthropic-ai\claude-code\cli.js`): its `node` "Below normal", a build it
      starts "Low".
- [ ] Settings → Terminal → Process priority → **Agent at normal**: the running agent and shell turn "Normal" at once,
      the running build stays "Low".
- [ ] Pane priority **Low (idle)** (Strict): the whole pane turns "Low" at once.
- [ ] **Cap CPU per pane** at 25 %: a `cargo build -j 16` stays near 25 % total CPU in Task Manager.
- [ ] **Off**: running pane processes return to "Normal"; new builds stay "Normal".
- [ ] Workspace ⋮ → untick **Lower build priority** → that workspace's processes return to "Normal".
      Reopen the saved workspace: still unticked.
- [ ] Settings → Terminal → **Run terminals in the terminal host** on, new pane → same results as above.
- [ ] Upgrade from a build with the old "Lower build priority" switched off → mode shows **Off**.
