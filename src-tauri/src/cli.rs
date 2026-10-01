//! Local-machine CLI plumbing: resolve binaries the way a login shell would,
//! and report whether a subscription CLI is installed and authenticated.
//! Owned here (not in lib.rs) so the other modules that need a binary —
//! delegates, the MLX server, gh — depend downward on a module instead of
//! reaching up into the crate root.

use crate::{custom_cli, delegate, providers};
use std::path::PathBuf;

/// Resolve the user's home directory (HOME, or USERPROFILE on Windows) —
/// the process's, through the one resolver in `delegate::home`.
pub(crate) fn home_dir_path() -> Option<PathBuf> {
    delegate::home_dir(&delegate::ProcessEnv)
}

pub(crate) fn shell_one_line(cmd: &str, arg: &str) -> Option<String> {
    let out = std::process::Command::new(cmd).arg(arg).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn is_executable_file(path: &std::path::Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn executable_candidates(path: &std::path::Path) -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        let mut candidates = vec![path.to_path_buf()];
        if path.extension().is_none() {
            let extensions = std::env::var_os("PATHEXT")
                .and_then(|value| value.into_string().ok())
                .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".to_string());
            for extension in extensions.split(';').filter(|value| !value.is_empty()) {
                let mut candidate = path.as_os_str().to_os_string();
                candidate.push(extension);
                candidates.push(PathBuf::from(candidate));
            }
        }
        candidates
    }
    #[cfg(not(windows))]
    {
        vec![path.to_path_buf()]
    }
}

fn resolved_executable(path: &std::path::Path) -> Option<String> {
    executable_candidates(path)
        .into_iter()
        .find(|candidate| is_executable_file(candidate))
        .map(|candidate| {
            std::fs::canonicalize(&candidate)
                .unwrap_or(candidate)
                .to_string_lossy()
                .to_string()
        })
}

#[cfg(unix)]
fn resolved_from_login_shell(command: &str) -> Option<String> {
    let shell = std::env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into());
    let output = std::process::Command::new(shell)
        .arg("-lc")
        .arg("command -v -- \"$1\"")
        .arg("klide-resolve")
        .arg(command)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    resolved_executable(std::path::Path::new(&path))
}

#[cfg(not(unix))]
fn resolved_from_login_shell(_command: &str) -> Option<String> {
    None
}

/// Resolve a binary the way the user's login shell would — a Finder-launched
/// production app has a minimal PATH, so a bare `Command::new("gh")` fails
/// where the same command works in a terminal.
pub(crate) fn resolve_command(command: &str) -> Result<String, String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("Command is empty".to_string());
    }

    let requested = std::path::Path::new(command);
    if requested.is_absolute() || requested.components().count() > 1 {
        if let Some(path) = resolved_executable(requested) {
            return Ok(path);
        }
    } else if let Some(path) = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .find_map(|directory| resolved_executable(&directory.join(command)))
    }) {
        return Ok(path);
    }
    if let Some(path) = resolved_from_login_shell(command) {
        return Ok(path);
    }

    let home = std::env::var("HOME").unwrap_or_default();
    // Delegate binaries keep their install-path fallbacks behind the seam;
    // only non-delegate binaries (the MLX local server) stay tabled here.
    let candidates = match delegate::ALL.iter().find(|d| d.binary() == command) {
        Some(d) => d.install_paths(&home),
        None => match command {
            "mlx_lm.server" => vec![
                format!("{home}/.pyenv/shims/mlx_lm.server"),
                format!("{home}/.local/bin/mlx_lm.server"),
            ],
            _ => Vec::new(),
        },
    };
    candidates
        .into_iter()
        .find_map(|path| resolved_executable(std::path::Path::new(&path)))
        .ok_or_else(|| format!("{command} CLI is not installed or not on PATH"))
}

pub(crate) fn ensure_command_available(command: &str) -> Result<(), String> {
    resolve_command(command).map(|_| ())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiConnectionStatus {
    provider: String,
    installed: bool,
    connected: bool,
    detail: String,
    command_path: Option<String>,
    login_options: Vec<String>,
}

/// Installed / connected / login-options for a subscription CLI (built-in
/// delegate or user-defined custom CLI). All per-CLI auth knowledge lives
/// behind the Delegate seam; this only resolves the binary and asks.
pub(crate) fn subscription_status(provider: String) -> Result<AiConnectionStatus, String> {
    if let Some(custom) = custom_cli::get(&provider) {
        let binary = custom.binary();
        let resolved = resolve_command(&binary);
        let command_path = resolved.as_ref().ok().cloned();
        let installed = resolved.is_ok();
        let login_options = custom.login_command.iter().cloned().collect();
        return Ok(AiConnectionStatus {
            provider,
            installed,
            connected: installed,
            detail: if installed {
                format!("{} is available for {}", binary, custom.label)
            } else {
                format!("{} is not installed or not on PATH", binary)
            },
            command_path,
            login_options,
        });
    }

    let entry = providers::lookup(&provider)
        .ok_or_else(|| format!("Provider \"{provider}\" is not wired yet"))?;
    let spec = entry
        .subscription
        .as_ref()
        .ok_or_else(|| format!("Provider \"{provider}\" is not a subscription CLI"))?;
    let resolved = resolve_command(spec.cmd());
    let command_path = resolved.as_ref().ok().cloned();
    let installed = resolved.is_ok();

    // Every subscription provider is a delegate, so this lookup always resolves.
    let adapter = delegate::lookup(&provider);
    let login_options = adapter.map(|d| d.login_commands()).unwrap_or_default();

    if !installed {
        return Ok(AiConnectionStatus {
            provider,
            installed: false,
            connected: false,
            detail: format!("{} CLI is not installed or not on PATH", spec.cmd()),
            command_path: None,
            login_options,
        });
    }

    let (connected, detail) = match adapter {
        Some(d) => d.check_auth(command_path.as_deref().unwrap_or(spec.cmd()))?,
        None => (false, "Unknown provider".to_string()),
    };

    Ok(AiConnectionStatus {
        provider,
        installed,
        connected,
        detail,
        command_path,
        login_options,
    })
}

#[cfg(test)]
mod tests {
    use super::resolve_command;

    #[test]
    fn resolve_command_never_interprets_shell_syntax() {
        assert!(resolve_command("does-not-exist; printf injected").is_err());
        let known_command = if cfg!(windows) { "cmd" } else { "sh" };
        assert!(resolve_command(known_command).is_ok());
    }
}
