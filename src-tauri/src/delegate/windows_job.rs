//! A CLI and every descendant belong to one kernel job. No PID/name based
//! cleanup, and no spawn/assignment race: the primary thread starts suspended.
use std::io;
use std::mem::{size_of, zeroed};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use windows_sys::Win32::{
    Foundation::INVALID_HANDLE_VALUE,
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
        },
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
    },
};

pub(super) struct Job(OwnedHandle);
impl Job {
    pub fn new() -> io::Result<Self> {
        // SAFETY: null security/name creates an unnamed, non-inherited handle.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = Self(unsafe { OwnedHandle::from_raw_handle(handle) });
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = unsafe {
            SetInformationJobObject(
                job.0.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }
    pub fn attach_and_resume(&self, child: &tokio::process::Child) -> io::Result<()> {
        let process = child
            .raw_handle()
            .ok_or_else(|| io::Error::other("CLI process handle unavailable"))?;
        let pid = child
            .id()
            .ok_or_else(|| io::Error::other("CLI process exited before assignment"))?;
        // SAFETY: both handles are owned and live. A failed assignment is fatal;
        // the caller kills the still-suspended child instead of running it loose.
        if unsafe { AssignProcessToJobObject(self.0.as_raw_handle(), process) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
        let mut entry: THREADENTRY32 = unsafe { zeroed() };
        entry.dwSize = size_of::<THREADENTRY32>() as u32;
        let mut found = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) };
        while found != 0 {
            if entry.th32OwnerProcessID == pid {
                // The owned process has not executed, so this is its primary
                // thread. It cannot create/recycle threads before we resume it.
                let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
                if thread.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let thread = unsafe { OwnedHandle::from_raw_handle(thread) };
                if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
                    return Err(io::Error::last_os_error());
                }
                return Ok(());
            }
            found = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) };
        }
        Err(io::Error::other("Could not find the suspended CLI thread"))
    }
    pub fn terminate(&self) {
        // SAFETY: this job is owned for this CLI's entire lifetime. Closing the
        // final handle also kills descendants after the leader has been reaped.
        unsafe {
            TerminateJobObject(self.0.as_raw_handle(), 1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn dropping_a_delegate_stops_its_descendants_and_preserves_other_processes() {
        use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
        };
        let path = std::env::temp_dir().join(format!(
            "klide-job-{}.pid",
            crate::agent::transcripts::run_id()
        ));
        let script=format!("$p=[Diagnostics.ProcessStartInfo]::new('powershell.exe','-NoProfile -Command Start-Sleep -Seconds 30'); $p.UseShellExecute=$false; $p.CreateNoWindow=$true; $child=[Diagnostics.Process]::Start($p); [IO.File]::WriteAllText({},$child.Id.ToString()); Start-Sleep -Seconds 30",crate::remote_platform::ps_quote(&path.to_string_lossy()));
        let mut command = tokio::process::Command::new("powershell.exe");
        command
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let child = super::super::Child::spawn(&mut command).unwrap();
        let mut unrelated = tokio::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"])
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let pid = loop {
            if let Ok(text) = std::fs::read_to_string(&path) {
                if let Ok(pid) = text.parse::<u32>() {
                    break pid;
                }
            }
            assert!(
                std::time::Instant::now() < deadline,
                "Delegate did not create its child"
            );
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        };
        // Keep a handle to this exact descendant across cancellation. No PID
        // reuse can make this assertion accidentally inspect another process.
        let descendant = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        assert!(!descendant.is_null());
        let descendant = unsafe { OwnedHandle::from_raw_handle(descendant) };
        drop(child);
        assert_eq!(
            unsafe { WaitForSingleObject(descendant.as_raw_handle(), 5000) },
            WAIT_OBJECT_0
        );
        assert!(unrelated.try_wait().unwrap().is_none());
        unrelated.kill().await.unwrap();
        let _ = std::fs::remove_file(path);
    }
}
