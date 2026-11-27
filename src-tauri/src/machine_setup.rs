//! Fixed, interactive setup actions. SSH owns trust and authentication; no
//! credentials cross the IPC boundary or get copied from this Mac.
use portable_pty::CommandBuilder;
use serde::Deserialize;
mod ssh_key;

// Closing setup must terminate SSH even while its PTY reader is still open.
// This registry belongs only to setup, never to detached remote Runs.
static PROCESSES: std::sync::LazyLock<
    std::sync::Mutex<
        std::collections::HashMap<String, Box<dyn portable_pty::ChildKiller + Send + Sync>>,
    >,
> = std::sync::LazyLock::new(Default::default);

pub(crate) fn track(id: &str, killer: Box<dyn portable_pty::ChildKiller + Send + Sync>) {
    PROCESSES.lock().unwrap().insert(id.to_string(), killer);
}
pub(crate) fn finished(id: &str) {
    PROCESSES.lock().unwrap().remove(id);
}

fn cancel(id: &str) -> Result<(), String> {
    if let Some(mut child) = PROCESSES
        .lock()
        .map_err(|_| "Setup process state unavailable")?
        .remove(id)
    {
        child.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn machine_setup_close(app: tauri::AppHandle, id: String) -> Result<(), String> {
    crate::blocking::run(move || {
        use tauri::Manager;
        cancel(&id)?;
        app.state::<crate::pty::PtyState>()
            .shells
            .lock()
            .map_err(|_| "Terminal state unavailable")?
            .remove(&id);
        Ok(())
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SetupAction {
    Connect,
    Authorize,
    Prepare,
    SignIn,
    GitHub,
    Clone,
}

fn script(
    action: &SetupAction,
    machine: &crate::machines::Machine,
    root: Option<&str>,
    os: crate::remote_platform::HostOs,
) -> Result<String, String> {
    if matches!(action, SetupAction::SignIn) && machine.inference.is_some() {
        return Err("OpenRouter uses the authorized API key; Claude account sign-in is not required.".into());
    }
    if os == crate::remote_platform::HostOs::Windows {
        return windows_script(action, machine, root);
    }
    let body = match action {
        SetupAction::Connect => "echo SSH connected".into(),
        SetupAction::Authorize => return Err("SSH authorization must use a local public key".into()),
        SetupAction::Prepare => include_str!("../../scripts/remote-host/prepare-machine.sh").into(),
        SetupAction::SignIn => "exec claude auth login".into(),
        SetupAction::GitHub => return Err("Open a project and connect repository-only access in the GitHub step. Personal GitHub login is not stored on remote machines.".into()),
        SetupAction::Clone => {
            let root = root.ok_or("Open a local project before cloning it remotely")?;
            if crate::machine_repository::github_origin(root) {
                return crate::machine_repository::clone_script(root, &machine.remote_checkout(root), os);
            }
            let repo = crate::machines::origin_repo(root).ok_or(
                "This project has no origin remote. Choose an existing remote checkout instead.",
            )?;
            safe_origin(&repo)?;
            let destination = crate::machines::remote_path_word(&machine.remote_checkout(root));
            format!("destination={destination}\nif test -e \"$destination\"; then echo 'The destination already exists. Choose it as an existing checkout, or use a different folder.'; exit 1; fi\nmkdir -p -- \"$(dirname -- \"$destination\")\"\ngit clone -- {} \"$destination\"", crate::delegate::shell_quote(&repo))
        }
    };
    Ok(format!(
        "export PATH=\"$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\"\nset -e\n{body}"
    ))
}

fn windows_script(
    action: &SetupAction,
    machine: &crate::machines::Machine,
    root: Option<&str>,
) -> Result<String, String> {
    use crate::remote_platform::{ps_path, ps_quote, WINDOWS_PATH};
    let body=match action {
        SetupAction::Connect => "Write-Output 'SSH connected'".into(),
        SetupAction::Authorize => return Err("Use an existing authorized SSH key for Windows machines".into()),
        SetupAction::Prepare => include_str!("../../scripts/remote-host/prepare-machine.ps1").into(),
        SetupAction::SignIn => "& claude auth login; exit $LASTEXITCODE".into(),
        SetupAction::GitHub => return Err("Open a project and connect repository-only access in the GitHub step. Personal GitHub login is not stored on remote machines.".into()),
        SetupAction::Clone => {
            let root=root.ok_or("Open a local project before cloning it remotely")?;
            if crate::machine_repository::github_origin(root) { return crate::machine_repository::clone_script(root,&machine.remote_checkout(root),crate::remote_platform::HostOs::Windows).map(|body| format!("$ErrorActionPreference='Stop'; {} {body}",crate::remote_platform::WINDOWS_PATH)); }
            let repo=crate::machines::origin_repo(root).ok_or("This project has no origin remote. Choose an existing remote checkout instead.")?;
            safe_origin(&repo)?;
            format!("$destination={}; if (Test-Path -LiteralPath $destination) {{ throw 'The destination already exists. Choose an existing checkout or a different folder.' }}; New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null; & git clone -- {} $destination; exit $LASTEXITCODE",ps_path(&machine.remote_checkout(root)),ps_quote(&repo))
        }
    };
    Ok(format!(
        "$ErrorActionPreference='Stop'; {WINDOWS_PATH} {body}"
    ))
}

fn safe_origin(repo: &str) -> Result<(), String> {
    // Only network remotes. In particular, do not copy embedded HTTP credentials
    // or permit Git's ext transport to execute a local command on the server.
    let valid = if repo.starts_with("https://") || repo.starts_with("ssh://") {
        reqwest::Url::parse(repo).ok().is_some_and(|url| {
            url.host_str().is_some()
                && url.password().is_none()
                && (url.scheme() == "ssh" || url.username().is_empty())
                && url.query().is_none()
                && url.fragment().is_none()
        })
    } else {
        repo.split_once(':').is_some_and(|(host, path)| {
            host.contains('@')
                && !host.starts_with('-')
                && host
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "@._-".contains(c))
                && !path.is_empty()
        })
    };
    if !valid || repo.contains(['\n', '\r', '\0']) {
        return Err("Use an HTTPS or SSH origin without embedded passwords or tokens.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn machine_setup_spawn(
    app: tauri::AppHandle,
    id: String,
    terminal_id: String,
    action: SetupAction,
    workspace_root: Option<String>,
    rows: u16,
    cols: u16,
    target: Option<crate::remote_platform::HostTarget>,
) -> Result<(), String> {
    crate::blocking::run(move || {
        use tauri::Manager;
        let state = app.state::<crate::pty::PtyState>();
        let machine = crate::machines::get(&id).ok_or("Machine is no longer configured")?;
        crate::machines::validate_machine(&machine)?;
        let remote = if matches!(action, SetupAction::Connect) {
            // Trust/authentication must happen before any batch-mode probe.
            "echo SSH connected".to_string()
        } else if matches!(action, SetupAction::Authorize) {
            let os = target.map(|target| target.os).unwrap_or_default();
            if os == crate::remote_platform::HostOs::Windows {
                return Err("Use an existing authorized SSH key for Windows machines".into());
            }
            let home = crate::cli::home_dir_path().ok_or("Could not find your SSH directory")?;
            let key = ssh_key::local_public_key(&home.join(".ssh"))?;
            os.command(&ssh_key::authorization_script(&key)?)
        } else {
            let os = crate::machine_install::detect_target(&machine.ssh_host)?.os;
            os.command(&script(&action, &machine, workspace_root.as_deref(), os)?)
        };
        let mut command = CommandBuilder::new("ssh");
        command.args([
            "-tt",
            "-o",
            "StrictHostKeyChecking=ask",
            "-o",
            "AddKeysToAgent=yes",
            "-o",
            "ConnectTimeout=10",
            "--",
            &machine.ssh_host,
            &remote,
        ]);
        command.env("TERM", "xterm-256color");
        crate::pty::spawn_machine_setup(app.clone(), &state, terminal_id, command, rows, cols)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn openrouter_setup_does_not_start_a_claude_account_login() {
        let machine = crate::machines::Machine { id: "api".into(), label: None, ssh_host: "dev@machine".into(), checkouts: Default::default(), inference: Some(Default::default()) };
        assert!(script(&SetupAction::SignIn, &machine, None, crate::remote_platform::HostOs::Linux).unwrap_err().contains("sign-in is not required"));
    }

    #[test]
    fn personal_github_login_is_never_started_on_a_shared_remote_account() {
        let machine = crate::machines::Machine { id: "mini".into(), label: None, ssh_host: "dev@machine".into(), checkouts: Default::default(), inference: None };
        for os in [crate::remote_platform::HostOs::Macos, crate::remote_platform::HostOs::Linux, crate::remote_platform::HostOs::Windows] {
            assert!(script(&SetupAction::GitHub, &machine, None, os).unwrap_err().contains("repository-only"));
        }
    }
    #[cfg(unix)]
    #[test]
    fn closing_setup_terminates_its_process_without_closing_other_sessions() {
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .unwrap();
        track(
            "test-setup-cancel",
            portable_pty::ChildKiller::clone_killer(&child),
        );
        cancel("unrelated-session").unwrap();
        assert!(child.try_wait().unwrap().is_none());
        cancel("test-setup-cancel").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while child.try_wait().unwrap().is_none() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let exited = child.try_wait().unwrap().is_some();
        if !exited {
            let _ = child.kill();
        }
        let _ = child.wait();
        assert!(
            exited,
            "setup SSH process must terminate when its terminal closes"
        );
        cancel("test-setup-cancel").unwrap(); // idempotent cleanup
    }

    #[test]
    fn setup_commands_use_the_native_windows_shell_and_remote_login() {
        let machine = crate::machines::Machine {
            id: "mini".into(),
            label: None,
            ssh_host: "dev@machine".into(),
            checkouts: Default::default(), inference: None,
        };
        let login = script(
            &SetupAction::SignIn,
            &machine,
            None,
            crate::remote_platform::HostOs::Windows,
        )
        .unwrap();
        assert!(login.contains("& claude auth login; exit $LASTEXITCODE"));
        assert!(!login.contains("export PATH"));
        let install = script(
            &SetupAction::Prepare,
            &machine,
            None,
            crate::remote_platform::HostOs::Windows,
        )
        .unwrap();
        assert!(install.contains("https://claude.ai/install.ps1"));
        assert!(install.contains("Git.Git"));
        let mac = script(
            &SetupAction::Prepare,
            &machine,
            None,
            crate::remote_platform::HostOs::Macos,
        )
        .unwrap();
        assert!(mac.contains("Darwin)"));
        assert!(!mac.contains("requires x86_64 Linux"));
    }

    #[test]
    fn cloning_rejects_credentials_and_executable_transports() {
        for url in [
            "https://user:secret@github.com/a/b",
            "ext::sh evil",
            "/tmp/repo",
            "file:///tmp/repo",
            "https://github.com/a?token=x",
            "ssh://user:secret@github.com/a/b",
            "git@host -oProxyCommand=evil:repo",
            "git@github.com:repo\nexit",
        ] {
            assert!(safe_origin(url).is_err(), "{url}");
        }
        for url in [
            "https://github.com/a/b.git",
            "git@github.com:a/b.git",
            "ssh://git@github.com/a/b.git",
            "ssh://git@example.com:2222/a/b.git",
        ] {
            assert!(safe_origin(url).is_ok(), "{url}");
        }
    }
}
