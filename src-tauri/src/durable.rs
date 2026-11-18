// Durable writes for Klide's own on-disk state under `.klide/` and the app
// data dir.
//
// Everything Rust owns as the durable authority — Mission Markdown, the
// append-only Mission event log, Delegate session metadata, Memory notes —
// used to go out through a bare `std::fs::write`, which truncates the target
// before it writes. A reader that arrives mid-write sees a half file, and a
// crash mid-write leaves one on disk permanently.
//
// That is not a theoretical worry for Missions. ADR-0002 makes the event log
// the authority for what a Mission has done, and `seq` monotonic. A truncated
// last line used to be dropped silently by the reader, which made the *next*
// append reuse a `seq` that was already taken. This module removes the class:
// full-file writes land atomically (temp + rename), appends are one flushed
// `write_all`, and the Mission reader refuses to guess (see
// `missions::read_events`).
//
// The recipe is the standard one — write a sibling temp file, `sync_all` it,
// rename over the destination, then best-effort fsync the directory so the
// rename itself survives a power loss. `accounts.rs` already did this for
// credential files; this is that helper, generalised and shared.

use std::fs;
use std::io::Write;
use std::path::Path;

/// Write `bytes` to `dest` atomically. A concurrent reader sees either the
/// previous contents or the new ones, never a truncated mix.
pub fn write_atomic(dest: &Path, bytes: &[u8]) -> Result<(), String> {
    write_atomic_inner(dest, bytes, false, false)
}

/// `write_atomic`, but the file lands at mode 0600. For anything that holds a
/// credential or a token.
pub fn write_atomic_private(dest: &Path, bytes: &[u8]) -> Result<(), String> {
    write_atomic_inner(dest, bytes, true, false)
}

/// Publish a new file atomically, refusing to replace an existing destination.
pub fn write_atomic_new(dest: &Path, bytes: &[u8]) -> Result<(), String> {
    write_atomic_inner(dest, bytes, false, true)
}

fn write_atomic_inner(dest: &Path, bytes: &[u8], private: bool, create_new: bool) -> Result<(), String> {
    let parent = dest
        .parent()
        .ok_or_else(|| format!("{dest:?} has no parent directory"))?;

    // A fixed `.klide-tmp` sibling (rather than a random name) keeps a crashed
    // write from littering the directory with one orphan per attempt: the next
    // write to the same destination reuses and overwrites it.
    let tmp = tmp_path(dest);

    {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(!create_new)
            .create_new(create_new)
            .open(&tmp)
            .map_err(|e| format!("Could not create {tmp:?}: {e}"))?;
        if private {
            set_private(&tmp);
        }
        file.write_all(bytes)
            .map_err(|e| format!("Could not write {tmp:?}: {e}"))?;
        // Flush the bytes to the device before the rename, so the rename can
        // never publish a file whose contents are still only in the page cache.
        file.sync_all()
            .map_err(|e| format!("Could not flush {tmp:?}: {e}"))?;
    }

    // A hard link publishes the fully flushed inode but fails if dest exists.
    // Exclusive temp creation also prevents concurrent writers sharing an inode.
    let publish = if create_new {
        fs::hard_link(&tmp, dest)
    } else {
        fs::rename(&tmp, dest)
    };
    publish.map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Could not move {tmp:?} into place: {e}")
    })?;

    if create_new {
        let _ = fs::remove_file(&tmp);
    }

    // Best-effort: durably record the rename itself. Failure here means the
    // new contents are on the device but the directory entry might not survive
    // a power loss — not worth failing a user-visible action over.
    if let Ok(dir) = fs::File::open(parent) {
        let _ = dir.sync_all();
    }
    Ok(())
}

/// Append one line (a trailing newline is added) to an append-only log,
/// flushed to the device before returning.
///
/// The line is handed to the OS as a single `write_all` on a descriptor opened
/// with `O_APPEND`, so a concurrent appender cannot interleave inside it. That
/// plus a strict reader is what keeps the Mission event log's `seq` honest.
pub fn append_line(path: &Path, line: &str) -> Result<(), String> {
    append(path, line, true)
}

/// [`append_line`] without waiting for the disk. For high-rate records whose
/// loss on power failure is harmless because a later synced record supersedes
/// them (streamed answer text before its final message). `sync_data` flushes
/// the whole file, so the next synced append also persists these: a crash can
/// only drop a tail, never tear the interior.
pub fn append_line_unsynced(path: &Path, line: &str) -> Result<(), String> {
    append(path, line, false)
}

fn append(path: &Path, line: &str, sync: bool) -> Result<(), String> {
    let mut buf = String::with_capacity(line.len() + 1);
    buf.push_str(line);
    buf.push('\n');

    let existed = path.exists();
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("Could not open {path:?}: {e}"))?;
    // A fresh log lands at 0600 — run transcripts and Mission event logs hold
    // conversation content. The exists() check means the chmod only happens on
    // the first append after creation, never on the steady-state path.
    if !existed {
        set_private(path);
    }
    // Every append holds the file's flock across repair + write, so a repair
    // can never trim a line another appender is still writing.
    lock_exclusive(&file)?;
    let result = (|| {
        repair_torn_tail(path, &file)?;
        file.write_all(buf.as_bytes())
            .map_err(|e| format!("Could not append to {path:?}: {e}"))?;
        if sync {
            file.sync_data()
                .map_err(|e| format!("Could not flush {path:?}: {e}"))?;
        }
        Ok(())
    })();
    unlock(&file);
    result
}

/// A crash between an unsynced write and its flush can leave the log's final
/// line without a newline. Appending then would glue the new record onto the
/// fragment, turning the crash artefact into an *interior* corrupt line that
/// strict readers refuse wholesale. So before appending, drop a torn tail —
/// the readers already tolerate a torn last line. Called with the file's
/// flock held (see `append`).
fn repair_torn_tail(path: &Path, file: &fs::File) -> Result<(), String> {
    let len = file
        .metadata()
        .map_err(|e| format!("Could not stat {path:?}: {e}"))?
        .len();
    if len == 0 {
        return Ok(());
    }
    let mut last = [0u8; 1];
    read_exact_at(path, len - 1, &mut last)?;
    if last[0] == b'\n' {
        return Ok(());
    }
    // Keep everything up to and including the last newline, scanning back in
    // chunks — a long torn line must not read as "no newline anywhere" and
    // wipe the whole log.
    const CHUNK: u64 = 1024 * 1024;
    let mut end = len;
    let mut keep = 0;
    while end > 0 {
        let start = end.saturating_sub(CHUNK);
        let mut chunk = vec![0u8; (end - start) as usize];
        read_exact_at(path, start, &mut chunk)?;
        if let Some(pos) = chunk.iter().rposition(|b| *b == b'\n') {
            keep = start + pos as u64 + 1;
            break;
        }
        end = start;
    }
    file.set_len(keep)
        .map_err(|e| format!("Could not trim torn tail of {path:?}: {e}"))?;
    eprintln!("klide: {path:?} ended in a torn line; trimmed it before appending.");
    Ok(())
}

#[cfg(unix)]
fn read_exact_at(path: &Path, offset: u64, buf: &mut [u8]) -> Result<(), String> {
    use std::os::unix::fs::FileExt;
    let handle = fs::File::open(path).map_err(|e| format!("Could not open {path:?}: {e}"))?;
    handle
        .read_exact_at(buf, offset)
        .map_err(|e| format!("Could not read {path:?}: {e}"))
}

#[cfg(not(unix))]
fn read_exact_at(path: &Path, offset: u64, buf: &mut [u8]) -> Result<(), String> {
    let raw = fs::read(path).map_err(|e| format!("Could not read {path:?}: {e}"))?;
    let start = (offset as usize).min(raw.len());
    let end = (start + buf.len()).min(raw.len());
    buf[..end - start].copy_from_slice(&raw[start..end]);
    Ok(())
}

#[cfg(unix)]
fn lock_exclusive(file: &fs::File) -> Result<(), String> {
    use std::os::fd::AsRawFd;
    loop {
        let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
        if rc == 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::Interrupted {
            continue;
        }
        return Err(format!("Could not lock for tail repair: {error}"));
    }
}

#[cfg(not(unix))]
fn lock_exclusive(_file: &fs::File) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn unlock(file: &fs::File) {
    use std::os::fd::AsRawFd;
    unsafe {
        libc::flock(file.as_raw_fd(), libc::LOCK_UN);
    }
}

#[cfg(not(unix))]
fn unlock(_file: &fs::File) {}

/// The temp sibling `write_atomic` uses. Exposed so callers that scan a
/// directory (scrollback pruning, Mission listing) can skip in-flight writes.
pub fn tmp_path(dest: &Path) -> std::path::PathBuf {
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "unnamed".to_string());
    dest.with_file_name(format!(".{name}.klide-tmp"))
}

/// Is `path` one of `write_atomic`'s in-flight temp files?
pub fn is_tmp_path(path: &Path) -> bool {
    path.file_name()
        .map(|n| {
            let n = n.to_string_lossy();
            n.starts_with('.') && n.ends_with(".klide-tmp")
        })
        .unwrap_or(false)
}

pub(crate) fn set_private(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("klide-durable-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn append_trims_a_torn_tail_before_writing() {
        let dir = tmp_dir("torn");
        let path = dir.join("log.jsonl");
        fs::write(&path, "{\"a\":1}\n{\"torn").unwrap();
        append_line(&path, "{\"b\":2}").unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "{\"a\":1}\n{\"b\":2}\n",
            "the torn fragment is dropped, the new record is whole"
        );
    }

    #[test]
    fn a_torn_tail_longer_than_one_chunk_keeps_the_records_before_it() {
        let dir = tmp_dir("torn-long");
        let path = dir.join("log.jsonl");
        let torn = "x".repeat(3 * 1024 * 1024);
        fs::write(&path, format!("{{\"a\":1}}\n{torn}")).unwrap();
        append_line(&path, "{\"b\":2}").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"a\":1}\n{\"b\":2}\n");
    }

    #[test]
    fn append_leaves_a_clean_ending_alone() {
        let dir = tmp_dir("clean");
        let path = dir.join("log.jsonl");
        append_line(&path, "one").unwrap();
        append_line(&path, "two").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "one\ntwo\n");
    }

    #[test]
    fn write_atomic_replaces_contents_and_leaves_no_temp_behind() {
        let dir = tmp_dir("replace");
        let dest = dir.join("mission.md");

        write_atomic(&dest, b"first").unwrap();
        assert_eq!(fs::read_to_string(&dest).unwrap(), "first");

        write_atomic(&dest, b"second").unwrap();
        assert_eq!(fs::read_to_string(&dest).unwrap(), "second");

        // The temp sibling must not survive a successful write, or a directory
        // scan (Mission listing, scrollback pruning) would trip over it.
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n != "mission.md")
            .collect();
        assert!(leftovers.is_empty(), "unexpected leftovers: {leftovers:?}");
    }

    #[test]
    fn write_atomic_new_never_replaces_an_existing_entry() {
        let dir = tmp_dir("new-only");
        let dest = dir.join("note.md");
        write_atomic_new(&dest, b"first").unwrap();
        assert!(write_atomic_new(&dest, b"second").is_err());
        assert_eq!(fs::read(&dest).unwrap(), b"first");
        assert!(!tmp_path(&dest).exists());
    }

    #[test]
    fn write_atomic_shortening_a_file_does_not_leave_a_stale_tail() {
        // The bug a truncating `fs::write` cannot have but a naive
        // seek-and-overwrite would: writing a shorter document must not leave
        // the old document's tail attached.
        let dir = tmp_dir("shorten");
        let dest = dir.join("events.jsonl");
        write_atomic(&dest, b"aaaaaaaaaaaaaaaaaaaaaaaa").unwrap();
        write_atomic(&dest, b"bb").unwrap();
        assert_eq!(fs::read_to_string(&dest).unwrap(), "bb");
    }

    #[test]
    fn write_atomic_creates_parent_relative_temp_so_rename_stays_on_one_device() {
        let dir = tmp_dir("sibling");
        let dest = dir.join("tasks").join("inspect.md");
        fs::create_dir_all(dest.parent().unwrap()).unwrap();

        let tmp = tmp_path(&dest);
        assert_eq!(tmp.parent(), dest.parent(), "temp must be a sibling");
        assert!(is_tmp_path(&tmp));
        assert!(!is_tmp_path(&dest));

        write_atomic(&dest, b"body").unwrap();
        assert_eq!(fs::read_to_string(&dest).unwrap(), "body");
    }

    #[test]
    fn write_atomic_reports_a_missing_parent_instead_of_panicking() {
        let dir = tmp_dir("missing-parent");
        let dest = dir.join("nope").join("mission.md");
        let err = write_atomic(&dest, b"body").unwrap_err();
        assert!(err.contains("Could not create"), "got: {err}");
    }

    #[test]
    fn append_line_adds_one_newline_terminated_record_per_call() {
        let dir = tmp_dir("append");
        let log = dir.join("events.jsonl");

        append_line(&log, "{\"seq\":0}").unwrap();
        append_line(&log, "{\"seq\":1}").unwrap();
        append_line(&log, "{\"seq\":2}").unwrap();

        let text = fs::read_to_string(&log).unwrap();
        assert_eq!(text, "{\"seq\":0}\n{\"seq\":1}\n{\"seq\":2}\n");
        assert_eq!(text.lines().count(), 3);
    }

    #[test]
    fn append_line_creates_the_log_on_first_use() {
        let dir = tmp_dir("append-create");
        let log = dir.join("events.jsonl");
        assert!(!log.exists());
        append_line(&log, "{}").unwrap();
        assert_eq!(fs::read_to_string(&log).unwrap(), "{}\n");
    }

    #[cfg(unix)]
    #[test]
    fn write_atomic_private_lands_at_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp_dir("private");
        let dest = dir.join("auth.json");
        write_atomic_private(&dest, b"{\"token\":\"x\"}").unwrap();
        let mode = fs::metadata(&dest).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "got {mode:o}");
    }
}
