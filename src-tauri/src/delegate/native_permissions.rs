//! Native CLI permission choices. The UI reads the same catalog; no global
//! agent configuration is changed. Apply before configuring child stdio.
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::OnceLock;
use tokio::process::Command;

#[derive(Deserialize)]
struct Mode {
    id: String,
}

fn catalog() -> &'static HashMap<String, Vec<Mode>> {
    static CATALOG: OnceLock<HashMap<String, Vec<Mode>>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../src/agent/nativePermissionModes.json"
        ))
        .expect("native permission catalog")
    })
}

pub(crate) fn validate(provider: &str, mode: Option<&str>) -> Result<(), String> {
    let Some(mode) = mode else {
        return Ok(());
    };
    if catalog()
        .get(provider)
        .is_some_and(|modes| modes.iter().any(|m| m.id == mode))
    {
        Ok(())
    } else {
        Err(format!(
            "Unsupported native permission mode {mode:?} for {provider}."
        ))
    }
}

fn remove_option(args: &mut Vec<String>, flag: &str) {
    let mut i = 0;
    while i < args.len() {
        if args[i] == flag {
            args.remove(i);
            if i < args.len() {
                args.remove(i);
            }
        } else {
            i += 1;
        }
    }
}

fn arguments(provider: &str, mode: &str, mut args: Vec<String>) -> Vec<String> {
    match provider {
        "claude-code" => {
            remove_option(&mut args, "--permission-mode");
            args.extend(["--permission-mode".into(), mode.into()]);
        }
        "codex" => {
            remove_option(&mut args, "-s");
            // Both cold and resumed exec turns take config overrides. Remove
            // the adapter's resume override before supplying the chosen one.
            let mut i = 0;
            while i + 1 < args.len() {
                if args[i] == "-c" && args[i + 1].starts_with("sandbox_mode=") {
                    args.drain(i..i + 2);
                } else {
                    i += 1;
                }
            }
            let (sandbox, policy, reviewer) = match mode {
                "read-only" => ("read-only", "never", "user"),
                "full-access" => ("danger-full-access", "never", "user"),
                "auto-review" => ("workspace-write", "on-request", "auto_review"),
                _ => ("workspace-write", "on-request", "user"),
            };
            for setting in [
                format!("sandbox_mode=\"{sandbox}\""),
                format!("approval_policy=\"{policy}\""),
                format!("approvals_reviewer=\"{reviewer}\""),
            ] {
                args.extend(["-c".into(), setting]);
            }
        }
        "omp" => {
            args.retain(|a| a != "--auto-approve");
            args.push(format!("--approval-mode={mode}"));
        }
        "cursor" if mode == "force" => args.push("--force".into()),
        "factory" if mode == "unsafe" => args.push("--skip-permissions-unsafe".into()),
        "factory" if mode != "read-only" => args.extend(["--auto".into(), mode.into()]),
        "copilot" => match mode {
            "assisted" => args.push("--assisted-approval".into()),
            "all-tools" => args.push("--allow-all-tools".into()),
            "all" => args.push("--allow-all".into()),
            _ => {}
        },
        "vibe" => args.extend(["--agent".into(), mode.into()]),
        _ => {}
    }
    args
}

/// Preserve the adapter's executable, working directory and environment,
/// including explicit environment removals (e.g. Vibe's Python isolation).
/// Child I/O, cancellation and process lifetime are installed by the runner
/// after this function, so they remain under its ownership.
pub(super) fn configure(
    command: Command,
    provider: &str,
    mode: Option<&str>,
) -> Result<Command, String> {
    validate(provider, mode)?;
    let Some(mode) = mode else {
        return Ok(command);
    };
    let template = command.as_std();
    let mut configured = Command::new(template.get_program());
    if let Some(cwd) = template.get_current_dir() {
        configured.current_dir(cwd);
    }
    for (key, value) in template.get_envs() {
        match value {
            Some(value) => {
                configured.env(key, value);
            }
            None => {
                configured.env_remove(key);
            }
        }
    }
    configured.args(arguments(
        provider,
        mode,
        template
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect(),
    ));
    if provider == "hermes" {
        // Explicitly selecting configured mode clears an inherited YOLO flag.
        if mode == "yolo" {
            configured.env("HERMES_YOLO_MODE", "1");
        } else {
            configured.env_remove("HERMES_YOLO_MODE");
        }
    }
    Ok(configured)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_covers_every_builtin_and_rejects_cross_agent_modes() {
        for adapter in super::super::catalog() {
            assert!(catalog().contains_key(adapter.id), "{}", adapter.id);
        }
        assert!(validate("codex", Some("bypassPermissions")).is_err());
        assert!(validate("openai", Some("full-access")).is_err());
    }
    #[test]
    fn codex_resume_replaces_the_sandbox_and_preserves_resume_and_effort() {
        let args = arguments(
            "codex",
            "auto-review",
            vec![
                "exec",
                "resume",
                "session",
                "-c",
                "sandbox_mode=\"workspace-write\"",
                "-c",
                "model_reasoning_effort=high",
                "--json",
                "-",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
        );
        assert_eq!(
            args.iter()
                .filter(|a| a.starts_with("sandbox_mode="))
                .count(),
            1
        );
        assert!(args.contains(&"approvals_reviewer=\"auto_review\"".into()));
        assert!(args.contains(&"model_reasoning_effort=high".into()));
        assert_eq!(&args[..3], ["exec", "resume", "session"]);
    }
    #[test]
    fn restrictive_choices_remove_existing_auto_approval_flags() {
        let args = arguments(
            "omp",
            "always-ask",
            vec!["-p".into(), "--auto-approve".into()],
        );
        assert!(!args.contains(&"--auto-approve".into()));
        assert!(args.contains(&"--approval-mode=always-ask".into()));
        let args = arguments(
            "claude-code",
            "auto",
            vec![
                "-p",
                "--permission-mode",
                "acceptEdits",
                "--resume",
                "session",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
        );
        assert!(!args.contains(&"acceptEdits".into()));
        assert_eq!(
            args.iter()
                .filter(|a| a.as_str() == "--permission-mode")
                .count(),
            1
        );
    }
    #[test]
    fn permission_choices_reach_each_agents_native_switches() {
        for (provider, mode, expected) in [
            ("cursor", "force", "--force"),
            ("factory", "high", "high"),
            ("factory", "unsafe", "--skip-permissions-unsafe"),
            ("copilot", "assisted", "--assisted-approval"),
            ("copilot", "all-tools", "--allow-all-tools"),
            ("copilot", "all", "--allow-all"),
            ("vibe", "smart-approve", "smart-approve"),
        ] {
            assert!(validate(provider, Some(mode)).is_ok());
            assert!(
                arguments(provider, mode, vec![])
                    .iter()
                    .any(|arg| arg == expected),
                "{provider}/{mode}"
            );
        }
        let mut command = Command::new("hermes");
        command.arg("acp");
        let command = configure(command, "hermes", Some("yolo")).unwrap();
        assert!(command
            .as_std()
            .get_envs()
            .any(|(k, v)| k == "HERMES_YOLO_MODE" && v == Some(std::ffi::OsStr::new("1"))));
        let command = configure(command, "hermes", Some("configured")).unwrap();
        assert!(command
            .as_std()
            .get_envs()
            .any(|(k, v)| k == "HERMES_YOLO_MODE" && v.is_none()));
    }
    #[test]
    fn configuration_preserves_env_removals_and_does_not_change_the_parent() {
        let mut command = Command::new("vibe");
        command
            .current_dir("/tmp")
            .arg("-p")
            .env_remove("PYTHONHOME")
            .env("KLIDE_TEST", "value");
        let command = configure(command, "vibe", Some("smart-approve")).unwrap();
        assert_eq!(
            command.as_std().get_current_dir(),
            Some(std::path::Path::new("/tmp"))
        );
        assert!(command
            .as_std()
            .get_envs()
            .any(|(k, v)| k == "PYTHONHOME" && v.is_none()));
        assert!(command
            .as_std()
            .get_envs()
            .any(|(k, v)| k == "KLIDE_TEST" && v == Some(std::ffi::OsStr::new("value"))));
    }
}
