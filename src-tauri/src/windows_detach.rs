//! Windows SSH descendants must escape the session job and inherit no handles.
//! Null standard streams alone do not exclude other inheritable SSH pipes.
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{FromRawHandle, OwnedHandle};
use std::path::Path;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, DETACHED_PROCESS,
    PROCESS_INFORMATION, STARTUPINFOW,
};

fn quote(word: &[u16]) -> Vec<u16> {
    let mut result = vec![b'"' as u16];
    let mut slashes = 0;
    for &unit in word {
        if unit == b'\\' as u16 {
            slashes += 1;
            continue;
        }
        if unit == b'"' as u16 {
            result.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2 + 1));
        } else {
            result.extend(std::iter::repeat_n(b'\\' as u16, slashes));
        }
        slashes = 0;
        result.push(unit);
    }
    result.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
    result.push(b'"' as u16);
    result
}

pub(crate) fn spawn(data_dir: &Path) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut application: Vec<u16> = exe.as_os_str().encode_wide().collect();
    application.push(0);
    let mut command = Vec::new();
    for argument in [
        exe.as_os_str(),
        std::ffi::OsStr::new("ptyd"),
        std::ffi::OsStr::new("--data-dir"),
        data_dir.as_os_str(),
    ] {
        if !command.is_empty() {
            command.push(b' ' as u16);
        }
        command.extend(quote(&argument.encode_wide().collect::<Vec<_>>()));
    }
    command.push(0);
    let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
    startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: both strings are NUL-terminated and remain live for the call.
    // FALSE forbids *all* inherited handles; DETACHED_PROCESS supplies no
    // console/stdio. The current user, environment and directory are retained.
    let ok = unsafe {
        CreateProcessW(
            application.as_ptr(),
            command.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            CREATE_BREAKAWAY_FROM_JOB | CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS,
            std::ptr::null(),
            std::ptr::null(),
            &startup,
            &mut process,
        )
    };
    if ok == 0 {
        return Err(format!("Cannot detach the Run host from Windows OpenSSH. Ensure the SSH server allows job breakaway: {}",io::Error::last_os_error()));
    }
    // SAFETY: successful CreateProcessW returned these two owned handles.
    drop(unsafe { OwnedHandle::from_raw_handle(process.hThread) });
    drop(unsafe { OwnedHandle::from_raw_handle(process.hProcess) });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn quoted(value: &str) -> String {
        String::from_utf16(&quote(&value.encode_utf16().collect::<Vec<_>>())).unwrap()
    }
    #[test]
    fn windows_arguments_preserve_spaces_quotes_and_trailing_backslashes() {
        assert_eq!(quoted("C:\\a b\\"), "\"C:\\a b\\\\\"");
        assert_eq!(quoted("a\\\"b"), "\"a\\\\\\\"b\"");
        assert_eq!(quoted("café"), "\"café\"");
    }
}
