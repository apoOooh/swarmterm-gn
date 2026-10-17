use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, OnceLock};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

/// Windows Job Object helper. Killing a pty's shell with `TerminateProcess`
/// leaves its child/grandchild processes running (Windows does not cascade a
/// kill down the tree). Putting the shell in a job created with
/// `KILL_ON_JOB_CLOSE` means terminating — or merely dropping — the job tears
/// down every descendant, so closing a pane/workspace actually frees the CPU+RAM.
#[cfg(windows)]
pub(crate) mod job {
    use std::ffi::c_void;
    use std::mem;
    use std::ptr;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
        JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    /// Owns a kill-on-close job handle. On drop the last handle closes, which
    /// terminates any process still in the job — a safety net against orphans.
    pub struct JobHandle(HANDLE);

    // A job handle is an opaque kernel handle; it is sound to move/share across
    // threads (it lives in the Mutex-guarded terminal map).
    unsafe impl Send for JobHandle {}
    unsafe impl Sync for JobHandle {}

    impl JobHandle {
        /// Create a kill-on-close job and place process `pid` in it. Every process
        /// the shell spawns afterwards inherits the job, so the whole tree is
        /// captured. Returns `None` if any Win32 step fails (caller degrades to
        /// the plain single-process kill).
        pub fn capturing(pid: u32) -> Option<Self> {
            unsafe {
                let job = CreateJobObjectW(ptr::null(), ptr::null());
                if job.is_null() {
                    return None;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let set = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const c_void,
                    mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if set == 0 {
                    CloseHandle(job);
                    return None;
                }
                let proc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
                if proc.is_null() {
                    CloseHandle(job);
                    return None;
                }
                let assigned = AssignProcessToJobObject(job, proc);
                CloseHandle(proc);
                if assigned == 0 {
                    CloseHandle(job);
                    return None;
                }
                Some(JobHandle(job))
            }
        }

        /// Immediately terminate the shell and all of its descendants.
        pub fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }

        /// Number of processes still alive in the job, or `None` if the query
        /// fails (callers then stop waiting and terminate).
        pub fn active_processes(&self) -> Option<u32> {
            unsafe {
                let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = mem::zeroed();
                let ok = QueryInformationJobObject(
                    self.0,
                    JobObjectBasicAccountingInformation,
                    &mut info as *mut _ as *mut c_void,
                    mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    ptr::null_mut(),
                );
                (ok != 0).then_some(info.ActiveProcesses)
            }
        }
    }

    impl Drop for JobHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

/// Output streamed to the renderer over a per-terminal channel.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type", content = "payload")]
pub enum PtyOut {
    Data(String),
    Exit {
        #[serde(rename = "exitCode")]
        exit_code: i32,
    },
}

/// Options the renderer passes when asking the backend to spawn a pty.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTerminalOptions {
    pub account_id: Option<String>,
    pub agent_id: Option<String>,
    pub cwd: Option<String>,
    pub shell_id: Option<String>,
    pub initial_command: Option<String>,
    /// Whether the owning workspace enables MCP worktree tools for this pty.
    pub worktree_mode: Option<bool>,
    /// The workspace's repo folder, recorded so worktree tools can resolve the
    /// main root even when this pane's own cwd is a linked worktree.
    pub repo_root: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

/// Flat result mirroring the original TS discriminated union (`ok` / `error`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTerminalResult {
    pub ok: bool,
    pub pid: Option<u32>,
    pub shell: Option<String>,
    pub error: Option<String>,
}

impl CreateTerminalResult {
    pub fn err(msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            pid: None,
            shell: None,
            error: Some(msg.into()),
        }
    }
}

/// Input for one pty generation. The blocking `write_all` runs on that
/// generation's own writer thread: a full ConPTY input pipe (big paste into a
/// busy agent) used to stall the main thread AND every other `terminals` lock
/// user. Commands only enqueue, under the lock, so ordering is the enqueue
/// order and a respawn (new generation, new queue) can never receive bytes
/// meant for the old one. A writer parked in `write_all` is not interruptible;
/// it ends when the master closes the pipe (shutdown drops it), and queued
/// bytes are then discarded with the dropped receiver.
///
/// Queued-but-unwritten bytes are capped (INPUT_QUEUE_MAX_BYTES): a hung agent
/// whose input pipe is full would otherwise grow the queue without limit.
pub struct PtyInput {
    tx: std::sync::mpsc::Sender<Vec<u8>>,
    queued: Arc<std::sync::atomic::AtomicUsize>,
    cap: usize,
}

/// Upper bound on bytes waiting for one pty's writer thread.
const INPUT_QUEUE_MAX_BYTES: usize = 8 * 1024 * 1024;

/// Slice size for the writer thread's pty writes.
const WRITE_CHUNK: usize = 64 * 1024;

impl PtyInput {
    pub fn spawn(writer: Box<dyn Write + Send>) -> Self {
        Self::with_cap(writer, INPUT_QUEUE_MAX_BYTES)
    }

    fn with_cap(mut writer: Box<dyn Write + Send>, cap: usize) -> Self {
        use std::sync::atomic::Ordering;
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let queued = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let drained = queued.clone();
        std::thread::spawn(move || {
            while let Ok(mut bytes) = rx.recv() {
                // Coalesce whatever queued behind a slow write into one write.
                while let Ok(more) = rx.try_recv() {
                    bytes.extend_from_slice(&more);
                }
                // Written in slices so a big paste frees its queue budget as
                // it drains, not only after the very last byte. Budget is
                // released only once written, so a stuck write still counts.
                let mut written = Ok(());
                for chunk in bytes.chunks(WRITE_CHUNK) {
                    written = writer.write_all(chunk);
                    if written.is_err() {
                        break;
                    }
                    drained.fetch_sub(chunk.len(), Ordering::AcqRel);
                }
                if written.and_then(|_| writer.flush()).is_err() {
                    // The pipe is gone: later sends fail with "target-gone".
                    break;
                }
            }
        });
        PtyInput { tx, queued, cap }
    }

    /// Queue bytes for the pty. Err "target-gone" when the writer thread is
    /// gone (pipe closed), "input-queue-full" when the pty is not draining.
    /// An empty queue always accepts one write, however big: the cap guards
    /// against a pty that stopped reading, not against one large paste into
    /// an idle pane (the writer thread drains it in `WRITE_CHUNK` slices).
    pub fn send(&self, data: &[u8]) -> Result<(), String> {
        use std::sync::atomic::Ordering;
        let len = data.len();
        self.queued
            .try_update(Ordering::AcqRel, Ordering::Acquire, |q| {
                (q == 0 || q + len <= self.cap).then_some(q + len)
            })
            .map_err(|_| "input-queue-full".to_string())?;
        self.tx.send(data.to_vec()).map_err(|_| {
            self.queued.fetch_sub(len, Ordering::AcqRel);
            "target-gone".to_string()
        })
    }
}

/// A live pty the manager owns. `master` is kept for resize; `input` for input;
/// `killer` to terminate the child from the command thread. On Windows `job`
/// (when set) owns the shell's whole process tree so closing the terminal frees
/// every descendant, not just the shell.
pub struct ManagedTerminal {
    pub spawn_id: String,
    /// Shell process id; root of the tree `terminal_agent_alive` searches.
    pub pid: Option<u32>,
    pub agent_id: Option<String>,
    /// Configured spawn cwd; OSC 7 shell navigation must not change the explorer's root.
    pub cwd: std::path::PathBuf,
    pub input: PtyInput,
    pub master: Box<dyn MasterPty + Send>,
    pub killer: Box<dyn ChildKiller + Send + Sync>,
    #[cfg(windows)]
    pub job: Option<job::JobHandle>,
    pub worktree_mode: bool,
    pub repo_root: Option<String>,
    /// A Claude account profile's own `CLAUDE_CONFIG_DIR` (SWA-58: where the
    /// excerpt reader looks for this pane's transcripts). `None` = default.
    pub claude_config_dir: Option<std::path::PathBuf>,
}

impl ManagedTerminal {
    /// Close the terminal the way a regular terminal window does, then make
    /// sure nothing survives. Returns the thread enforcing the deadline, if any.
    ///
    /// Why not just `kill()`: `TerminateJobObject` is a hard kill, so programs
    /// never run their exit handlers. Claude Code records every fullscreen
    /// launch on disk and clears the record on a clean exit; a process that
    /// vanishes before startup finished counts as a fullscreen crash, and after
    /// two strikes it turns fullscreen off machine-wide. Windows Terminal
    /// closes the pseudo console instead, which sends CTRL_CLOSE_EVENT to every
    /// attached process and lets it shut down. We do the same, give the tree
    /// `KILL_GRACE` to exit, and only then terminate the job — so the
    /// "no orphans" guarantee still holds.
    pub fn shutdown(self) -> Option<std::thread::JoinHandle<()>> {
        #[cfg(windows)]
        {
            let ManagedTerminal {
                input,
                master,
                killer,
                job,
                ..
            } = self;
            let Some(job) = job else {
                let mut killer = killer;
                let _ = killer.kill();
                return None;
            };
            // The deadline starts now and is enforced by its own thread: on
            // pre-24H2 conhost, ClosePseudoConsole can block until the clients
            // detach, so the close runs off the caller's (command/quit) thread
            // and can never delay the hard kill past KILL_GRACE.
            let deadline = std::time::Instant::now() + KILL_GRACE;
            std::thread::spawn(move || {
                // Dropping the sender ends the writer thread once it is idle;
                // one parked in write_all is released by the master close.
                drop(input);
                // ClosePseudoConsole: delivers CTRL_CLOSE_EVENT and closes the
                // output pipe, so the reader sees EOF and emits Exit as before.
                drop(master);
            });
            Some(std::thread::spawn(move || {
                while std::time::Instant::now() < deadline
                    && job.active_processes().is_some_and(|n| n > 0)
                {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                job.terminate();
                let mut killer = killer;
                let _ = killer.kill();
            }))
        }
        #[cfg(not(windows))]
        {
            let mut killer = self.killer;
            let _ = killer.kill();
            None
        }
    }
}

/// How long a closed pane's process tree may take to exit on its own before
/// it is terminated. Windows gives CTRL_CLOSE_EVENT handlers 5 s; most agents
/// need well under one.
#[cfg(windows)]
const KILL_GRACE: std::time::Duration = std::time::Duration::from_secs(3);

/// Global backend state managed by Tauri.
pub struct AppState {
    pub terminals: Mutex<HashMap<String, ManagedTerminal>>,
    /// Set when the user picks Quit from the tray, so close-to-tray is bypassed.
    pub quitting: AtomicBool,
    /// The MCP server's Streamable-HTTP endpoint URL. Set once by `mcp::start`
    /// at app boot; read by `spawn_terminal` to seed each shell's env, and by
    /// nothing else. `OnceLock` is used so the read side needs no lock; if the
    /// server failed to bind the cell stays empty and `spawn_terminal` skips
    /// the env injection (browser preview via MCP just won't work).
    pub mcp_url: OnceLock<Arc<str>>,
    /// War Room membership + inboxes, now multiple independent rooms. Its own
    /// lock (never nested with `terminals`) so MCP tools keep the
    /// lock-read-drop-before-await rule.
    pub war_rooms: Mutex<crate::warroom::WarRooms>,
    /// Panes an MCP client has actually spoken to us from. Its own lock, never
    /// nested with `terminals` or `war_rooms`, because the `/mcp` middleware
    /// touches it on every inbound request and must not contend with pty I/O.
    pub mcp_clients: Mutex<crate::mcp::clients::McpClients>,
    /// Last context-window percentage each Claude pane's status line reported
    /// via `/status?ctx=` (`mcp::context_usage`). Its own lock, never nested:
    /// `/status` hits it as often as every 300 ms per Claude pane while
    /// streaming, so it must not queue behind pty spawn/kill or MCP traffic.
    pub context_usage: Mutex<crate::mcp::context_usage::ContextUsage>,
    /// Last broadcast `rate_limits` per pane (`mcp::rate_limits`); own lock.
    pub rate_limit_usage: Mutex<crate::mcp::rate_limits::RateLimitUsage>,
    /// Mirror of the renderer's per-pane agent display state plus a raw
    /// screen tail (`mcp::peer_state`). Its own lock, never nested with
    /// `terminals` / `war_rooms` / `mcp_clients`: `read_loop` touches it on
    /// every pty chunk and `report_agent_state` on every renderer state
    /// change, so it must never wait behind pty spawn/kill or MCP traffic.
    pub peer_states: Mutex<crate::mcp::peer_state::PeerStates>,
    /// Woken (`notify_waiters`) on every `peer_states` mutation so T3.2's
    /// `war_room.wait_peer` can sleep event-driven instead of polling. A bare
    /// `Notify` carries no payload on purpose: waiters re-read the snapshot
    /// after each wake, which makes a lost intermediate change harmless.
    pub peer_wake: tokio::sync::Notify,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            terminals: Mutex::new(HashMap::new()),
            quitting: AtomicBool::new(false),
            mcp_url: OnceLock::new(),
            war_rooms: Mutex::new(crate::warroom::WarRooms::default()),
            mcp_clients: Mutex::new(crate::mcp::clients::McpClients::default()),
            context_usage: Mutex::new(Default::default()),
            rate_limit_usage: Mutex::new(Default::default()),
            peer_states: Mutex::new(crate::mcp::peer_state::PeerStates::default()),
            peer_wake: tokio::sync::Notify::new(),
        }
    }
}

/// The platform default shell and its launch args.
pub fn default_shell() -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        // -NoLogo drops PowerShell's startup banner so panes open clean.
        ("powershell.exe".to_string(), vec!["-NoLogo".to_string()])
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        let args = login_args(&shell);
        (shell, args)
    }
}

/// Args that make `shell` start as a *login* shell, or empty if we don't
/// recognise it.
///
/// This matters far more than it looks: a non-login zsh reads neither
/// `/etc/zprofile` (where macOS runs `path_helper`, the source of
/// `/usr/local/bin`) nor `~/.zprofile` (where Homebrew's installer writes
/// `brew shellenv`, the source of `/opt/homebrew/bin`). Panes would inherit
/// only the stub PATH the GUI process was launched with, so `brew`, `gh`,
/// `node`, `docker`… all come back "command not found" while Terminal.app on
/// the same machine works. Every mainstream emulator (Terminal.app, iTerm2,
/// Ghostty, WezTerm, Alacritty) starts a login shell for this reason.
///
/// Unknown shells get no args on purpose: an exotic shell that rejects `-l`
/// would exit immediately and leave a dead pane, which is a worse failure than
/// a short PATH.
#[cfg(not(windows))]
pub fn login_args(shell: &str) -> Vec<String> {
    // Compare on the file name only — `$SHELL` is an absolute path, and some
    // installs carry a version suffix (`bash-5.2`).
    let name = std::path::Path::new(shell)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| shell.to_string());
    let stem = name.split('-').next().unwrap_or(&name);
    match stem {
        // `-l` is the login flag for all of these (fish and csh included).
        "sh" | "bash" | "zsh" | "fish" | "ksh" | "mksh" | "dash" | "csh" | "tcsh" => {
            vec!["-l".to_string()]
        }
        _ => vec![],
    }
}

/// The `LANG` value to inject when the parent environment carries no locale at
/// all — the normal state of a GUI app launched from Finder or a desktop shell,
/// which hands us a stub environment with no `LANG`/`LC_*`. Programs in the
/// pane then run under the POSIX "C" locale, and plenty of them degrade to
/// ASCII-only output there (TUIs substitute placeholder glyphs for non-ASCII,
/// `ls` mangles filenames, sort orders change) even though xterm.js decodes
/// UTF-8 unconditionally. Every mainstream emulator (Terminal.app, iTerm2,
/// kitty, WezTerm) papers over this by exporting a UTF-8 locale itself — same
/// class of GUI-launch parity fix as the login-shell PATH story in
/// `login_args`. A user who exports any locale, even a non-UTF-8 one, made a
/// choice; only the "nothing at all" case is filled in. Empty strings count as
/// unset because they select the POSIX locale exactly like absence does.
#[cfg(not(windows))]
pub fn utf8_lang_fallback(
    lang: Option<&str>,
    lc_all: Option<&str>,
    lc_ctype: Option<&str>,
) -> Option<&'static str> {
    let missing = |v: Option<&str>| v.is_none_or(str::is_empty);
    if missing(lang) && missing(lc_all) && missing(lc_ctype) {
        // en_US.UTF-8 ships on every macOS; C.UTF-8 is the one UTF-8 locale
        // modern glibc/musl guarantee without locale generation.
        #[cfg(target_os = "macos")]
        {
            Some("en_US.UTF-8")
        }
        #[cfg(not(target_os = "macos"))]
        {
            Some("C.UTF-8")
        }
    } else {
        None
    }
}

/// Drain the largest valid-UTF-8 prefix from `buf`, leaving any incomplete
/// trailing multibyte sequence behind for the next read. Bytes that cannot begin
/// or continue a valid sequence are genuinely invalid, so they are flushed
/// lossily immediately rather than stalling the stream waiting for a completion
/// that will never come.
pub fn take_valid_utf8(buf: &mut Vec<u8>) -> Option<String> {
    if buf.is_empty() {
        return None;
    }
    let valid_up_to = match std::str::from_utf8(buf) {
        Ok(s) => s.len(),
        Err(e) => e.valid_up_to(),
    };
    if valid_up_to == 0 {
        // Nothing decodes yet. Wait for more bytes only if the leading byte could
        // plausibly start a multibyte sequence and we haven't already buffered a
        // full char's worth (max 4 bytes). Otherwise the bytes are invalid —
        // flush lossily so the stream never stalls.
        // The three ranges are the 2-, 3- and 4-byte UTF-8 lead classes. They
        // happen to be contiguous, but they are kept split so the classes stay
        // legible next to the UTF-8 spec.
        #[allow(clippy::manual_range_patterns)]
        let leads_multibyte = matches!(buf[0], 0xC2..=0xDF | 0xE0..=0xEF | 0xF0..=0xF4);
        if leads_multibyte && buf.len() < 4 {
            return None;
        }
        let s = String::from_utf8_lossy(buf).into_owned();
        buf.clear();
        return Some(s);
    }
    let s = std::str::from_utf8(&buf[..valid_up_to])
        .expect("valid_up_to guarantees valid utf8")
        .to_owned();
    buf.drain(..valid_up_to);
    Some(s)
}

/// Output coalescing (see read_loop): a burst is batched for up to
/// OUTPUT_COALESCE or OUTPUT_BATCH_BYTES; output after OUTPUT_IDLE of silence
/// is sent immediately.
const OUTPUT_COALESCE: std::time::Duration = std::time::Duration::from_millis(4);
const OUTPUT_IDLE: std::time::Duration = std::time::Duration::from_millis(16);
const OUTPUT_BATCH_BYTES: usize = 64 * 1024;
const READ_BUF_BYTES: usize = 64 * 1024;

/// Spawn a pty, register it in state, and start a reader thread that streams
/// decoded output (and finally the exit code) over `on_data`.
pub fn spawn_terminal(
    app: &AppHandle,
    state: &AppState,
    id: String,
    options: CreateTerminalOptions,
    on_data: Channel<PtyOut>,
) -> CreateTerminalResult {
    if state.terminals.lock().unwrap().contains_key(&id) {
        return CreateTerminalResult::err(format!("Terminal \"{id}\" already exists"));
    }

    let account = match options.account_id.as_deref() {
        Some(id) => match crate::accounts::resolve(app, id, options.agent_id.as_deref()) {
            Ok(account) => {
                if let Err(e) =
                    crate::accounts::enroll(&account, state.mcp_url.get().map(|url| url.as_ref()))
                {
                    return CreateTerminalResult::err(e);
                }
                Some(account)
            }
            Err(e) => return CreateTerminalResult::err(e),
        },
        None => None,
    };
    let resolved = options
        .shell_id
        .as_deref()
        .and_then(crate::shell::resolve_shell);
    let (shell, args) = resolved.clone().unwrap_or_else(default_shell);

    let pty_system = native_pty_system();
    let pair = match pty_system.openpty(PtySize {
        rows: options.rows,
        cols: options.cols,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(p) => p,
        Err(e) => return CreateTerminalResult::err(e.to_string()),
    };

    let mut cmd = CommandBuilder::new(&shell);
    for a in &args {
        cmd.arg(a);
    }
    // Inherit the parent environment, then advertise truecolor so CLIs emit
    // 24-bit color sequences that ConPTY forwards and xterm renders verbatim.
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    if let Some(account) = &account {
        crate::accounts::apply_environment(&mut cmd, account);
    }
    let claude_config_dir = account
        .as_ref()
        .filter(|a| a.agent_id == "claude-code")
        .map(|a| std::path::PathBuf::from(&a.config_dir));
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM", "xterm-256color");
    // GUI launches arrive with no locale vars; fill in a UTF-8 LANG so CLIs
    // don't degrade to ASCII-only output (see utf8_lang_fallback for the why).
    #[cfg(not(windows))]
    if let Some(lang) = utf8_lang_fallback(
        std::env::var("LANG").ok().as_deref(),
        std::env::var("LC_ALL").ok().as_deref(),
        std::env::var("LC_CTYPE").ok().as_deref(),
    ) {
        cmd.env("LANG", lang);
    }
    // Ask the shell to report its working directory on every prompt (OSC 7), so
    // relative path links stay resolvable after a `cd`. bash is the only shell we
    // have to arrange this for via the environment: macOS zsh already emits OSC 7
    // from /etc/zshrc and fish does it natively. PowerShell has no environment
    // hook — it falls back to the spawn cwd, so relative links there stop
    // resolving once the user cds away. Prepend rather than replace so a
    // user-configured PROMPT_COMMAND still runs.
    if shell.to_lowercase().contains("bash") {
        let osc7 = r#"printf '\033]7;file://%s%s\033\\' "${HOSTNAME:-}" "$PWD""#;
        let existing = std::env::var("PROMPT_COMMAND").unwrap_or_default();
        let combined = if existing.is_empty() {
            osc7.to_string()
        } else {
            format!("{osc7}; {existing}")
        };
        cmd.env("PROMPT_COMMAND", combined);
    }
    // Identify this session to in-terminal processes so an in-terminal agent
    // can call Swarmterm's MCP server. `id` is the terminalId — a random UUID
    // that only this shell's env sees — and doubles as the unguessable bearer
    // token authorising the MCP call. `SWARMTERM_MCP_URL` points at the
    // Streamable-HTTP endpoint bound at app boot; if the server failed to
    // bind, we skip the URL var (agents just won't have the swarmterm server
    // available) but still set the session so future subsystems can use it.
    cmd.env("SWARMTERM_SESSION", &id);
    let spawn_id = uuid::Uuid::new_v4().to_string();
    cmd.env("SWARMTERM_PTY_GENERATION", &spawn_id);
    if let Some(url) = state.mcp_url.get() {
        cmd.env("SWARMTERM_MCP_URL", url.as_ref());
        // OpenCode gets the server per process via OPENCODE_CONFIG_CONTENT
        // (merged over its own config files), so the user's opencode.json is
        // never written. A value the user already exported wins.
        if options.agent_id.as_deref() == Some("opencode")
            && crate::mcp::toggle::is_enabled("opencode", None)
            && std::env::var_os("OPENCODE_CONFIG_CONTENT").is_none()
        {
            cmd.env(
                "OPENCODE_CONFIG_CONTENT",
                crate::mcp::config::opencode_config_content(url.as_ref(), &id),
            );
        }
    }
    let cwd = options.cwd.clone().unwrap_or_else(|| {
        app.path()
            .home_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| ".".to_string())
    });
    cmd.cwd(&cwd);

    // Clone worktree options to locals so they're available at the insert point.
    let worktree_mode = options.worktree_mode.unwrap_or(false);
    let repo_root = options.repo_root.clone();

    let child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => return CreateTerminalResult::err(e.to_string()),
    };
    let pid = child.process_id();
    let killer = child.clone_killer();

    let writer = match pair.master.take_writer() {
        Ok(w) => w,
        Err(e) => {
            // The child already spawned; don't leave it orphaned.
            let _ = child.clone_killer().kill();
            return CreateTerminalResult::err(e.to_string());
        }
    };
    let reader = match pair.master.try_clone_reader() {
        Ok(r) => r,
        Err(e) => {
            let _ = child.clone_killer().kill();
            return CreateTerminalResult::err(e.to_string());
        }
    };

    // Capture the shell in a job BEFORE running any command, so every process the
    // command tree spawns is born inside the job and dies with it.
    #[cfg(windows)]
    let job = pid.and_then(job::JobHandle::capturing);

    // Run the template's first command (clearing the screen first for the
    // platform default shell so the prompt/echo don't linger above the program).
    let initial_line = options.initial_command.as_ref().map(|ic| {
        let ic = crate::hook::codex::isolated_command(
            ic,
            options.agent_id.as_deref(),
            options.agent_id.as_deref() == Some("codex") && crate::hook::codex::supported(),
        );
        // A switched-off profile gets no per-process pin either.
        let mcp_on = options.agent_id.as_deref().is_none_or(|agent| {
            crate::mcp::toggle::is_enabled(agent, options.account_id.as_deref())
        });
        let ic = crate::hook::codex::with_mcp_url(
            &ic,
            options.agent_id.as_deref(),
            state
                .mcp_url
                .get()
                .map(|url| url.as_ref())
                .filter(|_| mcp_on),
        );
        let line = if resolved.is_some() {
            format!("{ic}\r")
        } else {
            let clear = if cfg!(windows) { "Clear-Host" } else { "clear" };
            format!("{clear}; {ic}\r")
        };
        line
    });

    let waiter_spawn_id = spawn_id.clone();
    let reader_spawn_id = spawn_id.clone();
    state.terminals.lock().unwrap().insert(
        id.clone(),
        ManagedTerminal {
            spawn_id,
            pid,
            agent_id: options.agent_id,
            input: PtyInput::spawn(writer),
            master: pair.master,
            killer,
            #[cfg(windows)]
            job,
            worktree_mode,
            repo_root,
            cwd: std::path::PathBuf::from(cwd),
            claude_config_dir,
        },
    );

    // Publish the live generation before starting the agent: SessionStart may
    // arrive immediately and must never race the terminal registration.
    if let Some(line) = initial_line {
        if let Some(terminal) = state.terminals.lock().unwrap().get_mut(&id) {
            if let Err(e) = terminal.input.send(line.as_bytes()) {
                eprintln!("[pty] initial command for {id} dropped: {e}");
            }
        }
    }

    // A shell that exits on its own (typed `exit`, crash) never closes the
    // ConPTY output pipe while the master lives, so the reader alone would
    // park on read() forever and the pane would never report Exit. The waiter
    // owns the child: once it dies, it drops THIS generation's map entry
    // (spawn_id guards a same-id respawn — though that waits for our Exit
    // anyway) to force the reader's EOF, then hands read_loop the exit code.
    // On the kill_terminal path the entry is already gone and this is a no-op.
    let (exit_tx, exit_rx) = std::sync::mpsc::channel::<i32>();
    let waiter_app = app.clone();
    let waiter_id = id.clone();
    std::thread::spawn(move || {
        let mut child = child;
        let exit_code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(-1);
        if let Some(state) = waiter_app.try_state::<AppState>() {
            // Bound before the drop so the master is released outside the lock.
            let removed = {
                let mut map = state.terminals.lock().unwrap();
                if map
                    .get(&waiter_id)
                    .is_some_and(|t| t.spawn_id == waiter_spawn_id)
                {
                    map.remove(&waiter_id)
                } else {
                    None
                }
            };
            drop(removed);
        }
        let _ = exit_tx.send(exit_code);
    });

    let app = app.clone();
    std::thread::spawn(move || {
        read_loop(app, id, reader_spawn_id, reader, exit_rx, on_data);
    });

    CreateTerminalResult {
        ok: true,
        pid,
        shell: Some(shell),
        error: None,
    }
}

/// Join `first` with whatever follows it on `rx`: only what is already queued
/// after a quiet spell (`idle`), else up to OUTPUT_COALESCE / OUTPUT_BATCH_BYTES.
/// Order is preserved; a closed channel just ends the batch.
fn next_batch(rx: &std::sync::mpsc::Receiver<String>, mut text: String, idle: bool) -> String {
    let deadline = std::time::Instant::now()
        + if idle {
            std::time::Duration::ZERO
        } else {
            OUTPUT_COALESCE
        };
    while text.len() < OUTPUT_BATCH_BYTES {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        match rx.recv_timeout(left) {
            Ok(more) => text.push_str(&more),
            Err(_) => break,
        }
    }
    text
}

/// Remove `id` only if it still belongs to this generation. Returns the removed
/// entry and whether a different generation now holds the id (superseded).
fn remove_generation<T>(
    map: &mut HashMap<String, T>,
    id: &str,
    is_own: impl Fn(&T) -> bool,
) -> (Option<T>, bool) {
    match map.get(id) {
        Some(t) if is_own(t) => (map.remove(id), false),
        Some(_) => (None, true),
        None => (None, false),
    }
}

/// Blocking read loop: stream decoded output, then wait for exit and clean up.
fn read_loop(
    app: AppHandle,
    id: String,
    spawn_id: String,
    mut reader: Box<dyn Read + Send>,
    exit_rx: std::sync::mpsc::Receiver<i32>,
    on_data: Channel<PtyOut>,
) {
    // Reader → flusher split. ConPTY reads block, so coalescing needs its own
    // thread: the reader decodes (UTF-8 boundary handling stays HERE, so the
    // flusher only ever joins whole strings) and the flusher below batches a
    // TUI redraw's many small reads into one tail push, one waiter wake and
    // one IPC message. The first chunk after a quiet spell is sent at once
    // (keystroke echo latency unchanged); only bursts wait up to
    // OUTPUT_COALESCE. The channel closing means EOF with every byte —
    // including the lossy trailing flush — already queued, so `Exit` below
    // can never overtake output.
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut pending: Vec<u8> = Vec::new();
        let mut chunk = vec![0u8; READ_BUF_BYTES];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&chunk[..n]);
                    if let Some(text) = take_valid_utf8(&mut pending) {
                        if tx.send(text).is_err() {
                            return;
                        }
                    }
                }
            }
        }
        // Flush any trailing bytes (lossily) so nothing is lost.
        if !pending.is_empty() {
            let _ = tx.send(String::from_utf8_lossy(&pending).into_owned());
        }
    });

    // Resolved once: `try_state` walks Tauri's type map, and this loop runs
    // per flush. `None` only during teardown, when there is nobody left to
    // read the tail anyway.
    let peer_state = app.try_state::<AppState>();
    let mut last_flush = std::time::Instant::now() - OUTPUT_IDLE;
    while let Ok(first) = rx.recv() {
        let text = next_batch(&rx, first, last_flush.elapsed() >= OUTPUT_IDLE);
        // Tee into the Rust-side screen tail BEFORE the renderer sees it, so a
        // `read_peer` racing this batch never reads less than xterm shows.
        // Lock scope is the one statement — never held across the send.
        if let Some(state) = &peer_state {
            state
                .peer_states
                .lock()
                .unwrap()
                .push_output(&id, &text, crate::warroom::now_ms());
            state.peer_wake.notify_waiters();
        }
        let _ = on_data.send(PtyOut::Data(text));
        last_flush = std::time::Instant::now();
    }
    // The waiter thread owns the child; EOF means it is dead or about to be
    // (kill_terminal dropped the master after killing it).
    let exit_code = exit_rx.recv().unwrap_or(-1);

    // Remove from the registry BEFORE notifying the renderer: a retry triggered by
    // the exit event must find the id free, since create rejects a duplicate live id.
    // A same-id respawn that did not wait for our Exit owns the slot now: leave
    // its entry and its per-id state alone (mirrors the waiter's spawn_id check).
    let superseded = app.try_state::<AppState>().is_some_and(|state| {
        let mut map = state.terminals.lock().unwrap();
        let (removed, superseded) = remove_generation(&mut map, &id, |t| t.spawn_id == spawn_id);
        drop(map);
        drop(removed);
        superseded
    });
    if let Some(state) = app.try_state::<AppState>().filter(|_| !superseded) {
        state.mcp_clients.lock().unwrap().forget(&id);
        // Same-id respawn must start from "no data", not its predecessor's %.
        state.context_usage.lock().unwrap().forget(&id);
        state.rate_limit_usage.lock().unwrap().forget(&id);
        // Drop the state mirror + screen tail and wake any `wait_peer` sleeper
        // so it can report "peer left" instead of sitting out its timeout.
        state.peer_states.lock().unwrap().forget(&id);
        state.peer_wake.notify_waiters();
        let left = state
            .war_rooms
            .lock()
            .unwrap()
            .leave_everywhere(&id, crate::warroom::now_ms());
        if let Some((room_id, event)) = left {
            use tauri::Emitter;
            let _ = app.emit("warroom:event", &crate::warroom::scoped(&room_id, event));
        }
        crate::voice::drop_terminal(&app, &id);
        // Same preview cleanup as kill_terminal: read_loop is the path a shell
        // takes when it exits on its own (typed `exit`, crashed), where no one
        // called kill_terminal. preview:closed tells the renderer too — the
        // store's visibility effects assume webview lifetime is bounded by
        // their own setup/cleanup, and a Rust-side close they never observe
        // would leave a stale preview + a permanently hidden webview on the
        // next preview_open.
        if let Some(webview) = app.get_webview(&crate::preview::preview_label(&id)) {
            let _ = webview.close();
            use tauri::Emitter;
            let _ = app.emit(
                "preview:closed",
                &crate::preview::PreviewClosedEvent {
                    terminal_id: id.clone(),
                },
            );
        }
    }
    let _ = on_data.send(PtyOut::Exit { exit_code });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remove_generation_spares_a_respawned_entry() {
        let mut map = HashMap::from([("t".to_string(), "new".to_string())]);
        // Old generation's reader finishing after a same-id respawn.
        let (removed, superseded) = remove_generation(&mut map, "t", |g| g == "old");
        assert!(removed.is_none() && superseded);
        assert!(map.contains_key("t"));
        let (removed, superseded) = remove_generation(&mut map, "t", |g| g == "new");
        assert_eq!(removed.as_deref(), Some("new"));
        assert!(!superseded && map.is_empty());
        assert_eq!(remove_generation(&mut map, "t", |_| true), (None, false));
    }

    #[test]
    fn next_batch_joins_queued_chunks_in_order() {
        let (tx, rx) = std::sync::mpsc::channel();
        tx.send("b".to_string()).unwrap();
        tx.send("c".to_string()).unwrap();
        assert_eq!(next_batch(&rx, "a".into(), false), "abc");
    }

    #[test]
    fn next_batch_idle_takes_only_what_is_queued() {
        let (tx, rx) = std::sync::mpsc::channel();
        tx.send("b".to_string()).unwrap();
        let start = std::time::Instant::now();
        assert_eq!(next_batch(&rx, "a".into(), true), "ab");
        assert!(start.elapsed() < OUTPUT_COALESCE * 10);
        drop(tx);
    }

    #[test]
    fn next_batch_stops_at_the_byte_cap() {
        let (tx, rx) = std::sync::mpsc::channel();
        tx.send("y".to_string()).unwrap();
        let big = "x".repeat(OUTPUT_BATCH_BYTES);
        assert_eq!(next_batch(&rx, big.clone(), false), big);
        assert_eq!(rx.try_recv().unwrap(), "y");
    }

    #[test]
    fn next_batch_ends_on_closed_channel() {
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        drop(tx);
        assert_eq!(next_batch(&rx, "a".into(), false), "a");
    }

    struct SharedSink(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
    impl Write for SharedSink {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    struct BrokenSink;
    impl Write for BrokenSink {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::ErrorKind::BrokenPipe.into())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn pty_input_writes_in_enqueue_order() {
        let buf = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let input = PtyInput::spawn(Box::new(SharedSink(buf.clone())));
        for s in ["a", "b", "c", "d"] {
            input.send(s.as_bytes()).unwrap();
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while buf.lock().unwrap().len() < 4 && std::time::Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert_eq!(&*buf.lock().unwrap(), b"abcd");
    }

    /// Blocks every write until the test releases it: a pty that stopped reading.
    struct StuckSink(std::sync::mpsc::Receiver<()>);
    impl Write for StuckSink {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            let _ = self.0.recv();
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn pty_input_rejects_input_past_the_queue_cap() {
        let (release, gate) = std::sync::mpsc::channel();
        let input = PtyInput::with_cap(Box::new(StuckSink(gate)), 4);
        assert_eq!(input.send(b"abcd"), Ok(()));
        assert_eq!(input.send(b"e"), Err("input-queue-full".to_string()));
        drop(release); // writer drains, budget is freed
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let mut res = Err(String::new());
        while std::time::Instant::now() < deadline {
            res = input.send(b"e");
            if res.is_ok() {
                break;
            }
            std::thread::yield_now();
        }
        assert_eq!(res, Ok(()));
    }

    #[test]
    fn pty_input_accepts_one_oversized_write_on_an_idle_queue() {
        let buf = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let input = PtyInput::with_cap(Box::new(SharedSink(buf.clone())), 4);
        let big = vec![b'x'; WRITE_CHUNK * 3 + 7];
        assert_eq!(input.send(&big), Ok(()));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while buf.lock().unwrap().len() < big.len() && std::time::Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert_eq!(buf.lock().unwrap().len(), big.len());
    }

    #[test]
    fn pty_input_oversized_write_still_blocks_followups_while_stuck() {
        let (_release, gate) = std::sync::mpsc::channel::<()>();
        let input = PtyInput::with_cap(Box::new(StuckSink(gate)), 4);
        assert_eq!(input.send(b"0123456789"), Ok(()));
        assert_eq!(input.send(b"e"), Err("input-queue-full".to_string()));
    }

    #[test]
    fn pty_input_reports_target_gone_after_writer_dies() {
        let input = PtyInput::spawn(Box::new(BrokenSink));
        let _ = input.send(b"x");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let mut res = Ok(());
        while std::time::Instant::now() < deadline {
            res = input.send(b"y");
            if res.is_err() {
                break;
            }
            std::thread::yield_now();
        }
        assert_eq!(res, Err("target-gone".to_string()));
    }

    #[test]
    fn default_shell_is_nonempty() {
        let (cmd, _args) = default_shell();
        assert!(!cmd.is_empty());
    }

    #[cfg(not(windows))]
    #[test]
    fn default_shell_is_a_login_shell() {
        let (_cmd, args) = default_shell();
        assert!(
            args.iter().any(|a| a == "-l"),
            "unix panes must spawn a login shell, got args {args:?}"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn login_args_cover_the_common_posix_shells() {
        for shell in [
            "/bin/zsh",
            "/bin/bash",
            "/bin/sh",
            "/opt/homebrew/bin/fish",
            "/bin/ksh",
        ] {
            assert_eq!(login_args(shell), vec!["-l".to_string()], "{shell}");
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn login_args_are_empty_for_unknown_shells() {
        // An unrecognised shell may reject `-l` and leave the pane dead on
        // arrival; no args is the safe fallback.
        assert!(login_args("/usr/local/bin/nu").is_empty());
        assert!(login_args("/usr/bin/xonsh").is_empty());
    }

    #[cfg(not(windows))]
    #[test]
    fn login_args_ignore_the_directory_and_version_suffix() {
        assert_eq!(login_args("zsh"), vec!["-l".to_string()]);
        assert_eq!(
            login_args("/usr/local/bin/bash-5.2"),
            vec!["-l".to_string()]
        );
    }

    #[test]
    fn take_valid_utf8_returns_complete_prefix_and_holds_partial_tail() {
        // "é" is 0xC3 0xA9; feed only the first byte after an ascii char.
        let mut buf = vec![b'h', b'i', 0xC3];
        let out = take_valid_utf8(&mut buf).unwrap();
        assert_eq!(out, "hi");
        assert_eq!(buf, vec![0xC3]); // incomplete tail retained
    }

    #[test]
    fn take_valid_utf8_completes_across_chunks() {
        let mut buf = vec![0xC3, 0xA9]; // full "é"
        let out = take_valid_utf8(&mut buf).unwrap();
        assert_eq!(out, "é");
        assert!(buf.is_empty());
    }

    #[test]
    fn take_valid_utf8_flushes_long_invalid_runs() {
        let mut buf = vec![0xFF, 0xFE, 0xFD, 0xFC, 0xFB];
        let out = take_valid_utf8(&mut buf).unwrap();
        assert!(!out.is_empty()); // lossy, but does not stall
        assert!(buf.is_empty());
    }

    #[test]
    fn take_valid_utf8_flushes_short_invalid_runs() {
        let mut buf = vec![0xFF, 0xFE, 0xFD]; // 3 invalid bytes, not a multibyte lead
        let out = take_valid_utf8(&mut buf).unwrap();
        assert!(!out.is_empty());
        assert!(buf.is_empty()); // flushed immediately, not stalled
    }

    #[cfg(not(windows))]
    #[test]
    fn utf8_lang_fallback_fills_a_bare_gui_environment() {
        // Finder/desktop launch: no locale vars at all → inject a UTF-8 LANG.
        let lang = utf8_lang_fallback(None, None, None).unwrap();
        assert!(lang.contains("UTF-8"));
    }

    #[cfg(not(windows))]
    #[test]
    fn utf8_lang_fallback_treats_empty_values_as_unset() {
        // An empty LANG selects the POSIX locale exactly like an absent one.
        assert!(utf8_lang_fallback(Some(""), Some(""), None).is_some());
    }

    #[cfg(not(windows))]
    #[test]
    fn utf8_lang_fallback_respects_any_explicit_locale() {
        // A user who exports a locale — even a non-UTF-8 one — keeps it.
        assert!(utf8_lang_fallback(Some("en_US.UTF-8"), None, None).is_none());
        assert!(utf8_lang_fallback(Some("C"), None, None).is_none());
        assert!(utf8_lang_fallback(None, Some("C"), None).is_none());
        assert!(utf8_lang_fallback(None, None, Some("vi_VN.UTF-8")).is_none());
    }
}
