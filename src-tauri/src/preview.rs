//! A picture of a document Klide cannot render — a deck, a spreadsheet, a PDF.
//!
//! macOS already draws all of them for Quick Look, so `qlmanage` is asked for
//! a thumbnail rather than Klide growing a converter per format. One render is
//! ~200 ms of a separate process, and until now every look paid it again: the
//! card in the panel drew a file at 900 px, the viewer threw that away and
//! drew it at 1800 px, drew every rail entry at 220 px, and drew it all over
//! again when the reader stepped back to a document they had just seen.
//!
//! The memo here remembers each rendered picture against the file's identity
//! on disk — `(mtime_ns, len)`, the same trust `file_memo` places in a stat —
//! and the size it was asked at. A rewritten deck re-renders; a second look at
//! the same one is a map lookup. The render itself is a seam (`Render`) so the
//! memo is tested without Quick Look, and off macOS the honest answer is that
//! there is no preview rather than a broken one.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Pictures remembered at once. An 1800 px deck is ~230 KB as a data URI, so
/// this is a few tens of MB at the very worst, and a run makes a handful of
/// documents, not hundreds. Past it the memo starts over rather than growing
/// with the session.
const MAX_ENTRIES: usize = 96;

/// The smallest and largest long edge a caller may ask for. Below 120 Quick
/// Look draws an icon; above 2000 it draws nothing a window could show.
const MIN_SIZE: u32 = 120;
const MAX_SIZE: u32 = 2000;
const DEFAULT_SIZE: u32 = 900;

struct Entry {
    mtime_ns: u128,
    len: u64,
    data_uri: String,
}

static MEMO: OnceLock<Mutex<HashMap<(PathBuf, u32), Entry>>> = OnceLock::new();

fn memo() -> &'static Mutex<HashMap<(PathBuf, u32), Entry>> {
    MEMO.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The requested size, held to what Quick Look can honour.
pub fn clamp_size(size: Option<u32>) -> u32 {
    size.unwrap_or(DEFAULT_SIZE).clamp(MIN_SIZE, MAX_SIZE)
}

/// The picture of `abs` at `size`, as a `data:` URI, remembered for next time.
///
/// A file whose metadata cannot be read is rendered and not remembered — the
/// caller sees exactly what it would have without the memo, and the render is
/// the one that reports why.
///
/// `render` is how a picture is drawn — the absolute file and the long edge in
/// px, to PNG bytes: Quick Look in the app, anything at all in a test.
pub fn data_uri(
    abs: &Path,
    size: u32,
    render: impl Fn(&Path, u32) -> Result<Vec<u8>, String>,
) -> Result<String, String> {
    use base64::Engine;
    let identity = std::fs::symlink_metadata(abs).ok().map(|meta| {
        let mtime_ns = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        (mtime_ns, meta.len())
    });
    let key = (abs.to_path_buf(), size);
    if let Some((mtime_ns, len)) = identity {
        if let Some(hit) = memo().lock().unwrap().get(&key) {
            if hit.mtime_ns == mtime_ns && hit.len == len {
                return Ok(hit.data_uri.clone());
            }
        }
    }
    // Render outside the lock: one deck must not stall every other picture,
    // and two threads drawing the same file once each is cheaper than
    // serializing all of them.
    let png = render(abs, size)?;
    let data_uri = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&png)
    );
    if let Some((mtime_ns, len)) = identity {
        let mut map = memo().lock().unwrap();
        if map.len() >= MAX_ENTRIES {
            map.clear();
        }
        map.insert(
            key,
            Entry {
                mtime_ns,
                len,
                data_uri: data_uri.clone(),
            },
        );
    }
    Ok(data_uri)
}

/// How long one Quick Look render may take. A normal one is ~200 ms; a
/// generator that hangs on a malformed file would otherwise hold a blocking
/// worker, and the card waiting on it, forever.
#[cfg(target_os = "macos")]
const QUICK_LOOK_TIMEOUT: Duration = Duration::from_secs(10);

/// Wait for `child`, killing it at `deadline`. A child still running then is
/// reported as a timeout, not a status, so the caller never reads a picture a
/// killed render half wrote as a good one.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn wait_with_deadline(
    mut child: std::process::Child,
    deadline: Duration,
) -> std::io::Result<std::process::ExitStatus> {
    let until = Instant::now() + deadline;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        if Instant::now() >= until {
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("timed out after {} ms", deadline.as_millis()),
            ));
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// Quick Look's picture of `abs`, as PNG bytes.
#[cfg(target_os = "macos")]
pub fn quick_look(abs: &Path, size: u32) -> Result<Vec<u8>, String> {
    let name = abs
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| "That path has no file name.".to_string())?;
    // One directory per request, removed on the way out: qlmanage names its
    // output after the source file, so two previews of `summary.docx` in a
    // shared directory would race for the same name.
    let out = std::env::temp_dir().join(format!(
        "klide-preview-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    ));
    std::fs::create_dir_all(&out).map_err(|e| format!("Cannot make a preview: {e}"))?;
    // Resolved through the login shell like every other binary Klide shells
    // out to: a bundled app launched from Finder has a minimal PATH, and a
    // bare `Command::new` there fails with nothing to show for it.
    let qlmanage = crate::cli::resolve_command("qlmanage")?;
    let status = std::process::Command::new(qlmanage)
        .arg("-t")
        .arg("-s")
        .arg(size.to_string())
        .arg("-o")
        .arg(&out)
        .arg(abs)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .and_then(|child| wait_with_deadline(child, QUICK_LOOK_TIMEOUT));
    let png = out.join(format!("{name}.png"));
    let result = match (status, std::fs::read(&png)) {
        (Ok(_), Ok(bytes)) => Ok(bytes),
        (Ok(status), Err(e)) => Err(format!(
            "Quick Look drew no preview for {name} (qlmanage {status}): {e}"
        )),
        (Err(e), _) => Err(format!("Could not run qlmanage: {e}")),
    };
    let _ = std::fs::remove_dir_all(&out);
    result
}

#[cfg(not(target_os = "macos"))]
pub fn quick_look(_abs: &Path, _size: u32) -> Result<Vec<u8>, String> {
    Err("Previews need macOS Quick Look.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn temp_file(name: &str, bytes: &[u8]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "klide-preview-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn a_second_look_at_the_same_file_and_size_is_not_drawn_again() {
        let path = temp_file("deck.pptx", b"slides");
        let renders = Cell::new(0);
        let render = |_: &Path, _: u32| {
            renders.set(renders.get() + 1);
            Ok(b"png".to_vec())
        };
        let first = data_uri(&path, 1800, &render).unwrap();
        let second = data_uri(&path, 1800, &render).unwrap();
        assert_eq!(first, second);
        assert_eq!(first, "data:image/png;base64,cG5n");
        assert_eq!(renders.get(), 1);
    }

    #[test]
    fn each_size_is_its_own_picture_and_they_do_not_evict_each_other() {
        let path = temp_file("deck.pptx", b"slides");
        let renders = Cell::new(0);
        let render = |_: &Path, size: u32| {
            renders.set(renders.get() + 1);
            Ok(size.to_string().into_bytes())
        };
        // The card at 900, the viewer's canvas at 1800, its rail at 220 —
        // then the reader steps away and back, and every size is still here.
        for size in [900, 1800, 220, 1800, 220, 900] {
            data_uri(&path, size, &render).unwrap();
        }
        assert_eq!(renders.get(), 3);
    }

    #[test]
    fn a_rewritten_file_is_drawn_again() {
        let path = temp_file("summary.docx", b"draft one");
        let renders = Cell::new(0);
        let render = |p: &Path, _: u32| {
            renders.set(renders.get() + 1);
            std::fs::read(p).map_err(|e| e.to_string())
        };
        let before = data_uri(&path, 900, &render).unwrap();
        // A different length is enough: the mtime may land in the same tick.
        std::fs::write(&path, b"draft two, longer").unwrap();
        let after = data_uri(&path, 900, &render).unwrap();
        assert_ne!(before, after);
        assert_eq!(renders.get(), 2);
    }

    #[test]
    fn a_failed_render_is_reported_and_not_remembered() {
        let path = temp_file("broken.key", b"?");
        let renders = Cell::new(0);
        let render = |_: &Path, _: u32| {
            renders.set(renders.get() + 1);
            if renders.get() == 1 {
                Err("Quick Look drew no preview".to_string())
            } else {
                Ok(b"png".to_vec())
            }
        };
        assert!(data_uri(&path, 900, &render).is_err());
        assert!(data_uri(&path, 900, &render).is_ok());
        assert_eq!(renders.get(), 2);
    }

    #[test]
    fn a_missing_file_is_drawn_but_never_remembered() {
        let path = PathBuf::from("/nowhere/klide/preview/missing.pdf");
        let renders = Cell::new(0);
        let render = |_: &Path, _: u32| {
            renders.set(renders.get() + 1);
            Ok(b"png".to_vec())
        };
        data_uri(&path, 900, &render).unwrap();
        data_uri(&path, 900, &render).unwrap();
        assert_eq!(renders.get(), 2);
    }

    #[test]
    fn the_size_is_held_to_what_quick_look_can_draw() {
        assert_eq!(clamp_size(None), 900);
        assert_eq!(clamp_size(Some(16)), 120);
        assert_eq!(clamp_size(Some(9000)), 2000);
        assert_eq!(clamp_size(Some(1800)), 1800);
    }

    #[cfg(unix)]
    #[test]
    fn a_stuck_quick_look_is_killed_at_the_deadline() {
        let child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let started = Instant::now();
        let err = wait_with_deadline(child, Duration::from_millis(200)).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
