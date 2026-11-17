//! Install a CI-built Linux Run host through the user's existing SSH config.
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

fn ssh(host: &str, script: &str) -> Result<Output, String> {
    run(Command::new("ssh").args(crate::machines::SSH_OPTS).args([
        "-o",
        "StrictHostKeyChecking=yes",
        "-T",
        "--",
        host,
        script,
    ]))
}

fn artifact(cache: &Path) -> Result<PathBuf, String> {
    use sha2::{Digest, Sha256};
    use std::io::{Read, Write};
    static DOWNLOAD: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = DOWNLOAD.lock().map_err(|_| "Download lock unavailable")?;
    let source = env!("KLIDE_SOURCE_COMMIT");
    if source.len() != 40 || !source.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("This development build has no published Linux helper. Choose a matching downloaded binary in Advanced.".into());
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .user_agent("Klide-machine-setup")
        .build()
        .map_err(|e| e.to_string())?;
    let base = format!("https://github.com/pierreprudh/KLIDE/releases/download/host-{source}");
    let download_error = |e: reqwest::Error| {
        format!("Could not download the matching Linux helper. Check this Mac’s connection, or choose a downloaded binary in Advanced. {e}")
    };
    let mut manifest = String::new();
    client
        .get(format!("{base}/klide-linux-x86_64.sha256"))
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(download_error)?
        .take(1024)
        .read_to_string(&mut manifest)
        .map_err(|e| e.to_string())?;
    let checksum = manifest.split_whitespace().next().unwrap_or("");
    if checksum.len() != 64 || !checksum.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid Linux helper checksum manifest".into());
    }
    std::fs::create_dir_all(cache).map_err(|e| e.to_string())?;
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
            .get(format!("{base}/klide-linux-x86_64"))
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
                return Err("Linux helper exceeds the download limit".into());
            }
            digest.update(&buffer[..count]);
            file.write_all(&buffer[..count])
                .map_err(|e| e.to_string())?;
        }
        if !format!("{:x}", digest.finalize()).eq_ignore_ascii_case(checksum) {
            return Err("Linux helper checksum did not match. Retry the download.".into());
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
        .join("linux-host")
        .join(env!("KLIDE_SOURCE_COMMIT")))
}

/// Download on this Mac only; the saved machine may be switched off.
#[tauri::command]
pub async fn machine_prepare_host(app: tauri::AppHandle) -> Result<(), String> {
    let cache = cache_dir(&app)?;
    crate::blocking::run(move || artifact(&cache).map(|_| ())).await
}

/// Stage and validate before replacing anything. The remote advisory lock is
/// also held by `ptyd connect --ensure` through its version check and startup,
/// so a new Run cannot race the install's idle check.
fn install_script(staged: &str) -> String {
    let staged = crate::machines::remote_path_word(staged);
    let expected = crate::delegate::shell_quote(&format!(
        "{} {} {}",
        env!("CARGO_PKG_VERSION"),
        crate::pty_wire::PROTOCOL_VERSION,
        env!("KLIDE_SOURCE_COMMIT")
    ));
    format!(
        "sh -c {} -- {staged} {expected}",
        crate::delegate::shell_quote(include_str!("../../scripts/remote-host/install-host.sh"))
    )
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
        let arch = ssh(&machine.ssh_host, "uname -sm")?;
        if String::from_utf8_lossy(&arch.stdout).trim() != "Linux x86_64" {
            return Err("The current host build supports x86_64 Linux machines".into());
        }
        let binary = match binary_path {
            Some(path) => PathBuf::from(path),
            None => artifact(&cache)?,
        };
        let metadata = std::fs::metadata(&binary).map_err(|e| e.to_string())?;
        if !metadata.is_file() {
            return Err("Choose the extracted Linux klide binary".into());
        }
        let staged = format!(
            "~/.klide/bin/klide-stage-{}-{}",
            std::process::id(),
            crate::pty_host::now_ms()
        );
        ssh(
            &machine.ssh_host,
            "umask 077; mkdir -p \"$HOME/.klide/bin\"",
        )?;
        let file = std::fs::File::open(&binary).map_err(|e| e.to_string())?;
        let copy = format!(
            "umask 077; cat > {}",
            crate::machines::remote_path_word(&staged)
        );
        run(Command::new("ssh")
            .args(crate::machines::SSH_OPTS)
            .args([
                "-o",
                "StrictHostKeyChecking=yes",
                "-T",
                "--",
                &machine.ssh_host,
                &copy,
            ])
            .stdin(std::process::Stdio::from(file)))?;
        ssh(&machine.ssh_host, &install_script(&staged))?;
        Ok(())
    })
    .await
}
