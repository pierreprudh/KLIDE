//! User-session launchd registration for the headless scheduled Run host.
//! The desktop is a client. No prompts, credentials or shell snippets are
//! written into the launch agent; the service resolves this Machine's logins.
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::Manager;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServiceInfo {
    pub supported: bool,
    pub installed: bool,
    pub running: bool,
    pub compatible: bool,
    pub pid: Option<u32>,
    pub error: Option<String>,
}

pub(crate) fn label(data: &Path) -> String {
    use sha2::{Digest, Sha256};
    let hash = format!("{:x}", Sha256::digest(data.as_os_str().as_encoded_bytes()));
    format!("com.klide.scheduled.{}", &hash[..16])
}

fn agent_path(data: &Path) -> Result<PathBuf, String> {
    Ok(crate::cli::home_dir_path()
        .ok_or("Cannot locate your home directory")?
        .join("Library/LaunchAgents")
        .join(format!("{}.plist", label(data))))
}

fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

pub(crate) fn definition(data: &Path, executable: &Path, path: &str) -> String {
    let executable = xml(&executable.to_string_lossy());
    let root = xml(&data.to_string_lossy());
    let service_label = label(data);
    let path = xml(path);
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>{service_label}</string>
<key>ProgramArguments</key><array><string>{executable}</string><string>scheduled</string><string>--data-dir</string><string>{root}</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>ProcessType</key><string>Background</string>
<key>Umask</key><integer>63</integer>
<key>WorkingDirectory</key><string>{root}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>{path}</string></dict>
<key>StandardOutPath</key><string>{root}/scheduled-host/service.stdout.log</string>
<key>StandardErrorPath</key><string>{root}/scheduled-host/service.stderr.log</string>
</dict></plist>
"#
    )
}

pub(crate) fn status(data: &Path) -> ServiceInfo {
    let mut info = ServiceInfo {
        supported: cfg!(target_os = "macos"),
        installed: agent_path(data).is_ok_and(|p| p.exists()),
        running: false,
        compatible: false,
        pid: None,
        error: None,
    };
    #[cfg(target_os = "macos")]
    if info.installed {
        use std::ffi::OsStr;
        let job = format!("gui/{}/{}", unsafe { libc::geteuid() }, label(data));
        info.installed = launchctl(&[OsStr::new("print"), OsStr::new(&job)])
            .is_ok_and(|output| output.status.success());
    }
    #[cfg(unix)]
    match crate::pty_client::request(
        &data.join("scheduled-host"),
        &crate::pty_wire::Request::Ping,
    ) {
        Ok(crate::pty_wire::Response::Pong {
            version,
            protocol,
            build,
            pid,
        }) => {
            info.running = true;
            info.pid = Some(pid);
            info.compatible = version == env!("CARGO_PKG_VERSION")
                && protocol == crate::pty_wire::PROTOCOL_VERSION
                && build == crate::pty_wire::build_id();
            if !info.compatible {
                info.error = Some(
                    "The local service needs an update. Active Runs will be left running.".into(),
                );
            }
        }
        Err(error) if error.starts_with("connect:") => {}
        Err(error) => info.error = Some(error),
        _ => info.error = Some("The local service returned an unexpected response".into()),
    }
    if !info.supported {
        info.error = Some("Persistent local scheduling is currently supported on macOS".into());
    }
    info
}

#[cfg(target_os = "macos")]
fn launchctl(args: &[&std::ffi::OsStr]) -> Result<std::process::Output, String> {
    std::process::Command::new("/bin/launchctl")
        .args(args)
        .output()
        .map_err(|e| format!("Cannot run launchctl: {e}"))
}

pub(crate) fn ensure(data: &Path) -> Result<ServiceInfo, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = data;
        return Err("Persistent local scheduling is currently supported on macOS".into());
    }
    #[cfg(target_os = "macos")]
    {
        use std::ffi::OsStr;
        let _lease = crate::process_lock::exclusive(&data.join("scheduled-install.lock"))?;
        let _dispatch_lease = crate::process_lock::exclusive(&data.join("schedule-dispatch.lock"))?;
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(data.join("scheduled-host")).map_err(|e| e.to_string())?;
        let mut paths: Vec<PathBuf> = std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).collect())
            .unwrap_or_default();
        for path in [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ] {
            if !paths.iter().any(|p| p == Path::new(path)) {
                paths.push(path.into());
            }
        }
        let path = std::env::join_paths(paths).map_err(|e| e.to_string())?;
        let contents = definition(data, &executable, &path.to_string_lossy());
        let plist = agent_path(data)?;
        let same = std::fs::read_to_string(&plist).is_ok_and(|s| s == contents);
        let current = status(data);
        if same && current.installed && current.compatible {
            return Ok(current);
        }
        if current.running && !current.installed {
            return Err("A scheduler is running outside the registered local service. Stop that standalone process before enabling the service.".into());
        }
        // Upgrade only a responsive, idle host. An unreachable owner is not
        // proof that its work may be killed or replayed.
        if current.running {
            match crate::pty_client::request(
                &data.join("scheduled-host"),
                &crate::pty_wire::Request::ChatList,
            ) {
                Ok(crate::pty_wire::Response::ChatList { runs }) if runs.is_empty() => {}
                _ => {
                    return Err(
                        "The local service needs an update. Finish or stop its active Runs first."
                            .into(),
                    )
                }
            }
        } else if current.error.is_some() {
            return Err(current.error.unwrap());
        }
        std::fs::create_dir_all(plist.parent().unwrap()).map_err(|e| e.to_string())?;
        crate::durable::write_atomic_private(&plist, contents.as_bytes())?;
        let domain = format!("gui/{}", unsafe { libc::geteuid() });
        let job = format!("{domain}/{}", label(data));
        let loaded = launchctl(&[OsStr::new("print"), OsStr::new(&job)])?
            .status
            .success();
        if loaded && !current.running {
            // A loaded job may be starting, crash-throttled, or unreachable.
            // kickstart without -k never kills an existing process.
            let _ = launchctl(&[OsStr::new("kickstart"), OsStr::new(&job)]);
            for _ in 0..40 {
                let info = status(data);
                if info.compatible {
                    return Ok(info);
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            return Err("The local service is starting or unreachable. Existing work was left alone; try again.".into());
        }
        if loaded && (!same || current.running && !current.compatible) {
            let output = launchctl(&[OsStr::new("bootout"), OsStr::new(&job)])?;
            if !output.status.success() {
                return Err(format!(
                    "Cannot update the local service: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }
        }
        if !loaded || !same || current.running && !current.compatible {
            let output = launchctl(&[
                OsStr::new("bootstrap"),
                OsStr::new(&domain),
                plist.as_os_str(),
            ])?;
            if !output.status.success() {
                return Err(format!(
                    "Cannot enable the local service: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }
        } else {
            let output = launchctl(&[OsStr::new("kickstart"), OsStr::new(&job)])?;
            if !output.status.success() {
                return Err(format!(
                    "Cannot start the local service: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }
        }
        for _ in 0..40 {
            let info = status(data);
            if info.compatible {
                return Ok(info);
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        Err("The local service did not become ready. Check macOS background-item permissions and the Scheduled service log.".into())
    }
}

pub(crate) async fn ensure_for_app(app: &tauri::AppHandle) -> Result<ServiceInfo, String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::blocking::run(move || ensure(&data)).await
}

#[tauri::command]
pub(crate) async fn agent_schedule_service_status(
    app: tauri::AppHandle,
) -> Result<ServiceInfo, String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::blocking::run(move || Ok(status(&data))).await
}

#[tauri::command]
pub(crate) async fn agent_schedule_service_enable(
    app: tauri::AppHandle,
) -> Result<ServiceInfo, String> {
    ensure_for_app(&app).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn launch_agent_escapes_paths_and_uses_only_non_secret_environment() {
        let plist = definition(
            Path::new("/tmp/My <workspace> & data"),
            Path::new("/Applications/Klide.app/Contents/MacOS/klide"),
            "/usr/bin:/bin",
        );
        assert!(plist.contains("My &lt;workspace&gt; &amp; data"));
        assert!(plist.contains("<string>scheduled</string>"));
        assert!(plist.contains("<key>KeepAlive</key><true/>"));
        assert!(plist.contains("<key>RunAtLoad</key><true/>"));
        assert!(!plist.contains("API_KEY"));
        assert!(!plist.contains("/bin/sh"));
        assert_ne!(label(Path::new("/tmp/dev")), label(Path::new("/tmp/prod")));
    }
}
