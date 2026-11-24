//! A real app identity for notifications from unbundled dev builds and services.
//! Running `display notification` through osascript attributes it to Script Editor.
//! A compiled applet instead owns its name, icon, and notification preferences.

use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
};

const SCRIPT: &str = include_str!("../../resources/notifications.applescript");
const ICON: &[u8] = include_bytes!("../../icons/icon.icns");
const IDENTIFIER: &str = "com.pierre.klide.notifications";
static SENDER: Mutex<()> = Mutex::new(());

fn checked(command: &mut Command) -> Result<(), String> {
    let output = command.output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "{}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

fn prepare(root: &Path) -> Result<PathBuf, String> {
    let app = root.join("Klide.app");
    let icon = app.join("Contents/Resources/applet.icns");
    let stamp = root.join("source.applescript");
    if std::fs::read_to_string(&stamp).ok().as_deref() == Some(SCRIPT)
        && std::fs::read(&icon).ok().as_deref() == Some(ICON)
        && app.join("Contents/MacOS/applet").is_file()
    {
        return Ok(app);
    }
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    // The stamp is written last: an interrupted preparation is retried.
    let _ = std::fs::remove_file(&stamp);
    if app.exists() {
        std::fs::remove_dir_all(&app).map_err(|e| e.to_string())?;
    }
    let source = root.join("notification.applescript");
    std::fs::write(&source, SCRIPT).map_err(|e| e.to_string())?;
    checked(
        Command::new("/usr/bin/osacompile")
            .arg("-o")
            .arg(&app)
            .arg(&source),
    )?;
    std::fs::write(&icon, ICON).map_err(|e| e.to_string())?;
    // Recent macOS versions also supply the stock icon in an asset catalog.
    // Remove it and its plist reference so the ICNS is the sole icon source.
    let assets = app.join("Contents/Resources/Assets.car");
    if assets.exists() {
        std::fs::remove_file(assets).map_err(|e| e.to_string())?;
    }
    let plist = app.join("Contents/Info.plist");
    for edit in [
        format!("Add :CFBundleIdentifier string {IDENTIFIER}"),
        "Set :CFBundleName Klide".into(),
        "Delete :CFBundleIconName".into(),
        "Add :CFBundleDisplayName string Klide".into(),
        "Add :LSUIElement bool true".into(),
    ] {
        checked(
            Command::new("/usr/libexec/PlistBuddy")
                .args(["-c", &edit])
                .arg(&plist),
        )?;
    }
    // osacompile signs the applet; the icon and plist edits require a new signature.
    checked(
        Command::new("/usr/bin/codesign")
            .args(["--force", "--sign", "-"])
            .arg(&app),
    )?;
    checked(Command::new("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister").arg("-f").arg(&app))?;
    std::fs::write(stamp, SCRIPT).map_err(|e| e.to_string())?;
    Ok(app)
}

pub(super) fn send(title: &str, body: &str) -> Result<(), String> {
    // Serialize launches so two simultaneous firings cannot overwrite the applet
    // during preparation or send arguments to an already-running instance.
    let _guard = SENDER.lock().map_err(|e| e.to_string())?;
    let home = std::env::var_os("HOME").ok_or("HOME is unavailable")?;
    let root = PathBuf::from(home).join("Library/Caches/com.pierre.klide/notifications-v1");
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    // The scheduled service and separate dev worktrees share this sender too.
    let lease = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join("sender.lock"))
        .map_err(|e| e.to_string())?;
    lease.lock().map_err(|e| e.to_string())?;
    let app = prepare(&root)?;
    checked(
        Command::new("/usr/bin/open")
            .args(["-g", "-n", "-W"])
            .arg(app)
            .args(["--args", "--klide-notification", title, body]),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Requires macOS scripting access, but never posts a notification.
    #[test]
    #[ignore = "requires macOS scripting and Launch Services access"]
    fn helper_has_klide_identity_icon_and_valid_signature() {
        let root =
            std::env::temp_dir().join(format!("klide-notification-test-{}", std::process::id()));
        let app = prepare(&root).unwrap();
        let plist = app.join("Contents/Info.plist");
        for (key, expected) in [
            ("CFBundleIdentifier", IDENTIFIER),
            ("CFBundleName", "Klide"),
            ("CFBundleIconFile", "applet"),
            ("LSUIElement", "true"),
        ] {
            let output = Command::new("/usr/libexec/PlistBuddy")
                .args(["-c", &format!("Print :{key}")])
                .arg(&plist)
                .output()
                .unwrap();
            assert!(output.status.success());
            assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), expected);
        }
        assert_eq!(
            std::fs::read(app.join("Contents/Resources/applet.icns")).unwrap(),
            ICON
        );
        assert!(!app.join("Contents/Resources/Assets.car").exists());
        checked(
            Command::new("/usr/bin/codesign")
                .args(["--verify", "--strict"])
                .arg(&app),
        )
        .unwrap();
        // A second notification reuses the prepared helper.
        let modified = std::fs::metadata(&plist).unwrap().modified().unwrap();
        assert_eq!(prepare(&root).unwrap(), app);
        assert_eq!(
            std::fs::metadata(&plist).unwrap().modified().unwrap(),
            modified
        );
        // An interrupted preparation is repaired.
        std::fs::remove_file(root.join("source.applescript")).unwrap();
        prepare(&root).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
