//! Short cross-process leases for admission and durable schedule controls.
//! The kernel releases a lease if either the desktop or service crashes.
use std::path::Path;

pub(crate) struct Lease {
    #[cfg(unix)]
    file: std::fs::File,
}

pub(crate) fn exclusive(path: &Path) -> Result<Lease, String> {
    lock(path, false)?.ok_or("Could not acquire the process lease".into())
}

#[cfg(unix)]
pub(crate) fn try_exclusive(path: &Path) -> Result<Option<Lease>, String> {
    lock(path, true)
}

fn lock(path: &Path, nonblocking: bool) -> Result<Option<Lease>, String> {
    #[cfg(unix)]
    {
        use std::os::{fd::AsRawFd, unix::fs::OpenOptionsExt};
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(path)
            .map_err(|e| e.to_string())?;
        loop {
            if unsafe {
                libc::flock(
                    file.as_raw_fd(),
                    libc::LOCK_EX | if nonblocking { libc::LOCK_NB } else { 0 },
                )
            } == 0
            {
                return Ok(Some(Lease { file }));
            }
            let error = std::io::Error::last_os_error();
            if nonblocking && error.kind() == std::io::ErrorKind::WouldBlock {
                return Ok(None);
            }
            if error.kind() != std::io::ErrorKind::Interrupted {
                return Err(error.to_string());
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (path, nonblocking);
        Ok(Some(Lease {}))
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let _ = unsafe { libc::flock(self.file.as_raw_fd(), libc::LOCK_UN) };
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn independent_openers_wait_until_the_owner_releases() {
        let path = std::env::temp_dir().join(format!(
            "klide-lock-{}",
            crate::agent::transcripts::run_id()
        ));
        let first = exclusive(&path).unwrap();
        assert!(try_exclusive(&path).unwrap().is_none());
        let (tx, rx) = std::sync::mpsc::channel();
        let p = path.clone();
        let second = std::thread::spawn(move || {
            let _lease = exclusive(&p).unwrap();
            tx.send(()).unwrap();
        });
        assert!(rx
            .recv_timeout(std::time::Duration::from_millis(50))
            .is_err());
        drop(first);
        rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
        second.join().unwrap();
        std::fs::remove_file(path).unwrap();
    }
}
