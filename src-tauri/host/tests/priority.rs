//! Job Object priority enforcement with real, synthetic processes (ADR 0005).
//! Only `cmd`, `ping`, `powershell`, a copy of `cmd.exe` named `claude.exe`
//! and `node` running a tiny script that only spawns `cmd`/`ping` (from a
//! path that looks like an npm agent package): nothing here generates CPU
//! load or starts a real agent.
//! Every tree lives in a kill-on-close job, so dropping the handle cleans up.
#![cfg(windows)]

use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use swarmterm_host::job::{Assign, JobHandle};
use swarmterm_host::priority::{Level, Limits, Memo, Mode, Registry, Settings};
use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::System::Threading::{
    GetPriorityClass, OpenProcess, SetPriorityClass, TerminateProcess, BELOW_NORMAL_PRIORITY_CLASS,
    IDLE_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SET_INFORMATION, PROCESS_TERMINATE,
};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const WAIT: Duration = Duration::from_secs(30);

fn sys32(exe: &str) -> String {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    format!(r"{root}\System32\{exe}")
}

fn class(pid: u32) -> u32 {
    // SAFETY: handle opened and closed here.
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        assert!(!h.is_null(), "pid {pid} gone");
        let c = GetPriorityClass(h);
        CloseHandle(h);
        c
    }
}

/// `cmd /d /s /c "<line>"` hidden, with stdout discarded. Every command in a
/// line is an absolute path (`ping()`, `node_exe()`): the GitHub windows
/// runner's cmd failed to resolve a bare `ping` even with System32 first on
/// PATH, so the tests no longer depend on PATH lookup at all. `/s` plus the
/// outer quotes keep cmd's quote stripping from breaking quoted paths.
fn cmd(line: &str) -> std::process::Child {
    report_cmd_env_once();
    Command::new(sys32("cmd.exe"))
        .raw_arg(format!("/d /s /c \"{line}\""))
        .stdout(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .unwrap()
}

/// `"<System32>\PING.EXE"`, quoted for a cmd line.
fn ping() -> String {
    format!("\"{}\"", sys32("PING.EXE"))
}

/// Diagnostics for the CI runner (why cmd could not resolve `ping`): the
/// lookup variables as a child cmd sees them, written once straight to the
/// process stderr so libtest's capture does not hide them on a pass.
fn report_cmd_env_once() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        use std::io::Write;
        let out = Command::new(sys32("cmd.exe"))
            .raw_arg("/d /c set")
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        let mut text = String::from("[priority diag] cmd env:\n");
        match out {
            Ok(o) => {
                for l in String::from_utf8_lossy(&o.stdout).lines() {
                    let key = l.split('=').next().unwrap_or("").to_ascii_uppercase();
                    if ["PATH", "PATHEXT", "SYSTEMROOT", "COMSPEC"].contains(&key.as_str()) {
                        let short: String = l.chars().take(400).collect();
                        text.push_str(&format!("  {short} (len {})\n", l.len()));
                    }
                }
            }
            Err(e) => text.push_str(&format!("  cmd /c set failed: {e}\n")),
        }
        let _ = std::io::stderr().write_all(text.as_bytes());
    });
}

/// Exe names of the job's members (Toolhelp), polled until `pred` holds.
fn wait_members(job: &JobHandle, pred: impl Fn(&[(u32, String)]) -> bool) -> Vec<(u32, String)> {
    let deadline = Instant::now() + WAIT;
    loop {
        let names = names(&job.pids());
        if pred(&names) {
            return names;
        }
        assert!(
            Instant::now() < deadline,
            "timed out after {WAIT:?}, members {names:?} (raw pids {:?}; empty means the \
             tree exited, e.g. a command it runs was not found)",
            job.pids()
        );
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn names(pids: &[u32]) -> Vec<(u32, String)> {
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    let mut out = Vec::new();
    // SAFETY: plain Toolhelp walk; handle closed once.
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = Process32FirstW(snap, &mut e);
        while ok != 0 {
            if pids.contains(&e.th32ProcessID) {
                let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(0);
                out.push((
                    e.th32ProcessID,
                    String::from_utf16_lossy(&e.szExeFile[..len]).to_ascii_lowercase(),
                ));
            }
            ok = Process32NextW(snap, &mut e);
        }
        CloseHandle(snap);
    }
    out
}

fn pid_of(members: &[(u32, String)], exe: &str) -> u32 {
    members.iter().find(|(_, n)| n == exe).unwrap().0
}

fn strict() -> Limits {
    Limits {
        pane: Some(Level::BelowNormal),
        build: Some(Level::Idle),
        cpu_cap: None,
    }
}

/// The ping that starts after the first one finished, i.e. after capture.
fn late_ping() -> String {
    let p = ping();
    format!("{p} -n 2 127.0.0.1 >nul & {p} -n 60 127.0.0.1")
}

#[test]
fn child_is_born_with_the_job_class_and_cannot_be_raised() {
    let mut shell = cmd(&late_ping());
    let job = JobHandle::capturing_with(shell.id(), &strict()).unwrap();
    // Running members are moved to the class at once, too.
    assert_eq!(class(shell.id()), BELOW_NORMAL_PRIORITY_CLASS);
    let m = wait_members(&job, |m| {
        m.iter().filter(|(_, n)| n == "ping.exe").count() == 1
    });
    let ping = pid_of(&m, "ping.exe");
    assert_eq!(class(ping), BELOW_NORMAL_PRIORITY_CLASS);
    // Raising from outside does not stick either.
    // SAFETY: handle opened and closed here.
    unsafe {
        let h = OpenProcess(
            PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            ping,
        );
        SetPriorityClass(h, NORMAL_PRIORITY_CLASS);
        CloseHandle(h);
    }
    assert_eq!(class(ping), BELOW_NORMAL_PRIORITY_CLASS);
    job.terminate();
    let _ = shell.wait();
}

#[test]
fn process_raising_itself_stays_capped() {
    // PowerShell sleeps (so it is captured first), then asks for Normal on
    // itself and prints the class it really has.
    let script = "Start-Sleep -Milliseconds 1500; $p=[Diagnostics.Process]::GetCurrentProcess(); \
        try { $p.PriorityClass='Normal' } catch { 'refused' }; $p.Refresh(); [string]$p.PriorityClass";
    let child = Command::new(sys32(r"WindowsPowerShell\v1.0\powershell.exe"))
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .stdout(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .unwrap();
    let job = JobHandle::capturing_with(child.id(), &strict()).unwrap();
    let out = child.wait_with_output().unwrap();
    drop(job);
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(
        text.trim_end().ends_with("BelowNormal"),
        "powershell said {text:?}"
    );
}

#[test]
fn orphan_stays_in_the_job_and_capped() {
    // `start /b` launches ping and cmd exits at once: ping's parent is gone.
    // The first ping delays that until after capture.
    let mut shell = cmd(&format!(
        "{p} -n 2 127.0.0.1 >nul & start \"\" /b {p} -n 60 127.0.0.1",
        p = ping()
    ));
    let job = JobHandle::capturing_with(shell.id(), &strict()).unwrap();
    let _ = shell.wait();
    let m = wait_members(&job, |m| m.iter().any(|(_, n)| n == "ping.exe"));
    let ping = pid_of(&m, "ping.exe");
    assert!(
        !m.iter().any(|(p, _)| *p == shell.id()),
        "shell still alive: {m:?}"
    );
    assert_eq!(class(ping), BELOW_NORMAL_PRIORITY_CLASS);
    job.terminate();
}

#[test]
fn live_limit_changes_apply_and_lifting_raises_back() {
    let mut shell = cmd(&late_ping());
    let job = JobHandle::capturing_with(shell.id(), &strict()).unwrap();
    let m = wait_members(&job, |m| m.iter().any(|(_, n)| n == "ping.exe"));
    let ping = pid_of(&m, "ping.exe");
    assert_eq!(class(ping), BELOW_NORMAL_PRIORITY_CLASS);
    job.set_limits(&Limits {
        pane: Some(Level::Idle),
        ..strict()
    });
    assert_eq!(class(ping), IDLE_PRIORITY_CLASS);
    // Relaxing a level (not lifting it) also applies to running members:
    // the limit sets the class, it does not only cap it.
    job.set_limits(&strict());
    assert_eq!(class(ping), BELOW_NORMAL_PRIORITY_CLASS);
    assert_eq!(job.assign_build(ping), Assign::Done);
    assert_eq!(class(ping), IDLE_PRIORITY_CLASS);
    job.set_limits(&Limits {
        pane: None,
        build: Some(Level::BelowNormal),
        cpu_cap: None,
    });
    assert_eq!(class(ping), BELOW_NORMAL_PRIORITY_CLASS);
    // Already inside the build job counts as assigned.
    assert_eq!(job.assign_build(ping), Assign::Done);
    job.set_limits(&Limits::NONE);
    assert_eq!(class(ping), NORMAL_PRIORITY_CLASS);
    // ping is in the build job now: strict gives it the lowest class in the
    // chain, Idle.
    job.set_limits(&strict());
    assert_eq!(class(ping), IDLE_PRIORITY_CLASS);
    job.terminate();
    let _ = shell.wait();
}

#[test]
fn nested_build_job_lowers_further_and_cpu_cap_is_accepted() {
    let mut shell = cmd(&late_ping());
    let limits = Limits {
        cpu_cap: Some(50),
        ..strict()
    };
    let job = JobHandle::capturing_with(shell.id(), &limits).unwrap();
    let m = wait_members(&job, |m| m.iter().any(|(_, n)| n == "ping.exe"));
    let ping = pid_of(&m, "ping.exe");
    // A process already in the pane job moves into the nested job.
    assert_eq!(job.assign_build(ping), Assign::Done);
    assert_eq!(class(ping), IDLE_PRIORITY_CLASS);
    assert_eq!(class(shell.id()), BELOW_NORMAL_PRIORITY_CLASS);
    // The pane job's list includes the nested job's members.
    assert!(job.pids().contains(&ping));
    // A nested build level above the pane level is clamped to the pane's.
    job.set_limits(&Limits {
        pane: Some(Level::Idle),
        build: Some(Level::BelowNormal),
        cpu_cap: None,
    });
    assert_eq!(class(ping), IDLE_PRIORITY_CLASS);
    job.terminate();
    let _ = shell.wait();
}

/// A copy of `cmd.exe` named `claude.exe` (with its `.mui` resources) plays
/// the agent.
fn fake_agent(dir: &std::path::Path) -> std::path::PathBuf {
    let fake = dir.join("claude.exe");
    std::fs::copy(sys32("cmd.exe"), &fake).unwrap();
    let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    if let Ok(entries) = std::fs::read_dir(format!(r"{sysroot}\System32")) {
        for e in entries.flatten() {
            let lang = e.file_name();
            if !lang.to_string_lossy().contains('-') {
                continue;
            }
            let mui = e.path().join("cmd.exe.mui");
            if mui.is_file() && std::fs::create_dir_all(dir.join(&lang)).is_ok() {
                let _ = std::fs::copy(&mui, dir.join(&lang).join("claude.exe.mui"));
            }
        }
    }
    fake
}

#[test]
fn agent_normal_keeps_the_agent_and_idles_its_child() {
    let dir = tempfile::tempdir().unwrap();
    let fake = fake_agent(dir.path());
    let inherited = class(std::process::id());
    let registry = Registry::without_watcher();
    registry.set(Settings {
        mode: Mode::AgentNormal,
        ..Settings::default()
    });
    let mut shell = cmd(&format!(
        "{p} -n 2 127.0.0.1 >nul & \"{}\" /d /s /c \"{p} -n 60 127.0.0.1\"",
        fake.display(),
        p = ping()
    ));
    let job = registry.capture("pane", shell.id()).unwrap();
    let m = wait_members(&job, |m| {
        m.iter().any(|(_, n)| n == "claude.exe")
            && m.iter().filter(|(_, n)| n == "ping.exe").count() == 1
    });
    let (agent, ping) = (pid_of(&m, "claude.exe"), pid_of(&m, "ping.exe"));
    registry.pass(&mut Memo::default());
    assert_eq!(class(agent), inherited);
    assert_eq!(class(ping), IDLE_PRIORITY_CLASS);
    // Exempting the pane lifts the limits live.
    registry.set(Settings {
        mode: Mode::AgentNormal,
        exempt: vec!["pane".into()],
        ..Settings::default()
    });
    assert_eq!(class(ping), NORMAL_PRIORITY_CLASS);
    job.terminate();
    let _ = shell.wait();
}

/// Direct children of `parent` (Toolhelp), with their exe names.
fn children_of(parent: u32) -> Vec<(u32, String)> {
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    let mut out = Vec::new();
    // SAFETY: plain Toolhelp walk; handle closed once.
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = Process32FirstW(snap, &mut e);
        while ok != 0 {
            if e.th32ParentProcessID == parent {
                let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(0);
                out.push((
                    e.th32ProcessID,
                    String::from_utf16_lossy(&e.szExeFile[..len]).to_ascii_lowercase(),
                ));
            }
            ok = Process32NextW(snap, &mut e);
        }
        CloseHandle(snap);
    }
    out
}

#[test]
fn child_started_before_capture_is_swept_into_the_job() {
    // The shell starts ping at once; capture comes only after ping runs,
    // like a profile hook's child in the window between spawn and capture.
    let mut shell = cmd(&format!("{} -n 60 127.0.0.1", ping()));
    let deadline = Instant::now() + WAIT;
    let ping = loop {
        if let Some((p, _)) = children_of(shell.id())
            .into_iter()
            .find(|(_, n)| n == "ping.exe")
        {
            break p;
        }
        assert!(Instant::now() < deadline, "ping never started");
        std::thread::sleep(Duration::from_millis(50));
    };
    let job = JobHandle::capturing_with(shell.id(), &strict()).unwrap();
    assert!(job.pids().contains(&ping), "ping not swept into the job");
    assert_eq!(class(ping), BELOW_NORMAL_PRIORITY_CLASS);
    job.terminate();
    let _ = shell.wait();
}

/// Wait until `parent` has a direct child named `exe`; its pid.
fn wait_child(parent: u32, exe: &str) -> u32 {
    let deadline = Instant::now() + WAIT;
    loop {
        if let Some((p, _)) = children_of(parent).into_iter().find(|(_, n)| n == exe) {
            return p;
        }
        assert!(
            Instant::now() < deadline,
            "{exe} below {parent} never started"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// The tree walk of one sweep round: a grandchild already running at
/// capture is assigned along with its parent.
#[test]
fn grandchild_started_before_capture_is_swept_into_the_job() {
    let mut shell = cmd(&format!(
        "\"{}\" /d /s /c \"{} -n 60 127.0.0.1\"",
        sys32("cmd.exe"),
        ping()
    ));
    let inner = wait_child(shell.id(), "cmd.exe");
    let ping = wait_child(inner, "ping.exe");
    let job = JobHandle::capturing_with(shell.id(), &strict()).unwrap();
    let pids = job.pids();
    assert!(
        pids.contains(&inner) && pids.contains(&ping),
        "members {pids:?}"
    );
    assert_eq!(class(ping), BELOW_NORMAL_PRIORITY_CLASS);
    assert!(job.strays().is_empty());
    job.terminate();
    let _ = shell.wait();
}

/// The second sweep round: a grandchild born after the first round's
/// snapshot but before its parent was assigned sits outside the job; only
/// a repeated round finds it. The hook makes that window deterministic:
/// right after round 0's snapshot it ends the inner cmd's first ping, so
/// cmd starts the second ping before cmd itself is assigned.
#[test]
fn grandchild_started_during_the_first_round_is_swept_by_the_second() {
    // The `&` is inside the inner quotes, so the outer cmd keeps it literal
    // and only the inner cmd (after `/s` strips them) splits on it.
    let mut shell = cmd(&format!(
        "\"{}\" /d /s /c \"{p} -n 60 127.0.0.1 & {p} -n 60 127.0.0.1\"",
        sys32("cmd.exe"),
        p = ping()
    ));
    let inner = wait_child(shell.id(), "cmd.exe");
    let first = wait_child(inner, "ping.exe");
    // PIDs are reused quickly: the second ping may get `first`'s PID, so it
    // is told apart by its creation time.
    let first_born = born(first).expect("first ping gone");
    let mut second = None;
    let mut rounds = Vec::new();
    let job = JobHandle::capturing_with_hook(shell.id(), &strict(), &mut |round| {
        rounds.push(round);
        if round != 0 {
            return;
        }
        kill_pid(first);
        let deadline = Instant::now() + WAIT;
        second = loop {
            if let Some((p, _)) = children_of(inner)
                .into_iter()
                .find(|(p, n)| n == "ping.exe" && born(*p).is_some_and(|b| b != first_born))
            {
                break Some(p);
            }
            assert!(Instant::now() < deadline, "second ping never started");
            std::thread::sleep(Duration::from_millis(20));
        };
    })
    .unwrap();
    let second = second.expect("hook never ran");
    assert!(
        !job.strays().contains(&first),
        "killed first ping counted as a stray"
    );
    assert!(rounds.len() >= 2, "rounds {rounds:?}");
    let pids = job.pids();
    assert!(
        pids.contains(&inner) && pids.contains(&second),
        "members {pids:?}"
    );
    assert_eq!(class(second), BELOW_NORMAL_PRIORITY_CLASS);
    assert!(job.strays().is_empty());
    job.terminate();
    let _ = shell.wait();
}

/// Absolute path of `<name>.exe` on PATH, so the command lines below need
/// no PATH lookup of their own. Only `.exe`: a `node.cmd` shim would never
/// show up as the `node.exe` member the tests wait for.
fn find_on_path(name: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(format!("{name}.exe")))
        .find(|c| c.is_file())
}

/// Node is installed on the development machine; a missing node is a
/// broken test setup, not a pass. PATH first, then the default installer
/// location, so a runner with a broken PATH still finds it.
fn node_exe() -> std::path::PathBuf {
    let default = std::env::var_os("ProgramFiles")
        .map(|d| std::path::Path::new(&d).join(r"nodejs\node.exe"))
        .filter(|p| p.is_file());
    let node = find_on_path("node").or(default).unwrap_or_else(|| {
        panic!(
            r"node.exe not found on PATH or in %ProgramFiles%\nodejs: the libuv job tests need Node.js installed"
        )
    });
    let ok = Command::new(&node)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .is_ok_and(|s| s.success());
    assert!(ok, "{} --version failed", node.display());
    node
}

/// A fake npm agent package whose cli.js only spawns `cmd /c ping`, both
/// by absolute path.
fn node_agent_script(dir: &std::path::Path) -> std::path::PathBuf {
    let pkg = dir.join("@anthropic-ai").join("claude-code");
    std::fs::create_dir_all(&pkg).unwrap();
    let script = pkg.join("cli.js");
    let js = |p: String| p.replace('\\', "\\\\");
    std::fs::write(
        &script,
        format!(
            "require('child_process').spawn('{}', \
             ['/d', '/s', '/c', '{} -n 60 127.0.0.1 >nul'], {{ stdio: 'ignore', windowsHide: true }});\n\
             setInterval(() => {{}}, 1000);\n",
            js(sys32("cmd.exe")),
            js(sys32("PING.EXE"))
        ),
    )
    .unwrap();
    script
}

/// Creation time of a running `pid`.
fn born(pid: u32) -> Option<u64> {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::GetProcessTimes;
    // SAFETY: handle opened and closed here; zeroed out-params.
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return None;
        }
        let mut t: [FILETIME; 4] = std::mem::zeroed();
        let [c, e, k, u] = &mut t;
        let ok = GetProcessTimes(h, c, e, k, u) != 0;
        CloseHandle(h);
        ok.then(|| (u64::from(c.dwHighDateTime) << 32) | u64::from(c.dwLowDateTime))
    }
}

fn kill_pid(pid: u32) {
    // SAFETY: handle opened and closed here.
    unsafe {
        let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !h.is_null() {
            TerminateProcess(h, 1);
            CloseHandle(h);
        }
    }
}

fn set_class(pid: u32, c: u32) {
    // SAFETY: handle opened and closed here.
    unsafe {
        let h = OpenProcess(PROCESS_SET_INFORMATION, 0, pid);
        assert!(!h.is_null());
        SetPriorityClass(h, c);
        CloseHandle(h);
    }
}

/// An early child that already sits in a job of its own (node with its
/// libuv job, started before capture) cannot be assigned: it and its
/// libuv-job child become strays with the pane class forced by hand, every
/// watcher pass; node's grandchild (broken away from libuv) is captured.
#[test]
fn early_child_with_its_own_job_is_forced_to_the_pane_class() {
    let node = node_exe();
    let dir = tempfile::tempdir().unwrap();
    let script = node_agent_script(dir.path());
    let mut shell = cmd(&format!("\"{}\" \"{}\"", node.display(), script.display()));
    let node = wait_child(shell.id(), "node.exe");
    let inner = wait_child(node, "cmd.exe");
    let ping = wait_child(inner, "ping.exe");
    let registry = Registry::without_watcher();
    let job = registry.capture("pane", shell.id()).unwrap();
    let strays = job.strays();
    assert!(
        strays.contains(&node) && strays.contains(&inner),
        "strays {strays:?}"
    );
    assert!(!job.pids().contains(&node));
    assert!(job.pids().contains(&ping), "ping not captured");
    assert_eq!(class(node), BELOW_NORMAL_PRIORITY_CLASS);
    assert_eq!(class(inner), BELOW_NORMAL_PRIORITY_CLASS);
    // Raised from outside: the next watcher pass forces it back.
    set_class(node, NORMAL_PRIORITY_CLASS);
    registry.pass(&mut Memo::default());
    assert_eq!(class(node), BELOW_NORMAL_PRIORITY_CLASS);
    // Lifting the limit gives strays Normal back.
    registry.set(Settings {
        mode: Mode::Off,
        ..Settings::default()
    });
    assert_eq!(class(node), NORMAL_PRIORITY_CLASS);
    kill_pid(node);
    job.terminate();
    let _ = shell.wait();
}

/// With priority off there is no class to force: a stray that lowered
/// itself stays lowered across watcher passes (no raise back to Normal).
#[test]
fn stray_that_lowered_itself_stays_lowered_while_priority_is_off() {
    let node = node_exe();
    let dir = tempfile::tempdir().unwrap();
    let script = node_agent_script(dir.path());
    let mut shell = cmd(&format!("\"{}\" \"{}\"", node.display(), script.display()));
    let node = wait_child(shell.id(), "node.exe");
    let inner = wait_child(node, "cmd.exe");
    wait_child(inner, "ping.exe");
    let registry = Registry::without_watcher();
    registry.set(Settings {
        mode: Mode::Off,
        ..Settings::default()
    });
    let job = registry.capture("pane", shell.id()).unwrap();
    assert!(job.strays().contains(&node), "strays {:?}", job.strays());
    set_class(node, IDLE_PRIORITY_CLASS);
    set_class(inner, BELOW_NORMAL_PRIORITY_CLASS);
    let mut memo = Memo::default();
    for _ in 0..3 {
        registry.pass(&mut memo);
        assert_eq!(class(node), IDLE_PRIORITY_CLASS);
        assert_eq!(class(inner), BELOW_NORMAL_PRIORITY_CLASS);
    }
    kill_pid(node);
    job.terminate();
    let _ = shell.wait();
}

/// libuv (Node) puts itself and its direct children into a global job of
/// its own (`KILL_ON_JOB_CLOSE | SILENT_BREAKAWAY_OK`), nested in the pane
/// job. The build job must still nest under the pane job: the agent's
/// direct child (in the libuv job) is refused and keeps the pane class, its
/// grandchild (outside the libuv job) goes Idle and survives the agent.
#[test]
fn build_job_nests_under_the_pane_not_under_node() {
    let node = node_exe();
    let dir = tempfile::tempdir().unwrap();
    let script = node_agent_script(dir.path());
    let registry = Registry::without_watcher();
    let mut shell = cmd(&format!(
        "{} -n 2 127.0.0.1 >nul & \"{}\" \"{}\"",
        ping(),
        node.display(),
        script.display()
    ));
    let job = registry.capture("pane", shell.id()).unwrap();
    let m = wait_members(&job, |m| {
        m.iter().any(|(_, n)| n == "node.exe")
            && m.iter().filter(|(_, n)| n == "ping.exe").count() == 1
            && m.iter().filter(|(_, n)| n == "cmd.exe").count() == 2
    });
    let node = pid_of(&m, "node.exe");
    let ping = pid_of(&m, "ping.exe");
    let inner = children_of(node)
        .into_iter()
        .find(|(_, n)| n == "cmd.exe")
        .expect("node's cmd")
        .0;
    // Pre-order: node's cmd is tried first. Before the fix it created the
    // build job inside node's libuv job and ping was then refused.
    registry.pass(&mut Memo::default());
    assert_eq!(class(ping), IDLE_PRIORITY_CLASS);
    assert_eq!(class(inner), BELOW_NORMAL_PRIORITY_CLASS);
    // The agent exits: its libuv job closes and kills node's cmd, but the
    // build job is not inside it, so ping lives on, still Idle.
    // SAFETY: handle opened and closed here.
    unsafe {
        let h = OpenProcess(PROCESS_TERMINATE, 0, node);
        assert!(!h.is_null());
        TerminateProcess(h, 1);
        CloseHandle(h);
    }
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(class(ping), IDLE_PRIORITY_CLASS);
    job.terminate();
    let _ = shell.wait();
}
