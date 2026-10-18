//! Current-user-only DACL for the host pipe (same as `voice/pipe.rs`).
#![cfg(windows)]

use std::ffi::c_void;
use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
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

pub fn current_user_sid() -> Result<String, String> {
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
