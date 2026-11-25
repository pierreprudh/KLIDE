//! Explicit remote directory browsing. Paths always stay on their SSH machine.
use crate::remote_platform::{ps_path, HostOs};
use serde::{Deserialize, Serialize};

const LIMIT: usize = 500;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteDirectory {
    name: String,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteDirectories {
    path: String,
    parent: Option<String>,
    entries: Vec<RemoteDirectory>,
    truncated: bool,
}

pub(crate) fn validate_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.len() > 4096 || path.contains(['\0', '\n', '\r']) {
        return Err("Choose a remote folder with a valid path.".into());
    }
    let absolute = path.starts_with('/')
        || path == "~"
        || path.starts_with("~/")
        || (path.as_bytes().get(1) == Some(&b':')
            && matches!(path.as_bytes().get(2), Some(b'\\' | b'/')))
        || path.starts_with("\\\\");
    if !absolute {
        return Err("Use an absolute remote path or ~/ for the remote home folder.".into());
    }
    Ok(())
}

fn validate_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty()
        || matches!(name, "." | "..")
        || name.len() > 255
        || name
            .chars()
            .any(|ch| ch.is_control() || "<>:\"/\\|?*".contains(ch))
        || name.ends_with(['.', ' '])
    {
        return Err("Enter a folder name without slashes or special path characters.".into());
    }
    Ok(())
}

fn listing_script(path: &str, os: HostOs) -> Result<String, String> {
    validate_path(path)?;
    if os == HostOs::Windows {
        return Ok(format!("$ErrorActionPreference='Stop'; $p=(Resolve-Path -LiteralPath {}).ProviderPath; if (!(Test-Path -LiteralPath $p -PathType Container)) {{ throw 'Choose a folder' }}; $names=@(Get-ChildItem -LiteralPath $p -Directory -Force -ErrorAction Stop | Select-Object -First 501 -ExpandProperty Name); @{{path=$p; names=$names}} | ConvertTo-Json -Compress", ps_path(path)));
    }
    // NUL framing preserves spaces, quotes and non-ASCII names. Bound the
    // response before it crosses SSH; a partial final record is discarded.
    Ok(format!("set -e\ncd -P {}\nprintf '%s\\0' \"$PWD\"\nfind -L . ! -name . -prune -type d -print0 | head -c 262144", crate::machines::remote_path_word(path)))
}

fn listing(
    path: String,
    mut names: Vec<String>,
    bounded: bool,
    windows: bool,
) -> RemoteDirectories {
    names.retain(|name| name != "." && name != ".." && !name.contains(['\0', '\n', '\r']));
    names.sort_by_cached_key(|name| name.to_lowercase());
    let truncated = bounded || names.len() > LIMIT;
    names.truncate(LIMIT);
    let separator = if windows { '\\' } else { '/' };
    let trimmed = path.trim_end_matches(['/', '\\']);
    let parent = if windows && trimmed.len() <= 2 {
        None
    } else {
        trimmed.rsplit_once(separator).map(|(head, _)| {
            if head.is_empty() {
                separator.to_string()
            } else if windows && head.ends_with(':') {
                format!("{head}\\")
            } else {
                head.to_string()
            }
        })
    };
    let entries = names
        .into_iter()
        .map(|name| RemoteDirectory {
            path: format!("{}{separator}{name}", trimmed),
            name,
        })
        .collect();
    RemoteDirectories {
        path,
        parent,
        entries,
        truncated,
    }
}

fn parse_unix(bytes: &[u8]) -> Result<RemoteDirectories, String> {
    let end = bytes
        .iter()
        .rposition(|byte| *byte == 0)
        .ok_or("The machine did not return a complete folder listing.")?;
    let mut records = bytes[..=end].split(|byte| *byte == 0);
    let path = std::str::from_utf8(records.next().unwrap_or_default())
        .map_err(|_| "This folder path is not valid UTF-8")?;
    if !path.starts_with('/') {
        return Err("The machine did not return a folder path.".into());
    }
    let names: Vec<String> = records
        .filter_map(|record| {
            let name = std::str::from_utf8(record).ok()?.strip_prefix("./")?;
            Some(name.to_string())
        })
        .collect();
    let bounded = !bytes.ends_with(&[0]) || names.len() > LIMIT;
    Ok(listing(path.to_string(), names, bounded, false))
}

fn read(machine: &crate::machines::Machine, path: &str) -> Result<RemoteDirectories, String> {
    let os = crate::machine_runtime::target(&machine)?.os;
    let script = listing_script(path, os)?;
    let out = crate::machine_runtime::ssh(&machine, &os.command(&script))?;
    if os != HostOs::Windows && !out.stderr.is_empty() {
        return Err(
            "Some folders could not be read. Check this remote account's folder permissions."
                .into(),
        );
    }
    if os != HostOs::Windows {
        return parse_unix(&out.stdout);
    }
    #[derive(Deserialize)]
    struct WindowsListing {
        path: String,
        names: Vec<String>,
    }
    let result: WindowsListing = serde_json::from_slice(&out.stdout)
        .map_err(|_| "The machine did not return a folder listing.")?;
    Ok(listing(result.path, result.names, false, true))
}

#[tauri::command]
pub(crate) async fn machine_remote_directories(
    id: String,
    path: String,
) -> Result<RemoteDirectories, String> {
    crate::blocking::run(move || {
        validate_path(&path)?;
        let machine = crate::machines::get(&id).ok_or("Machine is no longer configured")?;
        crate::machines::validate_machine(&machine)?;
        read(&machine, &path)
    })
    .await
}

#[tauri::command]
pub(crate) async fn machine_remote_create_directory(
    id: String,
    parent: String,
    name: String,
) -> Result<RemoteDirectories, String> {
    crate::blocking::run(move || {
        validate_path(&parent)?; validate_name(&name)?;
        let machine = crate::machines::get(&id).ok_or("Machine is no longer configured")?;
        crate::machines::validate_machine(&machine)?;
        let os = crate::machine_runtime::target(&machine)?.os;
        let path = format!("{}/{}", parent.trim_end_matches(['/', '\\']), name);
        let script = if os == HostOs::Windows {
            format!("$ErrorActionPreference='Stop'; New-Item -ItemType Directory -Path {} -ErrorAction Stop | Out-Null", ps_path(&path))
        } else { format!("umask 077\nmkdir -- {}", crate::machines::remote_path_word(&path)) };
        crate::machine_runtime::ssh(&machine, &os.command(&script))?;
        read(&machine, &path)
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths_and_names_cannot_be_shell_options_or_parent_traversals() {
        for path in ["-oProxyCommand=evil", "relative", "/tmp/a\nexit", "~/a\0b"] {
            assert!(validate_path(path).is_err());
        }
        for path in [
            "~",
            "~/code",
            "/tmp/it's a folder",
            "C:\\Users\\Dev",
            "\\\\host\\share",
        ] {
            assert!(validate_path(path).is_ok());
        }
        for name in ["..", ".", "../escape", "one/two", "", "a\nb", "trailing."] {
            assert!(validate_name(name).is_err());
        }
        assert!(validate_name("Project 'one'").is_ok());
        assert!(listing_script("/tmp/it's $(echo evil)", HostOs::Macos)
            .unwrap()
            .contains("'\\''"));
    }
    #[test]
    fn nul_listing_preserves_names_and_reports_bounds() {
        let result = parse_unix(b"/Users/dev\0./Zed\0./a folder\0./it's code\0").unwrap();
        assert_eq!(result.path, "/Users/dev");
        assert_eq!(result.parent.as_deref(), Some("/Users"));
        assert_eq!(result.entries[0].path, "/Users/dev/a folder");
        assert!(!result.truncated);
        let result = parse_unix(b"/\0./complete\0./part").unwrap();
        assert!(result.parent.is_none());
        assert!(result.truncated);
        assert_eq!(result.entries.len(), 1);
    }
    #[cfg(unix)]
    #[test]
    fn real_directory_listing_handles_spaces_hidden_folders_and_symlinks() {
        let root = std::env::temp_dir().join(format!(
            "klide-folder-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("a folder")).unwrap();
        std::fs::create_dir(root.join(".hidden")).unwrap();
        std::fs::write(root.join("file"), "not a folder").unwrap();
        std::os::unix::fs::symlink(root.join("a folder"), root.join("linked")).unwrap();
        let out = std::process::Command::new("sh")
            .args([
                "-c",
                &listing_script(root.to_str().unwrap(), HostOs::Macos).unwrap(),
            ])
            .output()
            .unwrap();
        assert!(out.status.success());
        let result = parse_unix(&out.stdout).unwrap();
        assert_eq!(result.entries.len(), 3);
        std::fs::remove_dir_all(root).unwrap();
    }
}
