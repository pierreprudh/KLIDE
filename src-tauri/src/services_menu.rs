//! "Ask Kit" in the macOS Services menu — select text in any app, right-click,
//! Services → Ask Kit, and Klide opens a new conversation with that text in
//! the composer.
//!
//! It is an Automator Quick Action, not native Services code: a two-file
//! bundle in `~/Library/Services` whose one Run Shell Script step URL-encodes
//! the selection and opens `klide://new?prompt=…`, which `deep_link.rs`
//! handles like any other link — pre-filled, never sent. The same shape Claude
//! installs for "Ask Claude". Klide writes it only when you ask (Settings), and
//! removes only the bundle it wrote.

use std::path::PathBuf;

const INFO_PLIST: &str = include_str!("../resources/ask-kit/Info.plist");
const DOCUMENT: &str = include_str!("../resources/ask-kit/document.wflow");

fn bundle() -> Result<PathBuf, String> {
    let home = crate::cli::home_dir_path().ok_or("No home directory")?;
    Ok(home.join("Library").join("Services").join("Ask Kit.workflow"))
}

/// Ask macOS to re-read the Services folder, so the item appears (or goes)
/// without a log-out. Best effort: the next login rescans anyway.
fn refresh_services() {
    let _ = std::process::Command::new("/System/Library/CoreServices/pbs")
        .arg("-update")
        .status();
}

pub fn installed() -> bool {
    bundle().is_ok_and(|b| b.join("Contents").join("document.wflow").is_file())
}

pub fn install() -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("The Services menu is macOS only".to_string());
    }
    let contents = bundle()?.join("Contents");
    std::fs::create_dir_all(&contents).map_err(|e| format!("Could not create {}: {e}", contents.display()))?;
    std::fs::write(contents.join("Info.plist"), INFO_PLIST).map_err(|e| e.to_string())?;
    std::fs::write(contents.join("document.wflow"), DOCUMENT).map_err(|e| e.to_string())?;
    refresh_services();
    Ok(())
}

pub fn uninstall() -> Result<(), String> {
    let bundle = bundle()?;
    if bundle.exists() {
        std::fs::remove_dir_all(&bundle).map_err(|e| format!("Could not remove {}: {e}", bundle.display()))?;
    }
    refresh_services();
    Ok(())
}

#[tauri::command]
pub(crate) async fn services_ask_kit_status() -> Result<bool, String> {
    crate::blocking::run(|| Ok(installed())).await
}

#[tauri::command]
pub(crate) async fn services_ask_kit_set(enabled: bool) -> Result<bool, String> {
    crate::blocking::run(move || {
        if enabled { install()? } else { uninstall()? }
        Ok(installed())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_action_opens_a_klide_link_and_nothing_else() {
        assert!(DOCUMENT.contains(r#"open "klide://new?prompt=$u""#));
        assert!(!DOCUMENT.contains("claude://"), "copied from Claude's action; its URL must be gone");
        assert!(INFO_PLIST.contains("<string>Ask Kit</string>"));
        assert!(DOCUMENT.contains("com.apple.Automator.servicesMenu"));
    }
}
