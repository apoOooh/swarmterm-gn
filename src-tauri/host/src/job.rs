//! Windows Job Object helper, moved from the app's `pty.rs` (ADR 0001).
//!
//! Killing a pty's shell with `TerminateProcess` leaves its child/grandchild
//! processes running (Windows does not cascade a kill down the tree). Putting
//! the shell in a job created with `KILL_ON_JOB_CLOSE` means terminating — or
//! merely dropping — the job tears down every descendant. In the host this
//! matters twice: closing a pane frees its tree, and if the host itself dies
//! the handles close with it, so no orphan outlives the process that owned
//! its console.

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
use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

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
