//! buzzkey adapter: a Windows named pipe plus a discovery file.
//!
//! Why a pipe and not a route on the MCP server: a loopback HTTP port is
//! reachable from any browser tab (CSRF, DNS rebinding) and the MCP server
//! already has its own bearer model. A pipe is unreachable from the web, and
//! its DACL admits only the current user. `first_pipe_instance` makes
//! creation fail if another process already squats the name.
//!
//! Discovery: `%LOCALAPPDATA%\<app-id>\voice-endpoint.json` holds the pipe
//! name, a fresh 256-bit token and our pid (buzzkey matches it against the
//! foreground window, so dev and installed app never cross). Written
//! atomically, removed when the endpoint stops.
//!
//! Each connection has a reader (this task, one request at a time) and a
//! writer task fed by a channel. Answers and server pushes (SWA-40) both go
//! through that channel, so a push during an 8-second `insert` is neither
//! blocked nor interleaved mid-line.

use std::ffi::c_void;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt, ReadHalf, WriteHalf};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use tokio::sync::{mpsc, watch};

use super::pins::PIN_TTL;
use super::protocol::{self, Response, MAX_LINE_BYTES};
use super::{Conn, Outgoing, VoiceHub};

/// A connection that sends nothing for this long is closed.
const IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
/// While a connection holds a dictation it may stay silent for the whole
/// recording; the pin's own expiry (pushed as `expired`) ends it first.
const HOLD_TIMEOUT: std::time::Duration = PIN_TTL.saturating_add(std::time::Duration::from_secs(5));

pub struct Running {
    stop: watch::Sender<bool>,
    discovery: PathBuf,
}

impl Running {
    pub fn stop(self) {
        let _ = self.stop.send(true);
        let _ = std::fs::remove_file(&self.discovery);
    }
}

fn random_token() -> String {
    // Two v4 UUIDs = 244 random bits from the OS RNG, hex without dashes.
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

pub fn start(app: AppHandle) -> Result<Running, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    let name = format!(
        r"\\.\pipe\swarmterm-voice-{}",
        uuid::Uuid::new_v4().simple()
    );
    let token = random_token();
    let sd = security::CurrentUserOnly::new()?;
    // `start` also runs from `setup` and from a sync Tauri command, outside
    // any runtime context; tokio pipes register with the reactor on creation.
    let rt = tauri::async_runtime::handle();
    let _enter = rt.inner().enter();
    let first = create(&name, true, &sd)?;

    let discovery = dir.join("voice-endpoint.json");
    let body = serde_json::json!({
        "version": protocol::VERSION,
        "pipe": name,
        "token": token,
        "pid": std::process::id(),
    });
    let tmp = discovery.with_extension("json.tmp");
    std::fs::write(&tmp, body.to_string()).map_err(|e| format!("write discovery: {e}"))?;
    std::fs::rename(&tmp, &discovery).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename discovery: {e}")
    })?;

    let (stop_tx, stop_rx) = watch::channel(false);
    tauri::async_runtime::spawn(accept_loop(app, name, token, first, sd, stop_rx));
    Ok(Running {
        stop: stop_tx,
        discovery,
    })
}

fn create(
    name: &str,
    first: bool,
    sd: &security::CurrentUserOnly,
) -> Result<NamedPipeServer, String> {
    let mut opts = ServerOptions::new();
    opts.first_pipe_instance(first).reject_remote_clients(true);
    // SAFETY: `sd` owns a valid SECURITY_ATTRIBUTES for the whole call.
    unsafe { opts.create_with_security_attributes_raw(name, sd.attributes()) }
        .map_err(|e| format!("create pipe: {e}"))
}

async fn accept_loop(
    app: AppHandle,
    name: String,
    token: String,
    mut server: NamedPipeServer,
    sd: security::CurrentUserOnly,
    mut stop: watch::Receiver<bool>,
) {
    // Per-connection errors (a client that connects and drops at once, a
    // transient create failure) must not end dictation for the whole session:
    // log, back off, rebuild the instance and keep accepting until `stop`.
    let mut backoff = BACKOFF_MIN;
    loop {
        let connected = tokio::select! {
            _ = stop.changed() => return,
            res = server.connect() => res.map_err(|e| format!("connect: {e}")),
        };
        // Open the next instance before serving this one, so a client never
        // finds the name missing between connections.
        let next = create(&name, false, &sd);
        match (connected, next) {
            (Ok(()), Ok(next)) => {
                backoff = BACKOFF_MIN;
                let conn = std::mem::replace(&mut server, next);
                tauri::async_runtime::spawn(serve(app.clone(), token.clone(), conn, stop.clone()));
                continue;
            }
            // The failed instance is discarded; the fresh one takes over.
            (Err(e), Ok(next)) => {
                eprintln!("voice: {e}");
                server = next;
            }
            // No replacement: keep the current instance and retry later.
            (_, Err(e)) => eprintln!("voice: {e}"),
        }
        tokio::select! {
            _ = stop.changed() => return,
            _ = tokio::time::sleep(backoff) => {}
        }
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}

const BACKOFF_MIN: std::time::Duration = std::time::Duration::from_millis(100);
const BACKOFF_MAX: std::time::Duration = std::time::Duration::from_secs(5);

async fn serve(
    app: AppHandle,
    token: String,
    conn: NamedPipeServer,
    mut stop: watch::Receiver<bool>,
) {
    let (mut rd, wr) = tokio::io::split(conn);
    let (tx, rx) = mpsc::unbounded_channel();
    let (closed_tx, mut closed) = watch::channel(false);
    let id = app.state::<VoiceHub>().register_conn(tx.clone());
    tauri::async_runtime::spawn(write_loop(wr, rx, closed_tx));
    let mut state = Conn {
        id,
        ..Default::default()
    };
    read_loop(
        &app,
        &token,
        &mut rd,
        &tx,
        &mut state,
        &mut stop,
        &mut closed,
    )
    .await;
    // Unregister before the pins go, so nothing is pushed into a dead pipe.
    // Dropping `tx` afterwards lets the writer drain what is queued and end.
    super::close_conn(&app, id);
}

async fn read_loop(
    app: &AppHandle,
    token: &str,
    rd: &mut ReadHalf<NamedPipeServer>,
    tx: &mpsc::UnboundedSender<Outgoing>,
    state: &mut Conn,
    stop: &mut watch::Receiver<bool>,
    closed: &mut watch::Receiver<bool>,
) {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        // Serve every complete line already buffered.
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let text = String::from_utf8_lossy(&line[..line.len() - 1]);
            let text = text.trim_end_matches('\r');
            let resp = match protocol::parse(text, token) {
                Ok(req) => super::handle(app, req, state).await,
                Err(reason) => Response::err(None, reason),
            };
            let unauthorized = resp.reason.as_deref() == Some("unauthorized");
            if tx.send(Outgoing::Line(resp.to_line())).is_err() || unauthorized {
                return;
            }
        }
        // The limit is enforced while reading: an endless line never grows
        // the buffer past MAX_LINE_BYTES.
        if buf.len() > MAX_LINE_BYTES {
            let _ = tx.send(Outgoing::Line(Response::err(None, "too-large").to_line()));
            return;
        }
        let idle = if app.state::<VoiceHub>().conn_has_pin(state.id) {
            HOLD_TIMEOUT
        } else {
            IDLE_TIMEOUT
        };
        let n = tokio::select! {
            _ = stop.changed() => return,
            _ = closed.changed() => return,
            r = tokio::time::timeout(idle, rd.read(&mut chunk)) => match r {
                Ok(Ok(n)) if n > 0 => n,
                _ => return,
            },
        };
        buf.extend_from_slice(&chunk[..n]);
    }
}

/// Writes whole lines in queue order. Ends on `Close`, on a write error, or
/// once every sender is gone and the queue is drained; `closed` then tells
/// the reader.
async fn write_loop(
    mut wr: WriteHalf<NamedPipeServer>,
    mut rx: mpsc::UnboundedReceiver<Outgoing>,
    closed: watch::Sender<bool>,
) {
    while let Some(out) = rx.recv().await {
        match out {
            Outgoing::Line(line) => {
                if wr.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
            }
            Outgoing::Close => break,
        }
    }
    let _ = closed.send(true);
}

mod security {
    use super::c_void;
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE};
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenUser, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    /// SECURITY_ATTRIBUTES whose DACL grants the current user, and only the
    /// current user, access (`D:P(A;;GA;;;<user SID>)`, protected from
    /// inheritance). Owns the LocalAlloc'd descriptor.
    pub struct CurrentUserOnly {
        sa: Box<SECURITY_ATTRIBUTES>,
        sd: *mut c_void,
    }

    // The descriptor is immutable after construction and only read by
    // CreateNamedPipeW; moving it to the accept task is sound.
    unsafe impl Send for CurrentUserOnly {}
    unsafe impl Sync for CurrentUserOnly {}

    impl CurrentUserOnly {
        pub fn new() -> Result<Self, String> {
            let sid = current_user_sid()?;
            let sddl: Vec<u16> = format!("D:P(A;;GA;;;{sid})")
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let mut sd: *mut c_void = std::ptr::null_mut();
            // SAFETY: valid NUL-terminated SDDL; on success `sd` is LocalAlloc'd.
            let ok = unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    SDDL_REVISION_1,
                    &mut sd,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                return Err(format!(
                    "security descriptor: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let sa = Box::new(SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: sd,
                bInheritHandle: 0,
            });
            Ok(Self { sa, sd })
        }

        pub fn attributes(&self) -> *mut c_void {
            &*self.sa as *const SECURITY_ATTRIBUTES as *mut c_void
        }
    }

    impl Drop for CurrentUserOnly {
        fn drop(&mut self) {
            // SAFETY: allocated by ConvertStringSecurityDescriptor…W.
            unsafe { LocalFree(self.sd) };
        }
    }

    fn current_user_sid() -> Result<String, String> {
        let err = |what: &str| format!("{what}: {}", std::io::Error::last_os_error());
        let mut token: HANDLE = std::ptr::null_mut();
        // SAFETY: plain Win32 calls with owned out-buffers; handles closed below.
        unsafe {
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return Err(err("OpenProcessToken"));
            }
            let mut len = 0u32;
            GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut len);
            let mut buf = vec![0u8; len as usize];
            let ok = GetTokenInformation(token, TokenUser, buf.as_mut_ptr().cast(), len, &mut len);
            CloseHandle(token);
            if ok == 0 {
                return Err(err("GetTokenInformation"));
            }
            let user = &*(buf.as_ptr() as *const TOKEN_USER);
            let mut wide: *mut u16 = std::ptr::null_mut();
            if ConvertSidToStringSidW(user.User.Sid, &mut wide) == 0 {
                return Err(err("ConvertSidToStringSid"));
            }
            let mut n = 0;
            while *wide.add(n) != 0 {
                n += 1;
            }
            let sid = String::from_utf16_lossy(std::slice::from_raw_parts(wide, n));
            LocalFree(wide.cast());
            Ok(sid)
        }
    }
}
