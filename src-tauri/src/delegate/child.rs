//! Lifetime of a headless Delegate process. Stop drops the provider future;
//! Tokio's kill_on_drop only kills its immediate child. A CLI's shell can
//! have its own session/process group and would then keep editing unattended.
//!
//! Clean descendants before killing/reaping the CLI, while parentage still
//! proves ownership. macOS uses libproc directly (no shell, filesystem scan,
//! or blocking `ps` subprocess on the runtime). Other Unix hosts get group
//! cleanup; Windows retains Tokio's immediate-child backstop.
use std::ops::{Deref, DerefMut};
use tokio::process::{Child as TokioChild, Command};

pub(super) struct Child(TokioChild);

impl Child {
    pub fn spawn(command: &mut Command) -> std::io::Result<Self> {
        #[cfg(unix)]
        command.process_group(0);
        command.kill_on_drop(true).spawn().map(Self)
    }

    fn stop_tree(&mut self) {
        // Tokio clears id after wait/try_wait reaps the child. Never signal a
        // remembered pid after that: it could already belong to somebody else.
        let Some(pid) = self.0.id() else { return };
        #[cfg(not(unix))]
        let _ = pid;
        #[cfg(target_os = "macos")]
        macos::stop_descendants(pid as libc::pid_t);
        #[cfg(unix)]
        unsafe {
            // SAFETY: spawn made this unreaped child's pid its private pgid.
            libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
        }
        let _ = self.0.start_kill();
    }

    // Explicit shutdowns (e.g. OpenCode's per-turn server) use the same path
    // as a dropped/aborted future, before wait() can erase the ownership proof.
    pub async fn kill(&mut self) -> std::io::Result<()> {
        self.stop_tree();
        self.0.wait().await.map(|_| ())
    }
}

impl Deref for Child {
    type Target = TokioChild;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl DerefMut for Child {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

impl Drop for Child {
    fn drop(&mut self) {
        self.stop_tree();
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use libc::{pid_t, proc_bsdinfo};
    use std::mem::{size_of, MaybeUninit};

    fn info(pid: pid_t) -> Option<proc_bsdinfo> {
        let mut value = MaybeUninit::<proc_bsdinfo>::uninit();
        // SAFETY: libproc receives a correctly sized writable buffer. Only a
        // complete result is read, so failures never expose uninitialized data.
        let count = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                value.as_mut_ptr().cast(),
                size_of::<proc_bsdinfo>() as i32,
            )
        };
        (count == size_of::<proc_bsdinfo>() as i32).then(|| unsafe { value.assume_init() })
    }

    fn same_process(before: &proc_bsdinfo, after: &proc_bsdinfo) -> bool {
        before.pbi_pid == after.pbi_pid
            && before.pbi_ppid == after.pbi_ppid
            && before.pbi_start_tvsec == after.pbi_start_tvsec
            && before.pbi_start_tvusec == after.pbi_start_tvusec
    }

    fn children(parent: pid_t) -> Vec<pid_t> {
        let mut pids = vec![0; 64];
        loop {
            // proc_listchildpids returns a PID count, not a byte count.
            // SAFETY: the buffer size describes the whole writable Vec.
            let count = unsafe {
                libc::proc_listchildpids(
                    parent,
                    pids.as_mut_ptr().cast(),
                    (pids.len() * size_of::<pid_t>()) as i32,
                )
            };
            if count <= 0 {
                return Vec::new();
            }
            if (count as usize) < pids.len() {
                pids.truncate(count as usize);
                return pids;
            }
            if pids.len() >= 16384 {
                eprintln!("delegate cleanup: child list exceeded 16384 processes");
                return pids;
            }
            pids.resize(pids.len() * 2, 0);
        }
    }

    pub(super) fn stop_descendants(root: pid_t) {
        let Some(root_info) = info(root) else { return };
        // The owned child must still belong to this host, never a saved PID
        // from another run. No process names or global kill patterns are used.
        if root_info.pbi_ppid != std::process::id() {
            return;
        }
        // SAFETY: root is our direct, unreaped child. Freeze ancestors first
        // so they cannot deliberately spawn/reparent more work during cleanup.
        if unsafe { libc::kill(root, libc::SIGSTOP) } != 0 {
            return;
        }
        let mut tree = vec![root_info];
        let mut cursor = 0;
        while cursor < tree.len() && tree.len() < 16384 {
            let parent = tree[cursor].pbi_pid as pid_t;
            for pid in children(parent) {
                let Some(child) = info(pid) else { continue };
                if child.pbi_ppid != parent as u32 || pid <= 1 {
                    continue;
                }
                // SAFETY: libproc just established a direct child relationship
                // to an owned ancestor. Session/group changes do not erase it.
                if unsafe { libc::kill(pid, libc::SIGSTOP) } == 0 {
                    tree.push(child);
                }
            }
            cursor += 1;
        }
        // Keep stopped parents present until their children have been signalled.
        // Recheck birth time and parentage before each kill to reject stale IDs.
        for child in tree.iter().skip(1).rev() {
            let pid = child.pbi_pid as pid_t;
            if info(pid).is_some_and(|now| same_process(child, &now)) {
                // SAFETY: identity still matches this owned descendant.
                unsafe {
                    libc::kill(pid, libc::SIGKILL);
                }
            }
        }
        // The outer owner kills the root/group, then Tokio reaps it as usual.
    }
}
