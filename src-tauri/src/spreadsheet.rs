//! File persistence for the built-in sheet editor. The UI authors workbooks;
//! this boundary enforces workspace containment, size and conflict checks.
use crate::workspace::{Workspace, USER_MAX_WRITE_BYTES};
use base64::Engine;
use std::io::Write;
use std::sync::Mutex;

static SAVE_LOCK: Mutex<()> = Mutex::new(());

#[tauri::command]
pub async fn spreadsheet_version(workspace_root: String, path: String) -> Result<String, String> {
    crate::blocking::run(move || {
        let ws = Workspace::new(&workspace_root)?;
        let target = ws.resolve_abs_read(&path)?;
        let meta = std::fs::metadata(target).map_err(|e| e.to_string())?;
        let modified = meta
            .modified()
            .map_err(|e| e.to_string())?
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?;
        Ok(format!("{}:{}", meta.len(), modified.as_nanos()))
    })
    .await
}

pub fn save(root: &str, path: &str, content: &str, expected: Option<&str>) -> Result<(), String> {
    let _guard = SAVE_LOCK
        .lock()
        .map_err(|_| "Spreadsheet save lock unavailable")?;
    if !(path.to_lowercase().ends_with(".sheet.json") || path.to_lowercase().ends_with(".xlsx")) {
        return Err("Choose a .sheet.json or .xlsx filename.".into());
    }
    if content.len() as u64 > USER_MAX_WRITE_BYTES * 4 / 3 + 4 {
        return Err("Workbook exceeds the 20 MB save limit.".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(content)
        .map_err(|_| "Invalid workbook bytes")?;
    if bytes.len() as u64 > USER_MAX_WRITE_BYTES {
        return Err("Workbook exceeds the 20 MB save limit.".into());
    }
    let ws = Workspace::new(root)?;
    let target = ws.resolve_abs_readwrite(path)?;
    if let Some(baseline) = expected {
        let current = std::fs::read(&target)
            .map_err(|_| "The original file is no longer available. Save a copy instead.")?;
        if base64::engine::general_purpose::STANDARD.encode(current) != baseline {
            return Err(
                "This file changed on disk. Reload it or save your edits under a new name.".into(),
            );
        }
        // Write the entire replacement before renaming it over the original.
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        let temporary = target.with_extension(format!("klide-{stamp}.tmp"));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        let result = file
            .write_all(&bytes)
            .and_then(|_| file.sync_all())
            .and_then(|_| std::fs::rename(&temporary, &target));
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result.map_err(|e| format!("Unable to save workbook: {e}"))
    } else {
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::AlreadyExists {
                    "A file already exists at that path. Choose a new name.".into()
                } else {
                    format!("Unable to save workbook: {e}")
                }
            })?;
        if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
            let _ = std::fs::remove_file(&target);
            return Err(format!("Unable to save workbook: {error}"));
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn save_spreadsheet(
    workspace_root: String,
    path: String,
    content: String,
    expected: Option<String>,
) -> Result<(), String> {
    crate::blocking::run(move || save(&workspace_root, &path, &content, expected.as_deref())).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn saves_create_only_and_detects_external_edits() {
        let root = std::env::temp_dir().join(format!("klide-sheet-save-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let path = root.join("budget.sheet.json");
        let _ = std::fs::remove_file(&path);
        let original = base64::engine::general_purpose::STANDARD.encode(b"original");
        let updated = base64::engine::general_purpose::STANDARD.encode(b"updated");
        let root_s = root.to_str().unwrap();
        let path_s = path.to_str().unwrap();
        save(root_s, path_s, &original, None).unwrap();
        assert!(save(root_s, path_s, &updated, None)
            .unwrap_err()
            .contains("already exists"));
        save(root_s, path_s, &updated, Some(&original)).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"updated");
        assert!(save(root_s, path_s, &original, Some(&original))
            .unwrap_err()
            .contains("changed on disk"));
        assert!(save(
            root_s,
            root.join("../outside-sheet.xlsx").to_str().unwrap(),
            &original,
            None
        )
        .is_err());
        assert!(save(
            root_s,
            root.join("script.js").to_str().unwrap(),
            &original,
            None
        )
        .is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_outside_workspace() {
        let root = std::env::temp_dir().join(format!("klide-sheet-link-{}", std::process::id()));
        let inside = root.join("inside");
        std::fs::create_dir_all(&inside).unwrap();
        let inside = inside.canonicalize().unwrap();
        let outside = root.join("outside.xlsx");
        std::fs::write(&outside, b"keep").unwrap();
        let link = inside.join("link.xlsx");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert!(save(
            inside.to_str().unwrap(),
            link.to_str().unwrap(),
            "bmV3",
            Some("a2VlcA==")
        )
        .is_err());
        assert_eq!(std::fs::read(outside).unwrap(), b"keep");
        std::fs::remove_dir_all(root).unwrap();
    }
}
