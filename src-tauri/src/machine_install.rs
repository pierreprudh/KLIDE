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
    let out = run(Command::new("gh").args(["run", "list", "--repo", "pierreprudh/KLIDE", "--workflow", "linux-host.yml",
        "--commit", env!("KLIDE_SOURCE_COMMIT"), "--status", "success", "--limit", "1", "--json", "databaseId"]))
        .map_err(|e| format!("Could not find a matching Linux build. Sign in to gh on this Mac or choose a downloaded host binary. {e}"))?;
    let runs: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    let id = runs[0]["databaseId"].as_u64().ok_or("No Linux host build exists for this app revision. Run the Linux host binary workflow for this revision, or choose its downloaded binary.")?;
    std::fs::create_dir_all(cache).map_err(|e| e.to_string())?;
    run(Command::new("gh")
        .args([
            "run",
            "download",
            &id.to_string(),
            "--repo",
            "pierreprudh/KLIDE",
            "--name",
            "klide-linux-x86_64",
            "--clobber",
            "--dir",
        ])
        .arg(cache))?;
    Ok(cache.join("klide"))
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
        r#"set -eu
export PATH="$HOME/.local/bin:$PATH"
stage={staged}
trap 'rm -f "$stage"' EXIT
chmod 700 "$stage"
actual=$("$stage" ptyd version)
[ "$actual" = {expected} ] || {{ echo 'The host binary does not match this app revision' >&2; exit 1; }}
mkdir -p "$HOME/.klide/run-host"
exec 9>"$HOME/.klide/run-host/upgrade.lock"
flock -x 9
"$stage" ptyd prepare-upgrade --data-dir "$HOME/.klide/run-host"
mv -f "$stage" "$HOME/.klide/bin/klide"
trap - EXIT
"$HOME/.klide/bin/klide" ptyd ensure --data-dir "$HOME/.klide/run-host"
"#
    )
}

#[tauri::command]
pub async fn machine_install_host(
    app: tauri::AppHandle,
    id: String,
    binary_path: Option<String>,
) -> Result<(), String> {
    use tauri::Manager;
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("linux-host")
        .join(env!("KLIDE_SOURCE_COMMIT"));
    crate::blocking::run(move || {
        let machine = crate::machines::get(&id).ok_or("Machine is no longer configured")?;
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
