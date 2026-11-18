//! Cross-process leases for admission and durable schedule controls. File
//! locks use flock on Unix and LockFileEx on Windows and die with the owner.
use std::path::Path;
pub(crate) struct Lease {
    file: std::fs::File,
}
pub(crate) fn exclusive(path: &Path) -> Result<Lease, String> {
    lock(path, false)?.ok_or("Could not acquire the process lease".into())
}
/// Non-blocking on every host: `Ok(None)` when another process holds it.

pub(crate) fn try_exclusive(path: &Path) -> Result<Option<Lease>, String> {
    lock(path, true)
}
fn lock(path: &Path, nonblocking: bool) -> Result<Option<Lease>, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path).map_err(|e| e.to_string())?;
    loop {
        let result = if nonblocking {
            file.try_lock()
        } else {
            file.lock().map_err(std::fs::TryLockError::Error)
        };
        match result {
            Ok(()) => return Ok(Some(Lease { file })),
            Err(std::fs::TryLockError::WouldBlock) => return Ok(None),
            Err(std::fs::TryLockError::Error(e)) if e.kind() == std::io::ErrorKind::Interrupted => {
                continue
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}
#[cfg(test)]
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
