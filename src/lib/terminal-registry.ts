import { Terminal, type ILink, type ILinkHandler, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { createWebglBudget, WEBGL_CONTEXT_BUDGET } from '@/lib/webgl-budget'
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search'
import { enableUnicode11 } from './terminal-unicode'
import { terminalTheme } from '@/lib/theme-adapter'
import { useAppearanceStore } from '@/store/appearance-store'
import '@xterm/xterm/css/xterm.css'
import { ackOutput, createTerminal, releaseOutput, killTerminal, resizeTerminal, writeTerminal } from '@/tauri/terminal'
import { TerminalSession, type TerminalStatus } from '@/lib/terminal-session'
import { createFrameTaskQueue } from '@/lib/frame-task-queue'
import { describeFocusedElement, OVERLAY_SELECTOR, shouldReturnFocus } from '@/lib/terminal-focus'
import { useTerminalTextStore } from '@/store/terminal-text-store'
import { useTerminalTitleStore } from '@/store/terminal-title-store'
import { resolveBroadcastTargets } from '@/lib/broadcast-input'
import { isFocusReport, shouldDropFocusReport } from '@/lib/focus-report'
import { useAppStore, selectWorkspaceByTerminalId, selectFocusedTerminalId } from '@/store/app-store'
import { collectLeaves } from '@/lib/layout-tree'
import { DEFAULT_TERMINAL_TEXT, type TerminalTextPref } from '@/lib/terminal-text'
import { clampZoomOffset, paneFontSize, wheelZoomSteps } from '@/lib/terminal-zoom'
import { decideClipboardAction, isMacPlatform } from '@/lib/terminal-clipboard'
import { isWindowsPlatform } from '@/lib/platform'
import { windowsPtyOption } from '@/lib/windows-pty'
import { createResizeDebouncer, type ResizeDebouncer } from '@/lib/resize-debounce'
import { getWindowsBuildNumber } from '@/tauri/shell'
import { matchConfiguredShortcut } from '@/store/shortcut-store'
import { readClipboard, saveClipboardImage, writeClipboard } from '@/tauri/clipboard'
import { imagePasteText, supportsImagePaste } from '@/lib/clipboard-image'
import {
  isDragNotClick,
  shouldFollowLink,
  type ClickPoint,
  type LinkKind
} from '@/lib/terminal-links'
import { parseFileUrl } from '@/lib/file-url'
import { parseOsc52 } from '@/lib/osc52'
import { parseShellMark } from '@/lib/shell-marks'
import { isPlainShellPane, templateById } from '@/lib/templates'
import { sanitizePromptText } from '@/lib/prompt-sanitize'
import { detectPathCandidates, listingDirAbove, listingEntry, parsePathSuffix } from '@/lib/path-link-parse'
import { classifyOscLink, openPathLocation } from '@/lib/terminal-link-actions'
import { openUrl } from '@/tauri/opener'
import {
  findAvailableEditor,
  openInEditor,
  resolveDirLink,
  resolvePathLink,
  revealInFileManager
} from '@/tauri/links'
import { ActivityTracker } from '@/lib/activity-tracker'
import { forgetMediaOutput, noteMediaOutput } from '@/lib/media-passive'
import { writeReplayHistory } from '@/lib/replay-history'
import { useTerminalActivityStore } from '@/store/terminal-activity-store'
import { useTerminalTypingStore } from '@/store/terminal-typing-store'
import { displayPath } from '@/lib/files/paths'
import { devLog } from '@/lib/dev-log'
import { useShellMarkStore } from '@/store/shell-mark-store'
import { useContextUsageStore } from '@/store/context-usage-store'
import { useNotificationCenterStore } from '@/store/notification-center-store'
import {
  breaksSegment,
  diffToEdit,
  encodeEdit,
  isOrdinaryCharKey,
  isThirdLevelShiftKey,
  nextSuppressState,
  ownsInputEvent,
  ownsKeydown,
  ownsMultiCharKey,
  shouldSuppressInput,
  type SuppressState
} from '@/lib/terminal-input-client'
import { AgentStateDetector, type DetectorDeps } from '@/lib/agent-state/detector'
import { manifestForAgent } from '@/lib/agent-state/manifests'
import { useAgentStateStore } from '@/store/agent-state-store'
import type { BufferView } from '@/lib/agent-state/snapshot'
import type { AgentHookSignal } from '@/tauri/agent-state'
import { createFrameBatch } from '@/lib/frame-batch'
import { agentNewlineFor } from '@/lib/agent-newline'

export type { TerminalStatus }

/**
 * VSCode "Default Dark Modern" terminal palette. Used verbatim regardless of
 * the user's actual shell defaults so the terminal interior matches the rest
 * of the app's dark chrome. ANSI values mirror VSCode's built-in
 * workbench.colorCustomizations terminal.ansi* defaults for the Dark Modern
 * theme.
 */
const VSCODE_DARK_THEME: ITheme = {
  background: '#1F1F1F',
  foreground: '#CCCCCC',
  cursor: '#CCCCCC',
  cursorAccent: '#1F1F1F',
  selectionBackground: 'rgba(255, 255, 255, 0.25)',
  black: '#000000',
  brightBlack: '#666666',
  red: '#CD3131',
  brightRed: '#F14C4C',
  green: '#0DBC79',
  brightGreen: '#23D18B',
  yellow: '#E5E510',
  brightYellow: '#F5F543',
  blue: '#2472C8',
  brightBlue: '#3B8EEA',
  magenta: '#BC3FBC',
  brightMagenta: '#D670D6',
  cyan: '#11A8CD',
  brightCyan: '#29B8DB',
  white: '#E5E5E5',
  brightWhite: '#E5E5E5'
}

/** CSS font-feature-settings value enabling programming ligatures, or off. */
function ligatureFeatureSettings(on: boolean): string {
  return on ? '"liga" 1, "calt" 1' : 'normal'
}

/** Per-terminal options that persist across re-attaches (size is read live). */
export interface AttachConfig {
  cwd?: string
  shellId?: import('@/lib/terminal-pref').ShellId
  initialCommand?: string
  worktreeMode?: boolean
  repoRoot?: string
  agentId?: string
  accountId?: string
}

interface Entry {
  term: Terminal
  fit: FitAddon
  /** Backs the find overlay (SearchOverlay.tsx) via the terminalSearch* functions
   *  below. Disposes with the terminal — xterm addons tear down as a group. */
  search: SearchAddon
  /** Stable host the xterm renders into; moved between pane containers. */
  host: HTMLDivElement
  /** Padding-free child of `host` that xterm opens into — see getOrCreate. */
  mount: HTMLDivElement
  session: TerminalSession
  config: AttachConfig
  /**
   * The shell's live working directory, used to resolve relative path links.
   * Seeded from the spawn cwd and updated on every OSC 7 report, because `cd`
   * makes the spawn value wrong within seconds.
   */
  cwd: string
  /** Where the last press began, for the drag-vs-click guard. */
  lastMouseDown?: ClickPoint
  opened: boolean
  pendingFocus?: boolean
  observer?: ResizeObserver
  /** Live GPU renderer, only while the pane is visible — see syncWebgl. */
  webgl?: WebglAddon
  /** Context losses since the pane was last shown; caps re-acquire attempts. */
  webglLosses?: number
  /** Lost its slot to a more recently shown pane; cleared when next hidden. */
  webglEvicted?: boolean
  /** Pty-side size: observer ticks are coalesced, attach/spawn flush at once. */
  ptyResize: ResizeDebouncer
  /**
   * The running detection loop for this pane's agent, if any — absent for
   * plain `terminal` panes (`manifestForAgent` returns undefined for those)
   * and until the first attach, since the manifest is only known once
   * `config.agentId` is set. Rebuilt by `refreshDetector` whenever the
   * resolved manifest changes (agent switch via respawn).
   */
  detector?: AgentStateDetector
  /** The manifest id `detector` was built from, so `refreshDetector` can tell
   *  "same agent, keep the loop" from "different agent, rebuild it" without
   *  re-deriving the manifest from `entry.config` on every check. */
  detectorManifestId?: string
  /**
   * Clears the IME input segment's `committed` baseline and the textarea it
   * tracks. Exists on `Entry` — rather than staying a closure private to
   * `getOrCreate` — because paste, respawn, and retry all move the pty line
   * from outside the textarea `input` event this segment is diffed against:
   * `pasteIntoTerminal` writes straight to the pty via `term.paste` (which
   * also clears the textarea itself, but not `committed`), and
   * `respawnTerminal`/`retryTerminal` replace the pty under the same pane.
   * Left stale, the next real keystroke diffs against committed text the pty
   * no longer has and sends deletions for characters the new pty never saw.
   * Composition-safe: the textarea itself is left untouched if a composition
   * happens to be open when this is called, since none of these three
   * callers has any way to know that.
   */
  resetInputSegment: () => void
  /** True while an IME composition is open in this pane's textarea. Voice
   *  dictation waits for it to end: text written to the pty mid-composition
   *  would be overwritten by the composition's own commit. */
  isComposing: () => boolean
  /** When the current pty reached `running` — anchors the start window in
   *  which agent panes drop focus reports (`lib/focus-report.ts`). */
  ptyStartedAt?: number
  /** Ctrl+wheel zoom of this pane only, in px on top of the global size —
   *  relative so a later global size change still moves a zoomed pane. Kept
   *  here (not in React) so it survives remounts; not persisted. */
  zoomOffset: number
  /** Unused touchpad wheel delta toward the next zoom step. */
  wheelCarry: number
}

/** Live terminals keyed by terminalId, owned outside React's render tree. */
const entries = new Map<string, Entry>()

let userInput: (() => void) | undefined

/**
 * Register who hears about genuine user input (SWA-66: typing silences the
 * announcement voice). Called from `sendInput` only, so programmatic writes —
 * dictation drafts, War Room deliveries — never trigger it.
 */
export function setUserInputHandler(handler: (() => void) | undefined): void {
  userInput = handler
}

// Fetched once; terminals created before it resolves start with the
// build-less ConPTY option and get upgraded in place.
let windowsBuild: number | null = null
if (isWindowsPlatform()) {
  void getWindowsBuildNumber()
    .then((build) => {
      windowsBuild = build
      for (const entry of entries.values()) entry.term.options.windowsPty = windowsPtyOption(true, build)
    })
    // Terminals keep the build-less ConPTY option; say so instead of failing silently.
    .catch((e) => console.warn('terminal-registry: Windows build number unavailable, using build-less ConPTY option:', e))
}

function recordExit(id: string, exitCode: number): void {
  if (document.hasFocus() && selectFocusedTerminalId(useAppStore.getState()) === id) return
  const agentId = getTerminalAgentId(id)
  const who = agentId === undefined || isPlainShellPane(agentId) ? 'Shell' : templateById(agentId).name
  useNotificationCenterStore.getState().add({
    kind: 'exit',
    terminalId: id,
    title: `${who} exited (code ${exitCode})`,
    detail: useTerminalTitleStore.getState().titles[id] ?? '',
    at: Date.now()
  })
}
const terminalInitializers = createFrameTaskQueue(
  callback => requestAnimationFrame(callback),
  handle => cancelAnimationFrame(handle)
)

/**
 * One activity tracker for every terminal. `notify(id)` fires on each decoded
 * pty chunk (see the session sink below); after ACTIVITY_IDLE_MS of no chunks
 * the terminal flips back to idle. 1100ms is long enough to bridge the quiet
 * gaps between an agent's spinner redraws so the badge doesn't flicker, short
 * enough to clear promptly once real output stops.
 */
const ACTIVITY_IDLE_MS = 1100
const activityTracker = new ActivityTracker<string>(
  (id, active) => useTerminalActivityStore.getState().setActive(id, active),
  ACTIVITY_IDLE_MS
)

const NO_STATUS: TerminalStatus = { kind: 'connecting' }

/**
 * GPU (WebGL) renderer, held only while the pane is visible. xterm's default DOM
 * renderer rebuilds per-cell spans and reflows on every frame; the WebGL
 * renderer is markedly cheaper per frame under heavy output, which is why every
 * serious terminal (VS Code, Hyper) uses it. But each addon pins a WebGL2
 * context and a glyph texture atlas, and the browser caps live contexts at ~16
 * per page — so contexts follow visibility instead of pane lifetime:
 *
 * - acquired when an opened pane has a laid-out size (attach, observer refit);
 * - released when the pane is detached, disposed, or its host collapses to 0×0
 *   (hidden workspace, `display:none`) — a hidden pane draws nothing anyway;
 * - capped by `webglBudget`: past WEBGL_CONTEXT_BUDGET, the least recently
 *   visible holder falls back to the DOM renderer rather than letting the
 *   browser kill an arbitrary context;
 * - after a context loss the addon is disposed and re-acquired once, a moment
 *   later, if the pane is still visible (a pane that keeps losing its context
 *   stays on DOM until it is next hidden and shown; so does an evicted one).
 *
 * Disposing the addon swaps xterm back to the DOM renderer, which measures cells
 * with its own metrics — every swap ends in a refit.
 */
const webglBudget = createWebglBudget<Entry>(WEBGL_CONTEXT_BUDGET, (entry) => {
  // Stays on DOM until next hidden and shown, or two panes would evict each
  // other on every refit.
  entry.webglEvicted = true
  dropWebgl(entry, true)
})
const WEBGL_RETRY_MS = 1000
const WEBGL_MAX_LOSSES = 2
/** Set once WebglAddon fails to load (no WebGL2, GPU blocklisted): every pane
 *  stays on DOM instead of retrying — and evicting a holder — on each refit. */
let webglUnavailable = false

function isPaneVisible(entry: Entry): boolean {
  return entry.opened && entry.host.isConnected
    && entry.host.clientWidth > 0 && entry.host.clientHeight > 0
}

/** Bring the pane's renderer in line with its visibility. Cheap when unchanged. */
function syncWebgl(entry: Entry): void {
  if (!isPaneVisible(entry)) {
    releaseWebgl(entry)
    return
  }
  if (entry.webgl) {
    webglBudget.acquire(entry) // refresh its LRU position
    return
  }
  if (webglUnavailable || entry.webglEvicted || (entry.webglLosses ?? 0) >= WEBGL_MAX_LOSSES) return
  if (!webglBudget.acquire(entry)) return
  let addon: WebglAddon | undefined
  try {
    addon = new WebglAddon()
    const live = addon
    addon.onContextLoss(() => {
      if (entry.webgl !== live) return
      entry.webglLosses = (entry.webglLosses ?? 0) + 1
      dropWebgl(entry, true)
      // A fit that raced the loss (alt-tab/occlusion on Windows can drop the
      // GPU context mid-layout) may have collapsed cols/rows; the refit above
      // re-measures, and the retry re-acquires once the GPU is back.
      setTimeout(() => {
        if (entry.observer !== undefined) syncWebgl(entry)
      }, WEBGL_RETRY_MS)
    })
    entry.term.loadAddon(addon)
    entry.webgl = addon
  } catch {
    // WebGL2 unavailable — stay on the DOM renderer, for good.
    webglUnavailable = true
    webglBudget.release(entry)
    try { addon?.dispose() } catch { /* half-loaded */ }
  }
}

/** Free the pane's context (hidden, detached, disposed). Resets the loss count:
 *  the next show is a fresh attempt. */
function releaseWebgl(entry: Entry): void {
  entry.webglLosses = 0
  entry.webglEvicted = false
  if (entry.webgl) dropWebgl(entry, false)
}

function dropWebgl(entry: Entry, refit: boolean): void {
  webglBudget.release(entry)
  const addon = entry.webgl
  entry.webgl = undefined
  if (!addon) return
  try {
    addon.dispose()
  } catch {
    // Disposing after a lost context can throw inside the addon; the renderer
    // swap has already happened by then.
  }
  if (refit) setTimeout(() => refitEntry(entry), 0)
}

/** Fit the terminal to its host, skipping when the host has no laid-out size. */
function safeFit(entry: Entry): boolean {
  const { host, fit } = entry
  if (host.clientWidth === 0 || host.clientHeight === 0) return false
  try {
    fit.fit()
    return true
  } catch {
    return false
  }
}

// Observer-driven refits run once per frame across all terminals (see
// frame-batch.ts). Attach keeps its synchronous fit + flush: the pty must be at
// the attached size before the session starts.
const refitBatch = createFrameBatch<Entry>((entry) => {
  if (entry.observer !== undefined) refitEntry(entry)
})

/** Re-fit one terminal and push the new size to its pty only when it changed. */
function refitEntry(entry: Entry): void {
  // Never fit against a hidden/occluded layout: the dims measured there are
  // garbage (FitAddon's 2×1 floor) and would be pushed to the pty, making a
  // running TUI redraw at 2 columns. The focus/visibility refit in App.tsx
  // re-measures the moment the window is visible again.
  // Before the hidden-window return: a workspace switched away while the
  // window is minimised still frees its contexts on this tick.
  syncWebgl(entry)
  if (document.visibilityState === 'hidden') return
  const { cols, rows } = entry.term
  if (safeFit(entry) && (entry.term.cols !== cols || entry.term.rows !== rows)) {
    entry.ptyResize.schedule(entry.term.cols, entry.term.rows)
  }
}

/**
 * Re-fit every attached terminal. Wired to window focus / visibility regain in
 * App.tsx: a fit that lands while the window is occluded (Windows alt-tab, tray
 * round-trip) can measure a near-zero layout and collapse the pane to the
 * FitAddon's 2×1 minimum — and since the container's real size never changes
 * afterwards, the ResizeObserver stays silent and the pane wraps at 2 columns
 * forever. Re-measuring on "the user came back" makes any such bogus fit
 * transient instead of permanent. Cheap: fit() is a no-op when dims match, and
 * hidden hosts are skipped by the zero-size guard in safeFit.
 */
export function refitAttachedTerminals(): void {
  for (const entry of entries.values()) {
    if (entry.opened && entry.observer !== undefined) refitEntry(entry)
  }
}

/**
 * (Re)build the detection loop for this entry's agent. Called from attach
 * and respawn — the two places `config.agentId` can change. Plain terminals
 * get no detector at all; their dot stays the output-activity one.
 */
function refreshDetector(id: string, entry: Entry): void {
  const manifest = manifestForAgent(entry.config.agentId)
  if (entry.detector !== undefined && (manifest === undefined || manifest.id !== entry.detectorManifestId)) {
    entry.detector.dispose()
    entry.detector = undefined
    useAgentStateStore.getState().clear(id)
  }
  if (manifest === undefined || entry.detector !== undefined) return
  entry.detectorManifestId = manifest.id
  const deps: DetectorDeps = {
    getView: (): BufferView | null => {
      const e = entries.get(id)
      if (!e || !e.opened) return null
      const buffer = e.term.buffer.active
      return {
        rows: e.term.rows,
        length: buffer.length,
        line: (i) => buffer.getLine(i)?.translateToString(true) ?? ''
      }
    },
    isPaneWatched: () =>
      document.hasFocus() && selectFocusedTerminalId(useAppStore.getState()) === id,
    publish: (state, opts) => useAgentStateStore.getState().publish(id, state, opts),
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
  }
  entry.detector = new AgentStateDetector(manifest, deps)
  entry.detector.start()
}

/** Path link under the pointer per terminal (from the path link provider's hover/leave). */
const hoveredPaths = new Map<string, { text: string; resolved: string; isDir: boolean }>()
/** Per-terminal "follow this path link" — the same gesture-gated route a Ctrl+click takes. */
const pathFollowers = new Map<string, (event: MouseEvent, text: string) => void>()

/** The detected file path currently hovered in a terminal, if any (Ctrl+drag source). */
export function getHoveredPathLink(id: string): { text: string; resolved: string; isDir: boolean } | undefined {
  return hoveredPaths.get(id)
}

/** Open a path link as a Ctrl+click would (used when a Ctrl+press on a link never became a drag). */
/** Show a folder in Files: select it with its parents expanded, and expand it too. */
export function revealDirInFiles(id: string, dir: string): void {
  void (async () => {
    const [{ openFileContext }, { useExplorerStore }] = await Promise.all([import('@/tauri/files'), import('@/store/explorer-store')])
    const context = await openFileContext(id).catch(() => null)
    if (!context) return
    useAppStore.getState().revealTerminal(id)
    const explorer = useExplorerStore.getState()
    await explorer.reveal(context.id, dir)
    const root = useExplorerStore.getState().roots[context.id]
    if (root && !root.expanded.includes(dir)) useExplorerStore.getState().toggle(context.id, dir)
  })().catch(console.warn)
}

export function openPathLink(id: string, event: MouseEvent, text: string): void {
  const hovered = hoveredPaths.get(id)
  if (hovered?.isDir && hovered.text === text) { revealDirInFiles(id, hovered.resolved); return }
  // The press was captured before xterm saw it, so lastMouseDown is stale; a
  // stale point would make followLink's drag-vs-click check drop this click.
  const entry = entries.get(id)
  if (entry) entry.lastMouseDown = { clientX: event.clientX, clientY: event.clientY }
  pathFollowers.get(id)?.(event, text)
}

function getOrCreate(id: string): Entry {
  const existing = entries.get(id)
  if (existing) return existing

  const host = document.createElement('div')
  host.style.width = '100%'
  host.style.height = '100%'
  // Inset the terminal content from the pane edges so text isn't flush against
  // the border. Padding lives on the host (not the .xterm element) and the host
  // carries the terminal's own background, so the dark interior still bleeds to
  // the pane edges — only the rows are pushed inward. box-sizing keeps the host
  // filling the container despite the padding.
  host.style.boxSizing = 'border-box'
  host.style.padding = '6px 8px'
  // xterm opens into this padding-free child, never into the host itself. The
  // FitAddon sizes rows from getComputedStyle(parent).height, and for a
  // border-box element WebView2 reports that INCLUDING padding — so with the
  // host as parent it proposed up to 12px of rows too many and the last line
  // slid under the pane border (visible after dragging a split by hand).
  const mount = document.createElement('div')
  mount.style.width = '100%'
  mount.style.height = '100%'
  host.appendChild(mount)
  host.style.background = terminalTheme(useAppearanceStore.getState().style).background as string

  const text = useTerminalTextStore.getState().text
  host.style.fontFeatureSettings = ligatureFeatureSettings(text.ligatures)

  const term = new Terminal({
    // The find overlay's highlight-all decorations go through xterm's
    // registerDecoration, which is proposed API — without this flag the
    // SearchAddon throws inside findNext and the search silently finds
    // nothing (the regex guard in terminalSearchNext would swallow it).
    allowProposedApi: true,
    cursorBlink: true,
    fontFamily: text.fontFamily,
    fontSize: text.fontSize,
    lineHeight: text.lineHeight,
    scrollback: text.scrollback,
    windowsPty: windowsPtyOption(isWindowsPlatform(), windowsBuild),
    theme: { ...VSCODE_DARK_THEME, ...terminalTheme(useAppearanceStore.getState().style) }
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  const search = new SearchAddon()
  term.loadAddon(search)
  // xterm defaults to Unicode 6 widths (emoji = 1 cell); agent TUIs such as
  // Claude Code assume Unicode 11 (emoji = 2 cells), and the mismatch leaves
  // stray characters behind on partial redraws.
  enableUnicode11(term)
  // Forward the terminal title straight from the program running in the pty.
  // xterm parses the standard OSC 0/2 title escape sequences ("ESC ] 0 ; text
  // BEL") natively and fires onTitleChange — the same mechanism VS Code uses to
  // title its terminal tabs. Shells and modern agents (Claude Code) emit these,
  // so the pane header reflects "what this terminal is doing" with no agent
  // cooperation. Keyed by `id` (terminalId) so it survives remounts; an empty
  // title (some programs emit one to clear) reverts the header to its fallback.
  // Cap defensively — the header truncates visually, but a runaway title
  // shouldn't bloat the store.
  term.onTitleChange((title) => {
    const trimmed = title.replace(/\s+/g, ' ').trim()
    const store = useTerminalTitleStore.getState()
    if (trimmed) store.setTitle(id, trimmed.slice(0, 120))
    else store.clearTitle(id)
  })
  // Second title listener: detection needs the RAW title (spinner prefix and
  // spacing intact), not the header's whitespace-collapsed one above.
  term.onTitleChange((title) => {
    entries.get(id)?.detector?.noteTitle(title)
  })
  // OSC 9 progress (ConEmu-style "4;st;pct") — detection evidence only.
  term.parser.registerOscHandler(9, (data) => {
    entries.get(id)?.detector?.noteProgress(data)
    return true
  })
  // OSC 7 is how a shell reports its working directory ("ESC ] 7 ; file://host/path
  // BEL") — the same mechanism VS Code, kitty and WezTerm use. Handled here rather
  // than in Rust because the value is only consumed on this side, and because it
  // keeps the hot read_loop streaming path untouched. Returning true marks the
  // sequence handled so xterm doesn't pass it on.
  term.parser.registerOscHandler(7, (data) => {
    const dir = parseFileUrl(data)
    const entry = entries.get(id)
    if (dir && entry) entry.cwd = dir
    return true
  })
  // OSC 52 ("ESC ] 52 ; Pc ; Pd BEL") is how nvim `"+y`, tmux `set-clipboard`,
  // yazi and gh copy from inside a pane. xterm core has no handler and
  // @xterm/addon-clipboard is not installed, so without this the yank is
  // silently swallowed. WRITE-ONLY on purpose: a `?` read request is never
  // answered (it would type the user's clipboard into whatever program asked,
  // in whatever pane), and empty / malformed payloads never clear the
  // clipboard. No focus or visibility gate — VS Code writes from background
  // panes too, and a yank in an unfocused nvim must still land. Returning true
  // for EVERY outcome so nothing downstream can answer a read either.
  term.parser.registerOscHandler(52, (data) => {
    const r = parseOsc52(data)
    if (r.kind === 'write') writeClipboard(r.text).catch(console.warn)
    return true
  })
  // OSC 133 ("ESC ] 133 ; A|B|C|D[;exit] BEL") — FinalTerm shell-integration
  // marks, emitted only by shells the user wired up (guide §Shell integration;
  // nothing is injected into the pty). xterm core has no semantics for them.
  // Gated to plain Terminal panes PER MARK, not at registration: respawnTerminal
  // can switch this id between an agent and a plain shell, and an agent pane's
  // own shell prints the same marks around its hour-long `claude` run — the
  // agent state machine already owns that pane, so counting it here would
  // double-report. "Plain" means the template runs NO command
  // (`isPlainShellPane`), NOT "has no detection manifest": `omp` is
  // deliberately manifest-less (manifests/index.ts) yet runs `omp`, and any
  // future agent shipped before its manifest is the same shape — keying on the
  // manifest turned their run into a Git refresh + "Command finished" chime.
  // `refreshDetector` keeps `manifestForAgent`: detector presence really is
  // "has a manifest". Returning true keeps xterm from logging an unknown OSC.
  term.parser.registerOscHandler(133, (data) => {
    const entry = entries.get(id)
    if (entry === undefined || !isPlainShellPane(entry.config.agentId)) return true
    const mark = parseShellMark(data)
    if (mark !== null) useShellMarkStore.getState().applyMark(id, mark, Date.now())
    return true
  })
  // Fan out to the broadcast group when this terminal is an armed member;
  // otherwise this is the only target ([id]), so behaviour is unchanged. onData
  // fires only for the terminal the user is typing in, so `id` is always the
  // source of `data` — but every target pty in `targets` receives the SAME
  // characters and ends up holding the SAME half-typed line, so the War Room
  // typing signal has to be recorded per target, not just for the source.
  // Recorded here (rather than from a listener on each target) because this is
  // the one hook that sees genuine user input for the whole fan-out group: War
  // Room deliveries go through `writeTerminal` directly and bypass `onData`,
  // so a nudge can never mark its own recipient as "user typing". Paste
  // (term.paste) flows through onData too, so it fans out — and gets recorded
  // — for free. Each target pty echoes independently: this is real broadcast,
  // not a text mirror.
  // >0 while a reattached pane's history is being parsed (SWA-56): xterm
  // answers queries in it (DA, DSR, colour reports) through onData, and
  // those answers belong to a moment long gone — sent now they would land
  // in the running program as typed input. Keys typed in that window are
  // dropped too; accepted, since parsing the replay takes a frame or two.
  let replaying = 0
  const sendInput = (data: string): void => {
    if (replaying > 0) return
    // A focus report belongs to the pane that changed focus only: fanned out
    // it would type `ESC[I` into every broadcast member, and recorded as
    // typing it would hold that pane's War Room deliveries for a line the
    // user never typed.
    if (isFocusReport(data)) {
      const entry = entries.get(id)
      const isAgent = entry !== undefined && !isPlainShellPane(entry.config.agentId)
      if (!shouldDropFocusReport(isAgent, entry?.ptyStartedAt, Date.now())) {
        void writeTerminal(id, data)
      }
      return
    }
    const state = useAppStore.getState()
    const ws = selectWorkspaceByTerminalId(state, id)
    const targets = ws
      ? resolveBroadcastTargets(ws.layout, ws.broadcastActive, ws.broadcastLeafIds, id)
      : [id]
    for (const target of targets) {
      useTerminalTypingStore.getState().noteInput(target, data)
      void writeTerminal(target, data)
    }
    userInput?.()
  }
  term.onData(sendInput)

  // Hoisted above the input adapter below (which needs them for
  // `isThirdLevelShiftKey`) as well as the clipboard/link handling further
  // down (which already needed `isMac`) — one platform read per terminal,
  // not one per keystroke.
  const isMac = isMacPlatform()
  const isWindows = isWindowsPlatform()

  // Text input the macOS way. A native terminal is handed whole strings by
  // NSTextInputClient; in a webview the same insertion only shows up as a
  // change to xterm's hidden textarea, and xterm's keyboard path carries just a
  // subset of those through. So the textarea is treated as the input client:
  // `committed` is what this pane has already written to the pty for the
  // current segment, and every change to the textarea is reconciled against it.
  //
  // Listeners sit on `host`, not on the textarea, because xterm's own capture
  // listeners are registered first and same-element capture order is
  // registration order — only an ancestor can see the event first.
  let committed = ''

  // Whether xterm's own path — `_keyDown`'s cancel-and-send, or `_keyPress`'s
  // single-char fallback for a key `_keyDown` leaves alone (Space;
  // Option/AltGr chords, whose own `_isThirdLevelShift` check makes
  // `_keyDown` bail before it ever reaches `cancel()`) — already wrote this
  // keystroke's character, so a resulting `input` event must be swallowed
  // rather than diffed and sent a second time. See `nextSuppressState`'s own
  // doc comment in terminal-input-client.ts for the full event-ordering
  // argument (also the incident history: this is the second implementation
  // of this idea, the first got the ordering wrong).
  let suppressState: SuppressState = 'idle'

  // True from `compositionstart` until the deferred read in `compositionend`
  // (below) resolves. Spans every point at which this layer must not mutate
  // the textarea or trust `term.textarea.value` — whether from a keydown's
  // `resetSegment`, an `input` event's diff, or an external trigger like
  // paste/respawn/retry racing in from entirely outside any event.
  let compositionOpen = false

  // Discards the open segment without touching the textarea. The only caller
  // is compositionstart (see below) — composition is xterm's alone, and this
  // layer may not write to the textarea while one is active.
  const resetSegmentBaseline = (): void => {
    committed = ''
  }

  // Restarts the segment AND clears the textarea. For most keys left to xterm
  // it cancels its own default handling entirely, so the textarea never
  // actually changes and this clear is just bookkeeping ahead of that — but
  // Space and Option/AltGr chords are exceptions (see `isOrdinaryCharKey` and
  // `isThirdLevelShiftKey`), and diffing against stale text there would send
  // corrections for text the shell no longer has. Also reused as
  // `Entry.resetInputSegment` (assigned below) for paste/respawn/retry, which
  // move the pty line from entirely outside this textarea's `input` event and
  // so need the same invalidation — including, for a file drop mid-
  // composition, the same "never touch the textarea while composing" rule
  // `compositionOpen` enforces below, since none of those three callers have
  // any way to know a composition happens to be open when they're called.
  const resetSegment = (): void => {
    resetSegmentBaseline()
    if (!compositionOpen && term.textarea) term.textarea.value = ''
  }

  host.addEventListener(
    'keydown',
    (event) => {
      // Default assumption for every keydown: it doesn't own the write, so
      // any stale arm left over from an earlier, unrelated keystroke (one
      // xterm cancelled with no `input` AND whose `keyup` hasn't fired yet —
      // e.g. still being held down) does not leak into this one. Overwritten
      // below, once, only in the one branch that can actually arm it.
      suppressState = nextSuppressState(suppressState, { type: 'keydown', owns: false })

      if (ownsKeydown(event)) {
        // Keep it away from CompositionHelper, whose own textarea diff would
        // send a second, wrong copy of everything below.
        event.stopPropagation()
        return
      }
      if (event.isComposing) return
      if (ownsMultiCharKey(event)) {
        // XKey's CGEvent mode / macOS Telex's tone application: a correction
        // arriving as one multi-character keydown. `committed` must survive
        // this event untouched — the browser's default text insertion is
        // about to update the textarea, and the `input` listener below needs
        // the pre-correction baseline to compute real deletions. (This used
        // to be `ime-input.ts`'s job: it sent this text directly with zero
        // deletions, which only happened to be correct for XKey, whose own
        // real Backspace keydowns do the deleting separately — and was wrong
        // for macOS Telex, producing "banạn" instead of "bạn". See
        // `ownsMultiCharKey`, and the `attachCustomKeyEventHandler` callback
        // further below, which stops xterm's own truncated echo of this same
        // event at the `keypress` stage.)
        return
      }
      if (breaksSegment(event)) {
        resetSegment()
        // Built explicitly, not spread: KeyboardEvent's fields are inherited
        // prototype getters, not own properties, so `{ ...event }` silently
        // drops them all.
        const shiftEvent = {
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          keyCode: event.keyCode,
          altGraph: event.getModifierState('AltGraph')
        }
        const owns =
          isOrdinaryCharKey(event) ||
          isThirdLevelShiftKey(shiftEvent, {
            isMac,
            isWindows,
            // This app never sets `macOptionIsMeta` in `new Terminal({...})`
            // above, so `term.options.macOptionIsMeta` always reads back
            // `false` today — read live rather than assumed so this can't
            // silently drift out of sync if that option is ever turned on.
            macOptionIsMeta: term.options.macOptionIsMeta ?? false
          })
        suppressState = nextSuppressState(suppressState, { type: 'keydown', owns })
      }
    },
    true
  )

  // Ends an armed-but-unconsumed suppression: xterm cancelled the ordinary
  // letter's default (see above), so no `input` ever arrived to consume it,
  // and keyup is the one event guaranteed to fire strictly after `input` for
  // the SAME keystroke if one did occur — see `nextSuppressState`'s doc
  // comment for why this, and not a timer, is what closes the window.
  host.addEventListener(
    'keyup',
    () => {
      suppressState = nextSuppressState(suppressState, { type: 'keyup' })
    },
    true
  )

  host.addEventListener(
    'input',
    (event) => {
      const inputEvent = event as InputEvent
      if (!ownsInputEvent(inputEvent)) return
      event.stopPropagation()

      if (compositionOpen) {
        // A leftover of the composition that just ended: xterm's own
        // deferred send (see the `compositionend` listener below) is about
        // to handle the real commit on the same tick this resolves on.
        // Diffing this now would read `committed` before that tick sets it.
        return
      }

      if (shouldSuppressInput(suppressState)) {
        // xterm's own keydown/keypress path already sent this character
        // correctly (see `isOrdinaryCharKey` / `isThirdLevelShiftKey`) — this
        // `input` event is just the browser's default text insertion running
        // alongside it, which nothing cancelled. Swallow it rather than
        // diffing a second, possibly corrupted copy: WebKit substitutes
        // U+00A0 NBSP for a bare space bar press in the textarea, and the pty
        // must get the real byte xterm already sent, not a second, wrong one.
        suppressState = nextSuppressState(suppressState, { type: 'input' })
        resetSegment()
        return
      }

      const next = term.textarea?.value ?? ''
      const data = encodeEdit(diffToEdit(committed, next))
      committed = next
      if (data) sendInput(data)
    },
    true
  )

  // xterm's own `_handleTextAreaBlur` clears the textarea on focus loss
  // (`this.textarea.value = ""`), same as this layer's `resetSegment` does —
  // so mirroring it here on `host` (a click into another pane's header, a
  // workspace switch, a split collapse that re-appends `host` to a new
  // parent) introduces no new risk, only closes a gap: without it `committed`
  // keeps describing a segment the textarea has already lost, and the first
  // keystroke after refocusing is diffed against it. Concretely: type "bạn",
  // click away and back, type "m" — `diffToEdit('bạn', 'm')` would erase all
  // three characters the shell already has before "m" ever lands.
  host.addEventListener(
    'blur',
    () => {
      // If a composition were somehow still open here (WKWebView losing
      // focus without ever firing compositionend — the deferred tick this
      // flag guards would then never resolve), leaving `compositionOpen`
      // true would permanently disable this pane's diff path: every future
      // owned `input` event would be treated as a leftover composition
      // forever. Focus loss ends the segment unconditionally either way,
      // matching xterm's own unconditional `_handleTextAreaBlur`, so clear it
      // before `resetSegment` runs (letting that call perform its full
      // textarea clear too, not just the composition-safe baseline reset).
      compositionOpen = false
      resetSegment()
      // Also close out an armed-but-unconsumed suppression, the same way a
      // `keyup` would: hold a letter down (armed; xterm cancels its keydown,
      // so no `input` follows), mouse-click into another pane before
      // releasing the key, and the keyup fires on the newly focused element
      // — this host never sees it, so `suppressState` would otherwise stay
      // `armed` until whatever keydown happens next. In between, Dictation
      // or the Emoji & Symbols picker used right after clicking back in
      // would have its `insertText` wrongly swallowed. Blur is not a keyup,
      // but it ends the segment the same way, so it drives the same
      // transition.
      suppressState = nextSuppressState(suppressState, { type: 'keyup' })
    },
    true
  )

  // Composition belongs to xterm end to end — including the textarea itself.
  // xterm's own compositionstart/update/end listeners are bound WITHOUT
  // capture (bubble phase; see CompositionHelper), so this capture-phase
  // listener runs BEFORE `CompositionHelper.compositionstart()` reads
  // `_compositionPosition.start = textarea.value.length`. Writing to
  // `.value` here — even to clear it — changes what that read sees and is
  // exactly the kind of mutation-during-composition WebKit responds to by
  // aborting the composition outright. So only the baseline resets; the
  // textarea is left for xterm to read and drive.
  host.addEventListener(
    'compositionstart',
    () => {
      compositionOpen = true
      resetSegmentBaseline()
    },
    true
  )
  host.addEventListener(
    'compositionend',
    () => {
      // xterm's own CompositionHelper explicitly refuses to read the textarea
      // synchronously here — its comment: composition events fire before the
      // textarea changes on most browsers — and defers the read (and its own
      // send) to `setTimeout(…, 0)`. Reading `term.textarea.value` right now
      // would risk capturing a stale, pre-commit value on exactly the same
      // browsers that comment is about; mirror xterm's own timing rather than
      // guess at something better. `compositionOpen` stays true until this
      // tick resolves, so the `input` listener above ignores any leftover
      // `input` event xterm's own deferred send is about to also handle —
      // without that, WKWebView delivering the post-commit `input` as
      // `inputType: "insertText"` with `isComposing: false` would let this
      // layer diff a stale `committed` and send the composed text a second
      // time, alongside xterm's own pending send. CJK cannot be verified on
      // this machine, so matching xterm's own mechanism exactly is the goal,
      // not a bespoke alternative.
      setTimeout(() => {
        compositionOpen = false
        committed = term.textarea?.value ?? ''
      }, 0)
    },
    true
  )

  // Match VS Code: Ctrl+C copies the selection (Cmd+C on mac), Ctrl+V pastes.
  // Returning false stops xterm from forwarding the key to the pty, but does
  // NOT cancel the browser default action: without preventDefault() the
  // webview still fires a native `paste` event into xterm's hidden textarea,
  // which xterm pastes into the pty a second time (double-paste). So every
  // handled action also calls preventDefault(). Ctrl+C with no selection
  // returns true so the shell still receives SIGINT.
  const linkDeps = { findAvailableEditor, openInEditor, revealInFileManager }

  // Record where each press began. xterm's Linkifier already refuses a mouseup on
  // a different link than the mousedown, so dragging AWAY is handled; what it
  // misses is a drag that selects text inside one link's own bounds.
  host.addEventListener('mousedown', (e) => {
    const entry = entries.get(id)
    if (entry) entry.lastMouseDown = { clientX: e.clientX, clientY: e.clientY }
  })

  /**
   * The single activation path for every link kind and every source (OSC 8,
   * WebLinksAddon, the path provider). URLs go to the OS default browser — the
   * in-app preview column stays reserved for the `browser.open_preview` MCP
   * tool, i.e. for pages an agent decides to show you, not for every link you
   * click. Paths need Cmd/Ctrl because launching an external editor takes OS
   * focus away from the app; a path never reaches the OS default opener, which
   * would make a misclick on a script execute it.
   */
  const followLink = (event: MouseEvent, kind: LinkKind, target: string): void => {
    const entry = entries.get(id)
    if (isDragNotClick(entry?.lastMouseDown, event)) { devLog('link.skip-drag', { target }); return }
    if (!shouldFollowLink(event, isMac, kind)) { devLog('link.skip-modifier', { target }); return }

    if (kind === 'url') {
      openUrl(target).catch(console.warn)
      return
    }
    const { path, line, col } = parsePathSuffix(target)
    void resolvePathLink(getTerminalCwd(id) ?? '', path)
      .then(async (verbatim) => {
        if (!verbatim) return
        // Rust canonicalizes absolute Windows paths to `\\?\D:\…`; isSubPath
        // against the plain project root then fails and an in-project file was
        // sent to the external editor / file manager instead of the editor tab.
        const resolved = displayPath(verbatim)
        const [{ openFileContext }, { isSubPath }, { useDocumentStore }, { useExplorerStore }] = await Promise.all([
          import('@/tauri/files'), import('@/lib/files/ops'), import('@/store/document-store'), import('@/store/explorer-store')
        ])
        const context = await openFileContext(id).catch(() => null)
        devLog('link.follow', { target, resolved, root: context?.root ?? null })
        const ws = selectWorkspaceByTerminalId(useAppStore.getState(), id)
        const leaf = ws ? collectLeaves(ws.layout).find((l) => l.terminalId === id) : undefined
        if (context && leaf && isSubPath(context.root, resolved)) {
          useAppStore.getState().revealTerminal(id)
          // The explorer follows the focused terminal, so its root for `id` is this context.
          void useExplorerStore.getState().reveal(context.id, resolved).catch(console.warn)
          await useDocumentStore.getState().open(leaf.id, context, resolved, { line: line ?? 1, column: col ?? 1 })
          return
        }
        return openPathLocation(linkDeps, resolved, line, col)
      })
      .catch(console.warn)
  }

  // OSC 8 hyperlinks — what Claude Code emits since v2.1.x. Without a linkHandler
  // xterm's OscLinkProvider DROPS every non-http target (so file:// links never
  // appear at all) and sends http ones to a defaultActivate that calls confirm()
  // then window.open() — both wrong inside a Tauri webview. allowNonHttpProtocols
  // is what lets file:// through; classifyOscLink is the protection that permission
  // requires, refusing everything except http(s) and file.
  pathFollowers.set(id, (event, text) => followLink(event, 'path', text))
  const linkHandler: ILinkHandler = {
    allowNonHttpProtocols: true,
    activate: (event, text) => {
      const classified = classifyOscLink(text)
      if (classified) followLink(event, classified.kind, classified.target)
    }
  }
  term.options.linkHandler = linkHandler

  // Bare http(s) URLs in plain text. Kept on WebLinksAddon (its regex is well
  // tested) but routed through followLink so every link source shares one
  // gesture gate and one destination — the OS default browser.
  term.loadAddon(new WebLinksAddon((event, uri) => followLink(event, 'url', uri)))

  // Plain-text file paths — stack traces, tsc/eslint/pytest output. Async because
  // each candidate has to be checked against the filesystem in Rust before it is
  // allowed to become a link; a candidate that doesn't resolve is dropped, so
  // prose that merely looks path-shaped never underlines itself.
  term.registerLinkProvider({
    provideLinks(y, callback) {
      const lineText = term.buffer.active.getLine(y - 1)?.translateToString(true)
      if (!lineText) return callback(undefined)
      const candidates = detectPathCandidates(lineText)
      // A listing row's bare Name becomes a candidate too; listingDir() below
      // decides whether there is a listing header at all (else it never resolves).
      const entry = listingEntry(lineText)
      if (entry && !candidates.some((c) => c.start <= entry.start && c.end >= entry.end)) candidates.push(entry)
      if (candidates.length === 0) return callback(undefined)

      const cwd = getTerminalCwd(id) ?? ''
      // Bare names in a `dir` / Get-ChildItem listing are relative to its
      // "Directory:" header, not to the shell's cwd. Looked up lazily, once.
      let listing: string | null | undefined
      const listingDir = (): string | null => {
        if (listing !== undefined) return listing
        const buffer = term.buffer.active
        const above: string[] = []
        for (let i = y - 2; i >= Math.max(0, y - 302); i--) above.push(buffer.getLine(i)?.translateToString(true) ?? '')
        return (listing = listingDirAbove(above))
      }
      void Promise.all(
        candidates.map(async (c) => {
          const { path } = parsePathSuffix(c.text)
          const bare = !/[\\/]/.test(path)
          // Files first (cwd, then the listing folder for bare names); a name that
          // is no file may still be a folder — the `d-----` rows and the header path.
          let resolved = await resolvePathLink(cwd, path).catch(() => null)
          if (!resolved && bare && listingDir()) resolved = await resolvePathLink(listingDir()!, path).catch(() => null)
          let isDir = false
          if (!resolved) {
            resolved = await resolveDirLink(cwd, path).catch(() => null)
            if (!resolved && bare && listingDir()) resolved = await resolveDirLink(listingDir()!, path).catch(() => null)
            isDir = resolved !== null
          }
          if (!resolved) return null
          const shown = displayPath(resolved)
          const link: ILink = {
            // xterm buffer ranges are 1-based and inclusive; candidate indices
            // are 0-based with an exclusive end.
            range: { start: { x: c.start + 1, y }, end: { x: c.end, y } },
            text: c.text,
            // A folder never goes to an editor or the OS opener: Ctrl+click shows it in Files.
            activate: (event, text) => { if (isDir) { if (shouldFollowLink(event, isMac, 'path')) revealDirInFiles(id, shown) } else followLink(event, 'path', text) },
            hover: () => { hoveredPaths.set(id, { text: c.text, resolved: shown, isDir }) },
            leave: () => { if (hoveredPaths.get(id)?.text === c.text) hoveredPaths.delete(id) }
          }
          return link
        })
      )
        .then((links) => callback(links.filter((l): l is ILink => l !== null)))
        .catch(() => callback(undefined))
    }
  })
  term.attachCustomKeyEventHandler((event) => {
    // App.tsx's window-capture listener calls `event.preventDefault()` for a
    // claimed app shortcut (Cmd/Ctrl+B, +Shift+B, +F — see keybindings.ts),
    // but that only suppresses the BROWSER's default action; it does nothing
    // to xterm's OWN key handling, which lives entirely inside this same
    // event's later `_keyDown` — that method never checks
    // `event.defaultPrevented`. Left alone, `evaluateKeyboardEvent` maps a
    // bare Ctrl+<letter> to its control byte (Ctrl+F -> '\x06') and sends it
    // straight to the pty on top of whatever App.tsx did. Returning `false`
    // here makes `_keyDown` bail before that mapping runs — the same
    // mechanism the copy/paste branch below already relies on. Gated to
    // `keydown` only: `_keyPress` already refuses to send anything for a
    // ctrl/alt/meta-held combo on its own (see its own
    // `(ev.ctrlKey || ev.altKey || ev.metaKey) && !thirdLevelShift` bail), so
    // there's nothing left for this handler to intercept at that stage.
    if (event.type === 'keydown' && event.defaultPrevented && matchConfiguredShortcut(event, isMac) !== null) {
      event.preventDefault()
      return false
    }
    // xterm calls this same callback from `_keyDown`, `_keyPress` AND `_keyUp`
    // — not just keydown. For a multi-character correction (`ownsMultiCharKey`,
    // shared with the `keydown` listener above) the keydown stage needs no
    // help: `evaluateKeyboardEvent` has no branch for `key.length > 1`, so
    // `_keyDown` already leaves it alone. But because `_keyDown` never handled
    // it, `_keyPress` runs next and falls back to
    // `String.fromCharCode(ev.charCode)` — a single code unit — which would
    // truncate the correction to its first character and send that as an
    // unwanted extra write. Returning `false` here for the matching `keypress`
    // event stops `_keyPress` before it sends (it bails on exactly this check,
    // before it calls `cancel()`) WITHOUT calling `preventDefault()` — so the
    // browser's default text insertion, and the `input` event the adapter
    // above diffs, still happens. That `input` event — not this handler — is
    // this layer's one and only writer for these corrections.
    if (event.type === 'keypress' && ownsMultiCharKey(event)) return false

    // Shift+Enter in an agent pane: a line break in the prompt, not a submit
    // (see agent-newline.ts). Sent through `sendInput` so broadcast and the
    // War Room typing signal see it like any keystroke; the keypress stage is
    // swallowed too so `_keyPress` cannot add its own `\r`.
    const newline = agentNewlineFor(event, entries.get(id)?.config.agentId)
    if (newline !== null) {
      if (event.type === 'keydown') {
        event.preventDefault()
        sendInput(newline)
      }
      return false
    }

    const action = decideClipboardAction(event, { hasSelection: term.hasSelection(), isMac })
    if (action === 'copy') {
      event.preventDefault()
      const selection = term.getSelection()
      if (selection) writeClipboard(selection).catch(console.warn)
      return false
    }
    if (action === 'paste') {
      event.preventDefault()
      // Async read; fire-and-forget and suppress xterm's default handling now.
      // Text wins; only a text-less clipboard on a Claude Code/Codex pane is
      // tried as a screenshot (saved to a temp PNG whose path we paste — the
      // CLIs can't read the image off the clipboard here). Agent id is read
      // at paste time because a respawn can switch it.
      readClipboard()
        .then(async (text) => {
          if (text) return term.paste(text)
          if (!supportsImagePaste(entries.get(id)?.config.agentId)) return
          const path = await saveClipboardImage()
          const ref = path === null ? '' : imagePasteText(path)
          if (ref) term.paste(ref)
        })
        .catch(console.warn)
      return false
    }
    return true
  })

  const session = new TerminalSession(
    id,
    {
      write: (data, onParsed) => {
        // Every decoded pty chunk is one activity tick: the pane is "working"
        // while bytes flow (including agent spinner redraws) and goes idle after
        // ACTIVITY_IDLE_MS of silence.
        activityTracker.notify(id)
        entries.get(id)?.detector?.noteOutput()
        // Passive media detection: append-only here, scanned on a timer.
        noteMediaOutput(id, data)
        // The callback acks parsed bytes to Rust's flow gate (perf phase 2):
        // it fires only after xterm parsed this chunk, so a flood is paced
        // by the parser instead of piling up in the write queue.
        term.write(data, onParsed)
      },
      replay: ({ data, cols, rows, truncated }, onParsed) => {
        // The history was rendered at the host pane's size: parse it at that
        // size, so wrapped lines and cursor positions land where the program
        // put them, then fit to this pane. The pty goes one column narrower
        // and back, which makes a full-screen program repaint (as tmux does
        // on attach) and leaves the pty at the pane's real size. No activity
        // tick: none of this is new output.
        replaying += 1
        try { term.resize(Math.max(2, cols), Math.max(1, rows)) } catch { /* disposed */ }
        // Only the history is acked; the note is never counted (see helper).
        writeReplayHistory(term, data, truncated, () => {
          onParsed?.()
          replaying -= 1
          const entry = entries.get(id)
          if (!entry) return
          safeFit(entry)
          const c = entry.term.cols, r = entry.term.rows
          void resizeTerminal(id, Math.max(2, c - 1), r)
            .then(() => resizeTerminal(id, c, r))
            .catch(() => undefined)
        })
      }
    },
    { createTerminal, killTerminal, ackOutput, releaseOutput }
  )
  // Mirror pty death into the detector: the session is the source of truth for
  // exit/error, and the detector has no pty visibility of its own.
  let prevKind: TerminalStatus['kind'] = session.getStatus().kind
  session.subscribe(() => {
    const status = session.getStatus()
    const kind = status.kind
    const entry = entries.get(id)
    // Notification center: a pane dying while the user looks elsewhere is a
    // fact worth listing. Transition only — status repaints must not re-add.
    if (status.kind === 'exited' && prevKind !== 'exited') recordExit(id, status.exitCode)
    prevKind = kind
    // Stamped on the transition only, so later status repaints don't keep
    // re-opening the focus-report window.
    if (entry) {
      if (kind !== 'running') entry.ptyStartedAt = undefined
      else {
        entry.ptyStartedAt ??= Date.now()
        // Layout fitting can finish before an asynchronous native spawn has
        // inserted its PTY, so an earlier resize may have had no target.
        // Reapply the current geometry once this generation is ready.
        safeFit(entry)
        entry.ptyResize.flush(entry.term.cols, entry.term.rows)
      }
    }
    if (kind === 'exited' || kind === 'error') {
      entries.get(id)?.detector?.noteExit()
      // The pty behind the OSC 133 marks is gone: a `running` left here would
      // never see its D, and the next shell's first `D;0` must not close it.
      useShellMarkStore.getState().clear(id)
      // Rust forgets the context % on kill/read_loop too, but the renderer
      // clears as well so a respawned pane never paints the dead session's
      // number for the window between Exit and the next `agent:context` —
      // belt-and-braces, like mcp_clients.
      useContextUsageStore.getState().clear(id)
    }
  })

  const entry: Entry = {
    ptyResize: createResizeDebouncer({
      send: (cols, rows) => resizeTerminal(id, cols, rows),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (h) => window.clearTimeout(h as number)
    }),
    term,
    fit,
    search,
    host,
    mount,
    session,
    config: {},
    cwd: '',
    opened: false,
    resetInputSegment: resetSegment,
    isComposing: () => compositionOpen,
    zoomOffset: 0,
    wheelCarry: 0
  }
  entries.set(id, entry)
  attachWheelZoom(entry)
  return entry
}

/**
 * Mount the terminal into `container`: move its host there, (lazily) open xterm,
 * keep it sized to the container, and spawn the pty if it hasn't been already.
 * Safe to call repeatedly — remounts re-attach the same live terminal.
 */
export function attachTerminal(id: string, container: HTMLElement, config: AttachConfig): void {
  const entry = getOrCreate(id)
  entry.config = {
    ...config,
    // shellId is locked at first attach: subsequent remounts (e.g. when a sibling
    // pane closes and the split tree collapses) must NOT swap the retry shell
    // out from under the user.
    shellId: entry.config.shellId ?? config.shellId
  }
  refreshDetector(id, entry)
  // Seed the link-resolution cwd from the spawn config. OSC 7 overwrites this as
  // soon as the shell draws its first prompt; until then (and forever, in shells
  // that don't report it) the spawn directory is the best answer available.
  // `||` not `??` so an earlier OSC 7 value isn't clobbered by a later remount.
  entry.cwd = entry.cwd || config.cwd || ''
  container.appendChild(entry.host)

  if (!entry.opened) {
    terminalInitializers.enqueue(id, () => {
      if (entries.get(id) !== entry || !entry.host.isConnected || entry.host.parentElement !== container) return
      entry.term.open(entry.mount)
      entry.opened = true
      syncWebgl(entry)
      finishTerminalAttach(entry, container)
      const app = useAppStore.getState()
      if (entry.pendingFocus && !app.welcomeFocused && selectFocusedTerminalId(app) === id
        && !document.querySelector(OVERLAY_SELECTOR)
        && (isAnyTerminalFocused() || shouldReturnFocus(describeFocusedElement(document.activeElement)))) {
        entry.term.focus()
      }
      entry.pendingFocus = false
    })
    return
  }
  finishTerminalAttach(entry, container)
}

function finishTerminalAttach(entry: Entry, container: HTMLElement): void {
  // The pty must end up at whatever size the pane (re)attached at. The fit
  // just above already moved xterm, so the observer's initial delivery goes
  // through refitEntry with NO cols/rows delta and would skip the push —
  // and session.start() is a no-op for an already-running pty (remount via
  // split collapse). Push unconditionally here instead.
  if (safeFit(entry)) entry.ptyResize.flush(entry.term.cols, entry.term.rows)

  entry.observer?.disconnect()
  entry.observer = new ResizeObserver(() => {
    refitBatch.schedule(entry)
  })
  entry.observer.observe(container)

  entry.session.start({ ...entry.config, cols: entry.term.cols, rows: entry.term.rows })
}

/** Detach the terminal from the DOM without killing the pty (e.g. on remount). */
export function detachTerminal(id: string): void {
  terminalInitializers.cancel(id)
  const entry = entries.get(id)
  if (!entry) return
  entry.observer?.disconnect()
  entry.observer = undefined
  refitBatch.cancel(entry)
  entry.ptyResize.cancel()
  releaseWebgl(entry)
  entry.host.remove()
}

/** Permanently destroy a terminal: kill the pty, dispose xterm, drop the entry. */
export function disposeTerminal(id: string): void {
  terminalInitializers.cancel(id)
  hoveredPaths.delete(id)
  pathFollowers.delete(id)
  forgetMediaOutput(id)
  const entry = entries.get(id)
  if (!entry) return
  entry.observer?.disconnect()
  entry.observer = undefined
  refitBatch.cancel(entry)
  entry.ptyResize.cancel()
  releaseWebgl(entry)
  entry.session.dispose()
  entry.term.dispose()
  entry.host.remove()
  entries.delete(id)
  // Drop the pending idle timer WITHOUT firing its callback, then remove the
  // store entry — order matters so the timer can't re-add a cleared id.
  activityTracker.cancel(id)
  useTerminalActivityStore.getState().clear(id)
  useTerminalTypingStore.getState().clearTyping(id)
  useShellMarkStore.getState().clear(id)
  // …and the context chip, same reason.
  useContextUsageStore.getState().clear(id)
  // Same ordering concern as activityTracker above: dispose() clears the
  // detector's pending timer first so a late tick can't re-publish a state
  // for an id the store is about to drop.
  entry.detector?.dispose()
  useAgentStateStore.getState().clear(id)
}

/** Dispose every terminal whose id is not in `keep` (its leaf was removed). */
export function disposeOrphanTerminals(keep: Set<string>): void {
  for (const id of [...entries.keys()]) {
    if (!keep.has(id)) disposeTerminal(id)
  }
}

export function focusTerminal(id: string): void {
  const entry = entries.get(id)
  if (!entry) return
  if (!entry.opened) entry.pendingFocus = true
  else {
    entry.term.focus()
    // Focus counts as "seen": keeps the pane in use off the eviction end.
    if (entry.webgl) webglBudget.acquire(entry)
  }
}

/**
 * True when DOM focus is on some live terminal's own hidden input (xterm's
 * `textarea` — the same element `focusTerminal`/a click into the pane puts
 * focus on), i.e. a terminal genuinely owns the keyboard right now.
 *
 * Exists for callers that need to tell that apart from some OTHER app
 * textarea/input/select that happens to share the same DOM tag name.
 * `terminal-focus.ts`'s `shouldReturnFocus` can't make that distinction — it
 * only ever sees `document.activeElement.tagName`, and xterm's helper
 * textarea reports `TEXTAREA` exactly like a real app input does (see
 * App.tsx's Escape handler, the one caller so far: a naive
 * `shouldReturnFocus` check alone would also swallow Escape while a terminal
 * — the overwhelmingly common case for that shortcut — has focus).
 */
export function isAnyTerminalFocused(): boolean {
  const active = document.activeElement
  if (active === null) return false
  for (const entry of entries.values()) {
    if (entry.term.textarea === active) return true
  }
  return false
}

/**
 * Type `text` into a terminal as if the user pasted it. Routed through
 * `term.paste` rather than `writeTerminal` on purpose: paste flows through
 * `onData`, so it picks up the broadcast fan-out above for free instead of
 * duplicating that rule here. Also gets bracketed-paste framing, so a shell
 * treats the text as literal input and never runs it on its own.
 *
 * Resets the IME input segment first (see `Entry.resetInputSegment`):
 * `term.paste` writes straight to the pty and clears xterm's textarea itself,
 * which would otherwise leave the segment's `committed` baseline describing
 * text the pty no longer has.
 * No-op when the terminal is not live.
 */
export function pasteIntoTerminal(id: string, text: string): void {
  const entry = entries.get(id)
  if (!entry) return
  entry.resetInputSegment()
  entry.term.paste(text)
}

/**
 * Deliver a War Room payload's BODY to one pty: bracketed-paste framing when
 * the foreground app enabled it (agent CLIs do — the text arrives as one
 * literal block). Deliberately NOT routed through `term.paste`/onData like
 * pasteIntoTerminal: that path fans out to an armed broadcast group, and a
 * room delivery must reach exactly its recipient.
 *
 * Writes ONLY the body — no trailing Enter. Agent TUIs (Claude Code
 * included) deliberately ignore an Enter that arrives in the same stdin
 * flush as a bracketed paste — that's the guard that stops a pasted body's
 * own embedded newlines from self-submitting the paste early — so a `\r`
 * glued directly onto the paste's closing marker is swallowed by that guard
 * and the prompt is left sitting, unsubmitted, in the composer. The Enter
 * must arrive as its own later write instead: see `submitTerminalPrompt`,
 * which the War Room delivery scheduler calls after a delay.
 */
export function deliverPromptToTerminal(id: string, text: string): void {
  const entry = entries.get(id)
  if (!entry) return
  entry.resetInputSegment()
  // Sanitise BEFORE framing so the bracketed-paste markers added below are the
  // only ESCs on the wire: a body containing `\x1b[201~` would close the paste
  // early and the remainder would run as raw keystrokes in the recipient TUI.
  // This is the single choke point every War Room text crosses (execute body,
  // nudge, intro — the latter two interpolate renderer-supplied names), which
  // is why it lives here and not in the scheduler. pasteIntoTerminal is left
  // alone on purpose: the user pasting escape codes into their own pane is not
  // the threat. Proved by prompt-sanitize.test.ts + tsc — the delivery test
  // mocks this function wholesale and the registry needs xterm/DOM.
  // Parity with term.paste's own CRLF normalization: terminals expect CR for line breaks.
  const normalized = sanitizePromptText(text).replace(/\r?\n/g, '\r')
  const body = entry.term.modes.bracketedPasteMode ? `\x1b[200~${normalized}\x1b[201~` : normalized
  void writeTerminal(id, body)
}

/**
 * Submit a War Room prompt previously written by `deliverPromptToTerminal`:
 * writes just Enter, as its own stdin flush arriving later so the TUI treats
 * it as a real keypress rather than part of the paste (see that function's
 * doc comment for why a glued CR gets eaten). No-op for an unknown or
 * since-disposed terminal, same guard as every other entry point here. No
 * `resetInputSegment` call — nothing has been typed into this pane's
 * textarea between the body write and this call for that baseline to need
 * invalidating.
 */
export function submitTerminalPrompt(id: string): void {
  const entry = entries.get(id)
  if (!entry) return
  void writeTerminal(id, '\r')
}

/**
 * What the voice draft path (`lib/voice-delivery.ts`) needs to know about a
 * pane before writing: whether the foreground app framed pastes, and whether
 * an IME composition is open. Undefined for an unknown terminal.
 */
export function getTerminalDraftInfo(id: string): { bracketed: boolean; composing: boolean } | undefined {
  const entry = entries.get(id)
  if (!entry) return undefined
  return { bracketed: entry.term.modes.bracketedPasteMode, composing: entry.isComposing() }
}

/**
 * Invalidate the IME baseline after text reached the pty from outside the
 * textarea (same reason as `pasteIntoTerminal`). Must run BEFORE the typing
 * store marks the pane dirty, never after.
 */
export function resetTerminalInputSegment(id: string): void {
  entries.get(id)?.resetInputSegment()
}

/** Re-spawn the pty after exit/error, clearing the screen first. */
export function retryTerminal(id: string): void {
  const entry = entries.get(id)
  if (!entry) return
  if (!entry.opened) return
  entry.term.reset()
  // The pty this segment's committed baseline described is gone.
  entry.resetInputSegment()
  // Same reasoning applies to the War Room typing signal: a half-typed line
  // held over from the dead pty would hold this pane's future deliveries
  // (dirty survives until the user types and submits, or clicks Deliver now)
  // for a line that no longer exists anywhere.
  useTerminalTypingStore.getState().clearTyping(id)
  // And to the OSC 133 state: a `running` left over from the dead pty would
  // turn the new shell's first `D;0` into a finished command.
  useShellMarkStore.getState().clear(id)
  // …and the context chip, same reason.
  useContextUsageStore.getState().clear(id)
  // And to the detector: it holds evidence (title/progress/pending-idle) from
  // the dead pty, which the new one hasn't produced.
  entry.detector?.reset()
  safeFit(entry)
  entry.session.retry({ ...entry.config, cols: entry.term.cols, rows: entry.term.rows })
}

/**
 * Re-spawn the pty with a new config (agent command / cwd / shell). Unlike
 * `attachTerminal`, this is a deliberate user action, so it DOES override the
 * shellId that attach locks in. Clears the screen, then restarts the pty.
 */
export function respawnTerminal(id: string, config: AttachConfig): void {
  const entry = entries.get(id)
  if (!entry) return
  entry.config = { ...entry.config, ...config }
  // Agent id may have just changed (agent switch) — rebuild the detector for
  // the new manifest before resetting it below, so reset() acts on the loop
  // that's actually about to watch the new pty, not a stale one for the
  // previous agent.
  refreshDetector(id, entry)
  if (!entry.opened) {
    entry.cwd = config.cwd ?? ''
    return
  }
  entry.term.reset()
  // The pty this segment's committed baseline described is gone.
  entry.resetInputSegment()
  // Same reasoning applies to the War Room typing signal: a half-typed line
  // held over from the dead pty would hold this pane's future deliveries
  // (dirty survives until the user types and submits, or clicks Deliver now)
  // for a line that no longer exists anywhere.
  useTerminalTypingStore.getState().clearTyping(id)
  // And to the OSC 133 state: a `running` left over from the dead pty would
  // turn the new shell's first `D;0` into a finished command.
  useShellMarkStore.getState().clear(id)
  // …and the context chip, same reason.
  useContextUsageStore.getState().clear(id)
  // And to the link-resolution cwd. `attachTerminal` seeds it with `||` on
  // purpose so a remount never clobbers an OSC 7 value — but a respawn is a
  // NEW pty whose OSC 7 history starts empty, and a shell without the
  // integration snippet (fish, pwsh, cmd.exe, Linux zsh) never reports one,
  // so without this the dead pty's last directory keeps resolving path links,
  // the Git-panel scope and War Room join (`getTerminalCwd` readers). The
  // INCOMING cwd, not the merged `entry.config.cwd`: a respawn that omits it
  // reads as "unknown" (⇒ `undefined` ⇒ leaf/workspace cwd, like a fresh
  // pane), not "same as before". Don't unify with attach's `||`.
  entry.cwd = config.cwd ?? ''
  // And to the detector: it holds evidence (title/progress/pending-idle) from
  // the dead pty, which the new one hasn't produced.
  entry.detector?.reset()
  safeFit(entry)
  entry.session.respawn({ ...entry.config, cols: entry.term.cols, rows: entry.term.rows })
}

/**
 * Resolve once a terminal has finished relocating (respawn: old pty killed, new
 * pty up). The session emits `connecting` then, only after the old pty exits,
 * `running` — so a settled state after a `connecting` means the OLD pty (and its
 * Job-Object child tree) is dead and any cwd it held is released. Used before
 * deleting a worktree so the delete never races a live pty (which on Windows
 * guts the directory then fails rmdir, leaving a husk). A timeout backstop keeps
 * a stuck pane from hanging the caller.
 */
export function awaitTerminalRelocated(id: string, timeoutMs = 4000): Promise<void> {
  const entry = entries.get(id)
  if (!entry) return Promise.resolve()
  return new Promise((resolve) => {
    let sawConnecting = entry.session.getStatus().kind === 'connecting'
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      unsub()
      clearTimeout(timer)
      resolve()
    }
    const unsub = entry.session.subscribe(() => {
      const k = entry.session.getStatus().kind
      if (k === 'connecting') sawConnecting = true
      else if (sawConnecting) finish()
    })
    const timer = setTimeout(finish, timeoutMs)
  })
}

/**
 * Pty generation of a live terminal (undefined when unknown). Callers that
 * type into a pane after an await capture it first and re-check before the
 * write, so a respawn in between never receives text meant for its predecessor.
 */
export function getTerminalGeneration(id: string): number | undefined {
  return entries.get(id)?.session.getGeneration()
}

export function getTerminalStatus(id: string): TerminalStatus {
  return entries.get(id)?.session.getStatus() ?? NO_STATUS
}

/** The terminal's live cwd — OSC 7 if the shell reports it, else the spawn cwd. */
/** Perf harness hook (tests/perf/flood.perf.ts, scenario f) only: live WebGL
 *  contexts and visible panes that render with the DOM fallback instead. */
export function perfRendererStats(): { webgl: number; domVisible: number; visible: number } {
  let webgl = 0
  let domVisible = 0
  let visible = 0
  for (const entry of entries.values()) {
    if (entry.webgl) webgl++
    if (!isPaneVisible(entry)) continue
    visible++
    if (!entry.webgl) domVisible++
  }
  return { webgl, domVisible, visible }
}

/** Last `lines` rows of a terminal's buffer as text — for the dev test hook (testlab) only. */
export function readTerminalText(id: string, lines = 40): string {
  const buffer = entries.get(id)?.term.buffer.active
  if (!buffer) return ''
  const out: string[] = []
  // Up to the cursor row, not buffer.length: a fresh shell's prompt sits at the
  // top and everything below it is blank rows.
  const end = buffer.baseY + buffer.cursorY + 1
  for (let y = Math.max(0, end - lines); y < end; y++) out.push(buffer.getLine(y)?.translateToString(true) ?? '')
  return out.join('\n').replace(/\s+$/, '')
}

/** Screen box and cell size of a terminal — for the dev test hook (testlab) only. */
export function terminalGeometry(id: string): { x: number; y: number; cellW: number; cellH: number; cols: number; rows: number; cursorY: number } | null {
  const entry = entries.get(id)
  const screen = entry?.term.element?.querySelector('.xterm-screen')
  if (!entry || !screen) return null
  const r = screen.getBoundingClientRect()
  return { x: r.x, y: r.y, cellW: r.width / entry.term.cols, cellH: r.height / entry.term.rows, cols: entry.term.cols, rows: entry.term.rows, cursorY: entry.term.buffer.active.cursorY }
}

export function getTerminalCwd(id: string): string | undefined {
  return entries.get(id)?.cwd || undefined
}

/** The agent template id this terminal was spawned with, if any. */
export function getTerminalAgentId(id: string): string | undefined {
  return entries.get(id)?.config.agentId
}

/**
 * Route one `agent:hook` event (App.tsx subscription) into the pane's detector.
 * Gated on the Claude Code manifest, NOT on "has a detector": a `claude`
 * launched by hand inside a Codex/Gemini/other agent pane inherits that pane's
 * `SWARMTERM_SESSION` and would otherwise drive the wrong detector with edges
 * the Codex screen never shows. Only the Claude Code manifest was tuned
 * against these hooks (its visibleIdle/visibleBlocker flags are what
 * `resolveHookState` arbitrates on), so every other pane keeps following its
 * screen alone. Plain Terminal panes have no detector and fall through too.
 */
export function noteAgentHook(id: string, signal: AgentHookSignal): void {
  const e = entries.get(id)
  if (e?.detectorManifestId !== 'claude-code') return
  e.detector?.noteHook(signal)
}

export function subscribeTerminalStatus(id: string, listener: () => void): () => void {
  return entries.get(id)?.session.subscribe(listener) ?? (() => {})
}

// --- find overlay (SearchOverlay.tsx) -------------------------------------
// Thin wrappers around each terminal's SearchAddon: components only ever see
// these functions, never the addon itself, matching every other entry point
// in this file.

export interface TerminalSearchOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
  /** True while typing in the find input: re-run the match under the cursor
   *  instead of advancing (VS Code behavior). */
  incremental?: boolean
}

/**
 * VS Code Dark Modern find-widget palette (editor.findMatchBackground /
 * findMatchHighlightBackground), used verbatim so the in-terminal highlight
 * matches the rest of the app's chrome. Decorations must be re-supplied on
 * EVERY search call — the addon only draws them for calls that carry the
 * `decorations` field, it does not "stay enabled" after the first one.
 */
function searchOptions(opts: TerminalSearchOptions): ISearchOptions {
  return {
    caseSensitive: opts.caseSensitive,
    wholeWord: opts.wholeWord,
    regex: opts.regex,
    incremental: opts.incremental,
    decorations: {
      activeMatchBackground: '#9E6A03',
      activeMatchColorOverviewRuler: '#9E6A03',
      matchBackground: '#EA5C0055',
      matchOverviewRuler: '#EA5C0055'
    }
  }
}

/**
 * Advance to the next match. A no-op when the terminal is dead (pane closed
 * mid-search) or when `query` is malformed regex — `regex: true` hands the
 * query straight to `RegExp(...)` with no validation of its own, so a
 * trailing `\` or unbalanced `(` throws a SyntaxError the caller (the find
 * input's onChange) must not have to guard against on every keystroke.
 */
export function terminalSearchNext(id: string, query: string, opts: TerminalSearchOptions): void {
  const entry = entries.get(id)
  if (!entry) return
  try {
    entry.search.findNext(query, searchOptions(opts))
  } catch (err) {
    // Bad regex syntax mid-type is expected (SyntaxError); anything else is a
    // real search failure and swallowing it silently is how the missing
    // allowProposedApi flag went unnoticed — surface it.
    if (!(err instanceof SyntaxError)) console.warn('terminal search failed', err)
  }
}

/** Same as `terminalSearchNext`, searching backwards. */
export function terminalSearchPrevious(id: string, query: string, opts: TerminalSearchOptions): void {
  const entry = entries.get(id)
  if (!entry) return
  try {
    entry.search.findPrevious(query, searchOptions(opts))
  } catch (err) {
    // See terminalSearchNext: SyntaxError = user's mid-typed regex, expected.
    if (!(err instanceof SyntaxError)) console.warn('terminal search failed', err)
  }
}

/**
 * Drop every match highlight AND the terminal's own text selection —
 * `findNext`/`findPrevious` select the active match on the underlying
 * `Terminal` (visible under the decoration), so `clearDecorations()` alone
 * would leave that selection showing once the decoration is gone.
 */
export function clearTerminalSearch(id: string): void {
  const entry = entries.get(id)
  if (!entry) return
  entry.search.clearDecorations()
  entry.term.clearSelection()
}

/** Subscribe to match-count updates; no-op unsubscribe when the terminal is dead. */
export function onTerminalSearchResults(
  id: string,
  cb: (r: { resultIndex: number; resultCount: number }) => void
): () => void {
  const entry = entries.get(id)
  if (!entry) return () => {}
  const disposable = entry.search.onDidChangeResults(cb)
  return () => disposable.dispose()
}

/** Apply this pane's effective font size (global + its own zoom) and reflow. */
function applyPaneFontSize(entry: Entry): void {
  const size = paneFontSize(useTerminalTextStore.getState().text.fontSize, entry.zoomOffset)
  if (entry.term.options.fontSize === size) return
  entry.term.options.fontSize = size
  refitEntry(entry)
}

/**
 * Ctrl+mouse wheel resizes the text (Settings → Terminal picks this pane,
 * every pane, or off). Returning false stops xterm from scrolling AND from
 * forwarding the wheel to a TUI with mouse tracking on (Claude Code
 * fullscreen), which would otherwise scroll its view as well. preventDefault
 * keeps WebView2 from page-zooming the whole UI.
 */
function attachWheelZoom(entry: Entry): void {
  entry.term.attachCustomWheelEventHandler((event) => {
    const store = useTerminalTextStore.getState()
    const mode = store.text.wheelZoom
    // Same modifier as the reset shortcut (Mod+0): Cmd on mac, Ctrl elsewhere.
    const isMac = isMacPlatform()
    const zoomKey = isMac ? event.metaKey : event.ctrlKey
    const otherKey = isMac ? event.ctrlKey : event.metaKey
    if (!zoomKey || otherKey || event.altKey || mode === 'off') return true
    event.preventDefault()
    const { steps, carry } = wheelZoomSteps(event, entry.wheelCarry)
    entry.wheelCarry = carry
    if (steps === 0) return false
    if (mode === 'global') {
      store.setFontSize(store.text.fontSize + steps)
    } else {
      entry.zoomOffset = clampZoomOffset(store.text.fontSize, entry.zoomOffset + steps)
      applyPaneFontSize(entry)
    }
    return false
  })
}

/**
 * Ctrl+0: undo the zoom. Per-pane mode drops only this pane's offset; global
 * mode puts the shared size back to the default. Returns false when there was
 * nothing to claim (mode off), so the key can reach the pane.
 */
export function resetTerminalZoom(id: string): boolean {
  const store = useTerminalTextStore.getState()
  if (store.text.wheelZoom === 'off') return false
  if (store.text.wheelZoom === 'global') {
    store.setFontSize(DEFAULT_TERMINAL_TEXT.fontSize)
    return true
  }
  const entry = entries.get(id)
  if (!entry) return false
  entry.zoomOffset = 0
  applyPaneFontSize(entry)
  return true
}

/**
 * Push the latest text prefs onto every live terminal, then reflow so cols/rows
 * follow the new metrics. Font family/size/line-height set xterm options
 * directly; ligatures are a CSS feature on the host element (xterm's DOM
 * renderer inherits it into the rows).
 */
export function applyTerminalText(pref: TerminalTextPref): void {
  for (const entry of entries.values()) {
    entry.term.options.fontFamily = pref.fontFamily
    // Per-pane zoom only exists in 'pane' mode; switching away snaps back.
    if (pref.wheelZoom !== 'pane') entry.zoomOffset = 0
    entry.term.options.fontSize = paneFontSize(pref.fontSize, entry.zoomOffset)
    entry.term.options.lineHeight = pref.lineHeight
    // Shrinking trims the buffer at once — the cheap way to hand memory back.
    if (entry.term.options.scrollback !== pref.scrollback) entry.term.options.scrollback = pref.scrollback
    entry.host.style.fontFeatureSettings = ligatureFeatureSettings(pref.ligatures)
    refitEntry(entry)
  }
}

// Push text-preference changes to every live terminal. Subscribing here (rather
// than the store importing the registry) keeps the dependency one-directional.
useTerminalTextStore.subscribe((state) => applyTerminalText(state.text))

useAppearanceStore.subscribe((state, previous) => {
  if (state.style === previous.style) return
  const palette = terminalTheme(state.style)
  for (const entry of entries.values()) {
    entry.term.options.theme = { ...VSCODE_DARK_THEME, ...palette }
    entry.host.style.background = palette.background as string
  }
  // Font loading and density can change pane dimensions after the palette update.
  void document.fonts.ready.then(() => refitAttachedTerminals())
})
