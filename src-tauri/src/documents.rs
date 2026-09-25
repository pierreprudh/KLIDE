//! What Klide does with a file a person asks it to open outside the app.
//!
//! A Run can leave anything behind — a deck, a PDF, and also a shell script, a
//! `.command` file, a Mach-O binary with no extension at all. "Open" used to
//! mean "hand the path to the application the machine opens it with", and for
//! a `.command` file that application is Terminal, which runs it. The one click
//! a completion card asks for must never be the click that executes what an
//! agent wrote.
//!
//! So the decision lives here, in Rust, once: [`classify`] reads the file's
//! stat and its first four bytes and answers [`Disposition::Open`] (a known
//! document kind, handed to its app), [`Disposition::Reveal`] (a folder, or a
//! file whose kind Klide does not know — shown in Finder, where the person
//! decides), or [`Disposition::Refuse`] (anything that is, or lives inside,
//! something macOS would execute). The webview only picks which surface to
//! draw; it never decides what is safe to launch.
//!
//! The quarantine xattr is deliberately not consulted: a file a Run wrote on
//! this machine carries none, and a downloaded one is Gatekeeper's to judge.

use serde::Serialize;
use std::io::Read;
use std::path::Path;

/// What `open_entry` will do with a path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Disposition {
    /// A document kind handed to the app that owns it.
    Open,
    /// Shown in Finder, not launched: a folder, or a kind Klide does not know.
    Reveal,
    /// Neither opened nor revealed through this door, with the reason why.
    Refuse(String),
}

/// Document kinds handed straight to their app. A list, not a guess: an
/// unknown extension is revealed, never opened.
const OPEN_EXTENSIONS: &[&str] = &[
    "pdf", "docx", "doc", "odt", "rtf", "pptx", "ppt", "odp", "key", "xlsx", "xls", "ods",
    "numbers", "pages", "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "heic", "svg", "md",
    "txt", "csv", "json",
];

/// Extensions macOS runs, installs, mounts or follows when opened. `.command`,
/// `.tool` and `.terminal` go to Terminal; a `.webloc` or `.fileloc` points
/// somewhere else entirely; the rest are scripts or installers.
const REFUSED_EXTENSIONS: &[&str] = &[
    "app", "command", "tool", "terminal", "fileloc", "webloc", "inetloc", "pkg", "mpkg", "dmg",
    "sh", "bash", "zsh", "py", "rb", "pl", "scpt", "applescript", "workflow", "jar", "action",
    "saver", "plugin", "prefpane",
];

/// Directory suffixes that make everything under them part of an executable
/// bundle — opening a file inside `Foo.app/Contents/MacOS/` is launching it.
const BUNDLE_SUFFIXES: &[&str] = &[".app", ".pkg", ".mpkg", ".framework"];

/// What [`classify_with`] needs to know about the file on disk.
#[derive(Debug, Clone, Copy, Default)]
pub struct Stat {
    pub is_dir: bool,
    /// Any of the owner/group/other execute bits on a regular file.
    pub executable: bool,
}

/// The lowercase extension, with `.sheet.json` read as `json`.
fn extension(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let dot = name.rfind('.')?;
    // A leading dot is a dotfile (`.env`), not an extension marker.
    (dot > 0).then(|| name[dot + 1..].to_ascii_lowercase())
}

/// A known document kind, judged by name alone.
pub fn is_document_kind(path: &Path) -> bool {
    extension(path).is_some_and(|ext| OPEN_EXTENSIONS.contains(&ext.as_str()))
}

/// Kinds Quick Look is asked to picture. Never HTML: Quick Look renders a page
/// in a WebKit that loads what the page references, and a page a Run wrote is
/// not a page Klide should fetch on its behalf.
pub fn is_previewable(path: &Path) -> bool {
    if path.to_string_lossy().to_ascii_lowercase().ends_with(".sheet.json") {
        return true;
    }
    extension(path).is_some_and(|ext| {
        matches!(
            ext.as_str(),
            "xlsx" | "xls" | "docx" | "doc" | "pptx" | "ppt" | "pdf" | "odt" | "odp" | "ods" | "rtf"
                | "key" | "numbers" | "pages" | "png" | "jpg" | "jpeg" | "webp" | "svg"
        )
    })
}

/// Executable judged by name alone — a refused extension, or a path inside a
/// bundle. For callers that only have a path (the produced-file list), so a
/// script a command wrote is never even announced as something to open.
pub fn executable_by_name(path: &Path) -> bool {
    inside_bundle(path)
        || extension(path).is_some_and(|ext| REFUSED_EXTENSIONS.contains(&ext.as_str()))
}

fn inside_bundle(path: &Path) -> bool {
    path.components().any(|component| {
        let name = component.as_os_str().to_string_lossy().to_ascii_lowercase();
        BUNDLE_SUFFIXES.iter().any(|suffix| name.len() > suffix.len() && name.ends_with(suffix))
    })
}

/// A header that says "program", whatever the name says: a `#!` script or a
/// Mach-O image (thin in either byte order and width, or fat).
fn executable_header(head: &[u8]) -> bool {
    if head.starts_with(b"#!") {
        return true;
    }
    let Some(magic) = head.get(..4) else {
        return false;
    };
    matches!(
        magic,
        [0xfe, 0xed, 0xfa, 0xce]
            | [0xfe, 0xed, 0xfa, 0xcf]
            | [0xce, 0xfa, 0xed, 0xfe]
            | [0xcf, 0xfa, 0xed, 0xfe]
            | [0xca, 0xfe, 0xba, 0xbe]
    )
}

/// The decision, from what is already known about the file. Pure, so every
/// rule is tested without a filesystem.
pub fn classify_with(path: &Path, stat: Stat, head: &[u8]) -> Disposition {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string());
    if inside_bundle(path) {
        return Disposition::Refuse(format!(
            "{name} is, or is inside, an application or installer bundle."
        ));
    }
    if extension(path).is_some_and(|ext| REFUSED_EXTENSIONS.contains(&ext.as_str())) {
        return Disposition::Refuse(format!("{name} is a kind of file macOS would run."));
    }
    if stat.is_dir {
        return Disposition::Reveal;
    }
    if stat.executable {
        return Disposition::Refuse(format!("{name} is marked executable."));
    }
    if executable_header(head) {
        return Disposition::Refuse(format!("{name} is a program, whatever its name says."));
    }
    if is_document_kind(path) {
        Disposition::Open
    } else {
        Disposition::Reveal
    }
}

/// The decision for `abs`, read off disk: one stat (following a link, since
/// what opens is what the link points at) and the first four bytes.
pub fn classify(abs: &Path) -> Result<Disposition, String> {
    let meta = std::fs::metadata(abs).map_err(|e| format!("Cannot read {}: {e}", abs.display()))?;
    #[cfg(unix)]
    let executable = {
        use std::os::unix::fs::PermissionsExt;
        meta.is_file() && meta.permissions().mode() & 0o111 != 0
    };
    #[cfg(not(unix))]
    let executable = false;
    let stat = Stat { is_dir: meta.is_dir(), executable };
    let mut head = Vec::with_capacity(4);
    if meta.is_file() {
        if let Ok(file) = std::fs::File::open(abs) {
            let _ = file.take(4).read_to_end(&mut head);
        }
    }
    Ok(classify_with(abs, stat, &head))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "klide-documents-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn refused(disposition: Disposition) -> bool {
        matches!(disposition, Disposition::Refuse(_))
    }

    #[cfg(unix)]
    #[test]
    fn a_plus_x_file_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("plus-x");
        // No extension, no shebang, no magic: only the mode bit says "program".
        let path = dir.join("run");
        std::fs::write(&path, b"echo hi\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(refused(classify(&path).unwrap()));
        // A document kind with the bit set is refused too — the bit wins.
        let deck = dir.join("deck.pdf");
        std::fs::write(&deck, b"%PDF").unwrap();
        std::fs::set_permissions(&deck, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(refused(classify(&deck).unwrap()));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn mach_o_magic_is_refused_without_mode_bits() {
        let stat = Stat::default();
        for magic in [
            [0xcf, 0xfa, 0xed, 0xfe],
            [0xfe, 0xed, 0xfa, 0xcf],
            [0xce, 0xfa, 0xed, 0xfe],
            [0xca, 0xfe, 0xba, 0xbe],
        ] {
            assert!(refused(classify_with(Path::new("/w/report.pdf"), stat, &magic)));
        }
        assert!(refused(classify_with(Path::new("/w/notes.txt"), stat, b"#!/b")));
        assert_eq!(classify_with(Path::new("/w/report.pdf"), stat, b"%PDF"), Disposition::Open);
    }

    #[test]
    fn a_command_file_and_anything_inside_an_app_bundle_are_refused() {
        let stat = Stat::default();
        for path in [
            "/w/setup.command",
            "/w/Build.TOOL",
            "/w/go.sh",
            "/w/link.webloc",
            "/w/Installer.pkg",
            "/w/Foo.app/Contents/Resources/readme.pdf",
            "/w/Foo.app",
        ] {
            assert!(refused(classify_with(Path::new(path), stat, b"")), "{path}");
        }
        let dir = Stat { is_dir: true, ..Stat::default() };
        assert!(refused(classify_with(Path::new("/w/Foo.app"), dir, b"")));
        assert!(executable_by_name(Path::new("out/deploy.command")));
        assert!(!executable_by_name(Path::new("decks/Q3.pptx")));
    }

    #[test]
    fn no_extension_is_revealed_not_opened() {
        let stat = Stat::default();
        assert_eq!(classify_with(Path::new("/w/build/output"), stat, b"\0\0\0\0"), Disposition::Reveal);
        assert_eq!(classify_with(Path::new("/w/.env"), stat, b"KEY="), Disposition::Reveal);
        assert_eq!(classify_with(Path::new("/w/archive.tar.zst"), stat, b"(\xb5/\xfd"), Disposition::Reveal);
    }

    #[test]
    fn a_directory_is_revealed() {
        let dir = temp_dir("folder");
        assert_eq!(classify(&dir).unwrap(), Disposition::Reveal);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_deck_and_a_pdf_open() {
        let dir = temp_dir("deck");
        for name in ["Q3 review.pptx", "report.PDF", "budget.sheet.json"] {
            let path = dir.join(name);
            std::fs::write(&path, b"PK\x03\x04").unwrap();
            assert_eq!(classify(&path).unwrap(), Disposition::Open, "{name}");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn html_is_never_previewable() {
        assert!(!is_previewable(Path::new("site/index.html")));
        assert!(!is_previewable(Path::new("site/INDEX.HTM")));
        assert!(is_previewable(Path::new("decks/Q3.pptx")));
        assert!(is_previewable(Path::new("budget.sheet.json")));
        assert!(!is_previewable(Path::new("data.json")));
    }

    #[test]
    fn a_disposition_crosses_the_wire_as_a_word() {
        assert_eq!(serde_json::to_string(&Disposition::Open).unwrap(), "\"open\"");
        assert_eq!(serde_json::to_string(&Disposition::Reveal).unwrap(), "\"reveal\"");
    }
}
