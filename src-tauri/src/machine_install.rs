//! Install a CI-built native Run host through the user's existing SSH config.
//! Explicit Settings action only. No CLI login or Mac credential is copied.
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn run(command: &mut Command) -> Result<Output, String> {
    use std::io::Read;
    use std::process::Stdio;
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stdout = child.stdout.take().ok_or("No setup stdout")?;
    let mut stderr = child.stderr.take().ok_or("No setup stderr")?;
    let output = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).map(|_| bytes)
    });
    let errors = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).map(|_| bytes)
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(180);
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(
                "Machine setup timed out. Check SSH and GitHub connectivity, then retry.".into(),
            );
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    };
    let out = Output {
        status,
        stdout: output
            .join()
            .map_err(|_| "Setup output reader stopped")?
            .map_err(|e| e.to_string())?,
        stderr: errors
            .join()
            .map_err(|_| "Setup error reader stopped")?
            .map_err(|e| e.to_string())?,
    };
    if out.status.success() {
        Ok(out)
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

pub(crate) fn ssh(host: &str, script: &str) -> Result<Output, String> {
    crate::machines::validate_ssh_host(host)?;
    run(Command::new("ssh").args(crate::machines::SSH_OPTS).args([
        "-o",
        "StrictHostKeyChecking=yes",
        "-T",
        "--",
        host,
        script,
    ]))
}

pub(crate) fn detect_target(host: &str) -> Result<crate::remote_platform::HostTarget, String> {
    // A Unix probe also works when Windows has a POSIX default shell. Fall
    // back to native PowerShell for OpenSSH's default cmd.exe configuration.
    let first = ssh(host, "uname -sm");
    match &first {
        Ok(out) => {
            if let Ok(target) =
                crate::remote_platform::parse_system(&String::from_utf8_lossy(&out.stdout))
            {
                return Ok(target);
            }
        }
        Err(error)
            if error.contains("Permission denied")
                || error.contains("Host key")
                || error.contains("IDENTIFICATION HAS CHANGED")
                || error.contains("timed out")
                || error.contains("Could not resolve")
                || error.contains("Connection refused") =>
        {
            return Err(error.clone())
        }
        _ => {}
    }
    let out = ssh(
        host,
        &crate::remote_platform::powershell(crate::remote_platform::WINDOWS_SYSTEM_PROBE),
    )?;
    crate::remote_platform::parse_system(&String::from_utf8_lossy(&out.stdout))
}

fn artifact(cache: &Path, target: crate::remote_platform::HostTarget) -> Result<PathBuf, String> {
    use sha2::{Digest, Sha256};
    use std::io::{Read, Write};
    static DOWNLOAD: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = DOWNLOAD.lock().map_err(|_| "Download lock unavailable")?;
    let asset = target.asset()?;
    let cache = cache.join(asset);
    let source = env!("KLIDE_SOURCE_COMMIT");
    if source.len() != 40 || !source.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("This development build has no published remote helper. Choose a matching downloaded binary in Advanced.".into());
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .user_agent("Klide-machine-setup")
        .build()
        .map_err(|e| e.to_string())?;
    let base = format!("https://github.com/pierreprudh/KLIDE/releases/download/host-{source}");
    let download_error = |e: reqwest::Error| {
        format!("Could not download the matching remote helper. Check this computer’s connection, or choose a downloaded binary in Advanced. {e}")
    };
    let mut manifest = String::new();
    client
        .get(format!("{base}/{asset}.sha256"))
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(download_error)?
        .take(1024)
        .read_to_string(&mut manifest)
        .map_err(|e| e.to_string())?;
    let checksum = manifest.split_whitespace().next().unwrap_or("");
    if checksum.len() != 64 || !checksum.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid remote helper checksum manifest".into());
    }
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let binary = cache.join("klide");
    if let Ok(mut file) = std::fs::File::open(&binary) {
        let mut digest = Sha256::new();
        std::io::copy(&mut file, &mut digest).map_err(|e| e.to_string())?;
        if format!("{:x}", digest.finalize()).eq_ignore_ascii_case(checksum) {
            return Ok(binary);
        }
    }
    let temporary = cache.join("klide.download");
    let result = (|| {
        let mut response = client
            .get(format!("{base}/{asset}"))
            .send()
            .and_then(|r| r.error_for_status())
            .map_err(download_error)?;
        let mut file = std::fs::File::create(&temporary).map_err(|e| e.to_string())?;
        let mut digest = Sha256::new();
        let mut buffer = [0u8; 65536];
        let mut size = 0usize;
        loop {
            let count = response.read(&mut buffer).map_err(|e| e.to_string())?;
            if count == 0 {
                break;
            }
            size += count;
            if size > 128 * 1024 * 1024 {
                return Err("Remote helper exceeds the download limit".into());
            }
            digest.update(&buffer[..count]);
            file.write_all(&buffer[..count])
                .map_err(|e| e.to_string())?;
        }
        if !format!("{:x}", digest.finalize()).eq_ignore_ascii_case(checksum) {
            return Err("Remote helper checksum did not match. Retry the download.".into());
        }
        file.sync_all().map_err(|e| e.to_string())?;
        std::fs::rename(&temporary, &binary).map_err(|e| e.to_string())?;
        Ok(binary)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

fn cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("remote-host")
        .join(env!("KLIDE_SOURCE_COMMIT")))
}

/// Download on this Mac only; the saved machine may be switched off.
#[tauri::command]
pub async fn machine_prepare_host(
    app: tauri::AppHandle,
    target: Option<crate::remote_platform::HostTarget>,
) -> Result<(), String> {
    let cache = cache_dir(&app)?;
    crate::blocking::run(move || {
        artifact(
            &cache,
            target.unwrap_or(crate::remote_platform::HostTarget {
                os: crate::remote_platform::HostOs::Linux,
                arch: crate::remote_platform::HostArch::X86_64,
            }),
        )
        .map(|_| ())
    })
    .await
}

/// Stage and validate before replacing anything. The remote advisory lock is
/// also held by `ptyd connect --ensure` through its version check and startup,
/// so a new Run cannot race the install's idle check.
fn install_script(staged: &str, os: crate::remote_platform::HostOs) -> String {
    use crate::remote_platform::{ps_path, ps_quote, HostOs};
    let expected = format!(
        "{} {} {}",
        env!("CARGO_PKG_VERSION"),
        crate::pty_wire::PROTOCOL_VERSION,
        env!("KLIDE_SOURCE_COMMIT")
    );
    if os == HostOs::Windows {
        os.command(&format!("$ErrorActionPreference='Stop'; $stage={}; try {{ & $stage ptyd install --expected {} --destination {} --data-dir {}; $code=$LASTEXITCODE }} finally {{ Remove-Item -LiteralPath $stage -Force -ErrorAction SilentlyContinue }}; exit $code", ps_path(staged), ps_quote(&expected), ps_path(os.binary()), ps_path("~/.klide/run-host")))
    } else {
        format!(
            "sh -c {} -- {} {}",
            crate::delegate::shell_quote(include_str!("../../scripts/remote-host/install-host.sh")),
            crate::machines::remote_path_word(staged),
            crate::delegate::shell_quote(&expected)
        )
    }
}

#[tauri::command]
pub async fn machine_install_host(
    app: tauri::AppHandle,
    id: String,
    binary_path: Option<String>,
) -> Result<(), String> {
    let cache = cache_dir(&app)?;
    crate::blocking::run(move || {
        let machine = crate::machines::get(&id).ok_or("Machine is no longer configured")?;
        crate::machines::validate_machine(&machine)?;
        let target = detect_target(&machine.ssh_host)?;
        let binary = match binary_path {
            Some(path) => PathBuf::from(path),
            None => artifact(&cache, target)?,
        };
        let metadata = std::fs::metadata(&binary).map_err(|e| e.to_string())?;
        if !metadata.is_file() {
            return Err("Choose the extracted native klide binary".into());
        }
        let extension = if target.os == crate::remote_platform::HostOs::Windows { ".exe" } else { "" };
        let relative = format!(".klide/bin/klide-stage-{}-{}{extension}", std::process::id(), crate::pty_host::now_ms());
        let staged = format!("~/{relative}");
        let mkdir = if target.os == crate::remote_platform::HostOs::Windows {
            target.os.command("$ErrorActionPreference='Stop'; New-Item -ItemType Directory -Force -Path (Join-Path $HOME '.klide/bin') | Out-Null")
        } else { "umask 077; mkdir -p \"$HOME/.klide/bin\"".into() };
        ssh(&machine.ssh_host, &mkdir)?;
        // SFTP copies bytes without a PowerShell text pipeline. Keep the
        // destination relative to the OpenSSH user's home on every platform.
        let host = scp_host(&machine.ssh_host);
        run(Command::new("scp").args(crate::machines::SSH_OPTS).args(["-o", "StrictHostKeyChecking=yes", "--"]).arg(&binary).arg(format!("{host}:{relative}")))?;
        ssh(&machine.ssh_host, &install_script(&staged, target.os))?;
        Ok(())
    })
    .await
}

fn scp_host(host: &str) -> String {
    let (user, address) = host
        .rsplit_once('@')
        .map_or((String::new(), host), |(u, h)| (format!("{u}@"), h));
    if address.contains(':') && !address.starts_with('[') {
        format!("{user}[{address}]")
    } else {
        host.to_string()
    }
}

/// Executed by the staged native helper. A kernel lease replaces the Linux
/// flock utility so the same atomic admission rule works on macOS/Windows.
pub fn install_main(destination: &Path, data_dir: &Path, expected: &str) -> i32 {
    let result = (|| -> Result<(), String> {
        let actual = format!(
            "{} {} {}",
            env!("CARGO_PKG_VERSION"),
            crate::pty_wire::PROTOCOL_VERSION,
            env!("KLIDE_SOURCE_COMMIT")
        );
        if actual != expected {
            return Err("The host binary does not match this app revision".into());
        }
        let _lease = crate::process_lock::exclusive(&data_dir.join("upgrade.lock"))?;
        if crate::pty_daemon::prepare_upgrade_main(data_dir) != 0 {
            return Err("The existing Run host could not be safely stopped".into());
        }
        // The endpoint can disappear just before the old process releases its
        // executable and ownership lease. Wait for the process, not a delay.
        let owner = crate::process_lock::exclusive(&data_dir.join("daemon-owner.lock"))?;
        let stage = std::env::current_exe().map_err(|e| e.to_string())?;
        let temporary = destination.with_extension("installing");
        std::fs::copy(&stage, &temporary).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        // Windows cannot replace a mapped executable. The old daemon has now
        // exited, but a short-lived relay may still have its image open.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            match std::fs::rename(&temporary, destination) {
                Ok(()) => break,
                Err(_) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(std::time::Duration::from_millis(50))
                }
                Err(e) => {
                    let _ = std::fs::remove_file(&temporary);
                    return Err(format!("Cannot replace the host binary: {e}"));
                }
            }
        }
        drop(owner);
        let status = Command::new(destination)
            .arg("ptyd")
            .arg("ensure")
            .arg("--data-dir")
            .arg(data_dir)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("The installed Run host could not start".into());
        }
        Ok(())
    })();
    match result {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("{error}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scp_addresses_preserve_usernames_and_bracket_ipv6() {
        assert_eq!(scp_host("dev@100.64.0.2"), "dev@100.64.0.2");
        assert_eq!(scp_host("dev@fd7a:115c:a1e0::1"), "dev@[fd7a:115c:a1e0::1]");
        assert_eq!(scp_host("[::1]"), "[::1]");
        assert_eq!(scp_host("my-mini"), "my-mini");
    }
}
