//! Where a dropped PDF is kept, so the conversation can open it again.
//!
//! The model reads a PDF's extracted text (`pdf_text.rs`), and that text is
//! what the transcript and the conversation index carry. The file itself
//! lives here, once: `<app data>/attachments/<sha256>/<name>.pdf`. The hash
//! folder means dropping the same file twice writes it once, and the name
//! inside it is the one the person dropped, so the document viewer shows
//! "spec.pdf" and not a hash. An attachment records only the relative
//! `<sha256>/<name>.pdf` — never the bytes, which would bloat every line
//! that mentions it.
//!
//! The folder is treated as a root of its own by the renderer, so preview and
//! "Open in app" go through the same workspace-checked commands any document
//! does; nothing here hands out a path outside it.
//!
//! App data rather than the runs folder: a runs-folder move carries only
//! transcript files, and these would be left behind.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use tauri::Manager;

/// The folder dropped PDFs are kept in, under the app's data dir.
pub fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("attachments"))
        .map_err(|e| format!("Unable to resolve the app data dir: {e}"))
}

/// Keep `bytes` under `root` and return where, relative to it.
pub fn store(root: &Path, name: &str, bytes: &[u8]) -> Result<String, String> {
    let hash = format!("{:x}", Sha256::digest(bytes));
    let file = safe_name(name);
    let dest = root.join(&hash).join(&file);
    if !dest.exists() {
        std::fs::create_dir_all(dest.parent().expect("dest has a hash folder"))
            .map_err(|e| format!("Unable to create the attachments folder: {e}"))?;
        crate::durable::write_atomic(&dest, bytes)?;
    }
    Ok(format!("{hash}/{file}"))
}

/// Undo `encodeURIComponent` — how the renderer fits a name with spaces or
/// accents into a header. A malformed escape is kept as written.
pub fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes.get(i + 1..i + 3).and_then(|h| std::str::from_utf8(h).ok());
        match (bytes[i], hex.and_then(|h| u8::from_str_radix(h, 16).ok())) {
            (b'%', Some(byte)) => {
                out.push(byte);
                i += 3;
            }
            (b, _) => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The dropped file's own name, made safe to be one path component: no
/// folders, no control characters, no hidden dotfile, bounded, ending `.pdf`.
fn safe_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control() && *c != ':')
        .collect::<String>()
        .trim()
        .to_string();
    let stem = cleaned
        .strip_suffix(".pdf")
        .or_else(|| cleaned.strip_suffix(".PDF"))
        .unwrap_or(&cleaned)
        .trim_start_matches('.');
    let stem: String = stem.chars().take(120).collect();
    let stem = stem.trim();
    if stem.is_empty() {
        "document.pdf".to_string()
    } else {
        format!("{stem}.pdf")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("klide-attachments-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn keeps_the_file_once_under_its_hash_and_its_own_name() {
        let root = temp_root("once");
        let first = store(&root, "spec.pdf", b"%PDF-1.4 same").unwrap();
        let again = store(&root, "spec.pdf", b"%PDF-1.4 same").unwrap();
        assert_eq!(first, again);
        assert!(first.ends_with("/spec.pdf"), "{first}");
        assert_eq!(std::fs::read(root.join(&first)).unwrap(), b"%PDF-1.4 same");
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn different_bytes_under_one_name_are_different_files() {
        let root = temp_root("differ");
        let a = store(&root, "spec.pdf", b"%PDF-1.4 a").unwrap();
        let b = store(&root, "spec.pdf", b"%PDF-1.4 b").unwrap();
        assert_ne!(a, b);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn decodes_the_name_the_renderer_encoded() {
        assert_eq!(percent_decode("Re%CC%81sume%CC%81%20v2.pdf"), "Re\u{301}sume\u{301} v2.pdf");
        assert_eq!(percent_decode("100%25 done.pdf"), "100% done.pdf");
        assert_eq!(percent_decode("bad%zz%2"), "bad%zz%2");
    }

    #[test]
    fn a_name_cannot_climb_out_of_its_folder() {
        assert_eq!(safe_name("../../etc/passwd"), "passwd.pdf");
        assert_eq!(safe_name("..\\evil.pdf"), "evil.pdf");
        assert_eq!(safe_name(".hidden.pdf"), "hidden.pdf");
        assert_eq!(safe_name("a\u{0}b:c.PDF"), "abc.pdf");
        assert_eq!(safe_name(""), "document.pdf");
        assert_eq!(safe_name(".pdf"), "document.pdf");
        assert_eq!(safe_name(&"x".repeat(500)).len(), 124);
    }
}
