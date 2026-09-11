//! Delegate PTY spawn-spec assembly — the pure half of `delegate_pty_spawn`.
//!
//! Everything about launching a Delegate that is computable *without* an
//! `AppHandle` lives here: which shell command to run (adapter vs custom CLI,
//! interactive vs one-shot Mission dispatch), whether the Mission linkage is
//! coherent, whether the requested cwd is usable, and the env the session
//! carries. The Tauri command shrinks to gathering inputs, building a
//! [`SpawnSpec`] through [`spawn_spec_for`], and walking the session hosts —
//! so the decisions in this file are tested as data in, data out, the same
//! way the two-host merge rules in pty.rs are.
//!
//! This module is deliberately Tauri-free. It consumes the Delegate seam
//! (`crate::delegate`) and the custom-CLI store *type* (the caller performs
//! the store lookup, so a test never touches `~/.klide`).

use crate::custom_cli::CustomCli;
use crate::delegate::{self, McpWiring};
use crate::pty_host::{DelegateMissionLink, SpawnSpec};

/// The raw inputs of one Delegate PTY spawn, exactly as the Tauri command
/// (or the Mission dispatcher) received them — plus the two values only the
/// app side can supply: the session's status-hook callback URL and the
/// user-authored custom CLI when `provider` names one.
pub struct SpawnRequest {
    /// Klide's PTY session id (`{convoId}:{provider}`).
    pub session_id: String,
    /// A Delegate id (`claude-code`, `codex`, …) or a custom-CLI id (`cli:…`).
    pub provider: String,
    /// Already validated through [`validated_cwd`].
    pub cwd: Option<String>,
    pub task: Option<String>,
    pub model: Option<String>,
    /// The reasoning effort the user picked, when the CLI publishes a set of
    /// them (Codex does). Ignored by every adapter without an `effort_arg`.
    pub effort: Option<String>,
    pub resume_session_id: Option<String>,
    /// Mission linkage — valid only as a pair (see [`spawn_spec_for`]).
    pub mission_id: Option<String>,
    pub mission_task_id: Option<String>,
    /// A bounded one-shot Mission dispatch instead of the interactive TUI.
    pub one_shot: bool,
    /// This session's private status-hook callback URL, when the hook server
    /// is up. Becomes the `KLIDE_HOOK_URL` env var — custom CLIs get it too,
    /// so a user-authored wrapper can post its own status.
    pub hook_url: Option<String>,
    /// The custom CLI for `provider`, looked up by the caller. Only consulted
    /// when no built-in Delegate adapter matches.
    pub custom_cli: Option<CustomCli>,
    /// The adapter's MCP registration for this session, already computed by
    /// the caller (it needs the app's data dir and exe path). Its files are
    /// the caller's to write; its flags and env land in the spec here.
    pub mcp: Option<McpWiring>,
}

/// The one cwd rule for a Delegate spawn: an empty root means "no cwd", and a
/// non-directory is the caller's error — a Delegate must never start in a
/// workspace that does not exist.
pub fn validated_cwd(workspace_root: Option<String>) -> Result<Option<String>, String> {
    workspace_root
        .filter(|path| !path.trim().is_empty())
        .map(|path| {
            if std::path::Path::new(&path).is_dir() {
                Ok(path)
            } else {
                Err(format!("Delegate cwd is not a directory: {path}"))
            }
        })
        .transpose()
}

/// Build the [`SpawnSpec`] both session hosts run from one [`SpawnRequest`].
///
/// Owns the decisions that used to sit inline in the Tauri command:
/// - **Command construction.** All per-CLI knowledge stays behind the
///   Delegate seam: a built-in adapter supplies the interactive
///   `spawn_command` or the bounded one-shot `mission_command`; a custom CLI
///   fills its user-authored template. A provider with neither is an error.
/// - **Mission linkage.** `mission_id` and `mission_task_id` are only valid
///   as a pair, and a durable Mission attempt requires a workspace to write
///   its settlement evidence into.
/// - **Session-id detection.** Only built-in adapters know how to spot the
///   CLI announcing its own session id, so `detect_session_id` is exactly
///   "an adapter matched" — each host resolves the detector from the same
///   registry at spawn.
pub fn spawn_spec_for(req: SpawnRequest) -> Result<SpawnSpec, String> {
    let adapter = delegate::lookup(&req.provider);
    let command = if let Some(adapter) = adapter {
        let mut command = if req.one_shot {
            adapter.mission_command(req.task.as_deref(), req.model.as_deref())?
        } else {
            adapter.spawn_command(
                req.task.as_deref(),
                req.model.as_deref(),
                req.resume_session_id.as_deref(),
                req.effort.as_deref(),
            )
        };
        // Coordination tools ride on the adapter's own MCP flag, interactive
        // and one-shot alike: a Mission attempt can publish its result too.
        if let Some(mcp) = &req.mcp {
            for arg in &mcp.args {
                command.push(' ');
                // A bare flag stays readable; anything else is quoted.
                let bare_flag = arg.starts_with('-')
                    && arg.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
                if bare_flag {
                    command.push_str(arg);
                } else {
                    command.push_str(&delegate::shell_quote(arg));
                }
            }
        }
        command
    } else if let Some(custom) = req.custom_cli.as_ref() {
        if req.one_shot {
            return Err("Custom Delegate CLIs are not yet supported for durable Missions.".into());
        }
        custom.spawn_command(
            req.task.as_deref(),
            req.model.as_deref(),
            req.resume_session_id.as_deref(),
        )
    } else {
        return Err(format!(
            "No delegate PTY command for provider: {}",
            req.provider
        ));
    };

    let mission_link = match (req.mission_id, req.mission_task_id) {
        (Some(mission_id), Some(task_id)) => {
            let workspace_root = req.cwd.clone().ok_or_else(|| {
                "A durable Delegate Mission attempt requires a workspace.".to_string()
            })?;
            Some(DelegateMissionLink {
                workspace_root,
                mission_id,
                task_id,
            })
        }
        (None, None) => None,
        _ => {
            return Err(
                "Delegate Mission linkage requires both missionId and missionTaskId.".to_string(),
            )
        }
    };

    let mut env = Vec::new();
    if let Some(url) = req.hook_url {
        env.push(("KLIDE_HOOK_URL".to_string(), url));
    }
    // Only what the CLI itself needs to find its config. The MCP server's own
    // environment rides inside that config, because an MCP client hands a
    // stdio child a filtered environment rather than the CLI's.
    if let Some(mcp) = req.mcp {
        env.extend(mcp.env);
    }

    Ok(SpawnSpec {
        session_id: req.session_id,
        provider: req.provider,
        cwd: req.cwd,
        command,
        env,
        task: req.task,
        model: req.model,
        resume_session_id: req.resume_session_id,
        mission_link,
        detect_session_id: adapter.is_some(),
    })
}

#[cfg(test)]
mod tests {
    //! The decisions `delegate_pty_spawn` used to make inline, now pinned as
    //! data in, data out. The exact command strings per adapter are already
    //! pinned in delegate/mod.rs; here the matrix is the *routing* — which
    //! construction path a request takes, and what lands in the spec.

    use super::*;

    fn request(provider: &str) -> SpawnRequest {
        SpawnRequest {
            session_id: format!("convo-1:{provider}"),
            provider: provider.to_string(),
            cwd: None,
            task: None,
            model: None,
            effort: None,
            resume_session_id: None,
            mission_id: None,
            mission_task_id: None,
            one_shot: false,
            hook_url: None,
            custom_cli: None,
            mcp: None,
        }
    }

    fn spec() -> delegate::McpServerSpec {
        delegate::McpServerSpec {
            command: "/Applications/Klide.app/Contents/MacOS/klide".to_string(),
            args: vec!["mcp".to_string(), "coordination".to_string()],
            endpoint_path: "/data/klide/coordination-endpoint.json".to_string(),
            session_id: "convo-1:x".to_string(),
            config_dir: "/tmp/klide-mcp".to_string(),
            file_stem: "convo-1-x".to_string(),
        }
    }

    // ── Coordination wiring ───────────────────────────────────────────────

    #[test]
    fn claude_gets_a_config_file_flag_and_the_server_env_inside_it() {
        let mut req = request("claude-code");
        req.task = Some("fix the bug".to_string());
        req.mcp = delegate::lookup("claude-code").unwrap().mcp_wiring(&spec());
        let files = req.mcp.as_ref().unwrap().files.clone();
        let spec = spawn_spec_for(req).unwrap();
        assert_eq!(
            spec.command,
            "claude 'fix the bug' --mcp-config '/tmp/klide-mcp/convo-1-x.claude-mcp.json'"
        );
        assert!(
            spec.env.is_empty(),
            "the server's env belongs in its own config block, not the PTY: {:?}",
            spec.env
        );
        let (path, content) = &files[0];
        assert_eq!(path, "/tmp/klide-mcp/convo-1-x.claude-mcp.json");
        let json: serde_json::Value = serde_json::from_str(content).unwrap();
        let server = &json["mcpServers"]["klide"];
        assert_eq!(server["command"], "/Applications/Klide.app/Contents/MacOS/klide");
        assert_eq!(server["args"], serde_json::json!(["mcp", "coordination"]));
        // A path and a session id, never a port: a Delegate outlives the app.
        assert_eq!(
            server["env"]["KLIDE_COORD_ENDPOINT"],
            "/data/klide/coordination-endpoint.json"
        );
        assert_eq!(server["env"]["KLIDE_COORD_SESSION"], "convo-1:x");
    }

    #[test]
    fn codex_gets_inline_toml_overrides_after_the_prompt() {
        let mut req = request("codex");
        req.resume_session_id = Some("sess-9".to_string());
        req.mcp = delegate::lookup("codex").unwrap().mcp_wiring(&spec());
        let spec = spawn_spec_for(req).unwrap();
        assert_eq!(
            spec.command,
            "codex resume 'sess-9' -c 'mcp_servers.klide.command=\"/Applications/Klide.app/Contents/MacOS/klide\"' -c 'mcp_servers.klide.args=[\"mcp\",\"coordination\"]' -c 'mcp_servers.klide.env={KLIDE_COORD_ENDPOINT=\"/data/klide/coordination-endpoint.json\",KLIDE_COORD_SESSION=\"convo-1:x\"}'"
        );
        assert!(spec.env.is_empty());
    }

    #[test]
    fn opencode_gets_an_extra_config_file_through_its_env_var() {
        let mut req = request("opencode");
        req.task = Some("fix the bug".to_string());
        req.mcp = delegate::lookup("opencode").unwrap().mcp_wiring(&spec());
        let files = req.mcp.as_ref().unwrap().files.clone();
        let spec = spawn_spec_for(req).unwrap();
        assert_eq!(spec.command, "opencode run 'fix the bug'", "no flag: OpenCode has none");
        assert_eq!(
            spec.env,
            vec![(
                "OPENCODE_CONFIG".to_string(),
                "/tmp/klide-mcp/convo-1-x.opencode.json".to_string()
            )]
        );
        let json: serde_json::Value = serde_json::from_str(&files[0].1).unwrap();
        assert_eq!(
            json["mcp"]["klide"]["command"],
            serde_json::json!(["/Applications/Klide.app/Contents/MacOS/klide", "mcp", "coordination"])
        );
        assert_eq!(json["mcp"]["klide"]["type"], "local");
    }

    #[test]
    fn omp_and_custom_clis_have_no_mcp_wiring() {
        assert!(delegate::lookup("omp").unwrap().mcp_wiring(&spec()).is_none());
        let mut req = request("cli:aider");
        req.custom_cli = Some(custom_cli());
        req.mcp = Some(McpWiring {
            args: vec!["--should-not-appear".to_string()],
            env: vec![],
            files: vec![],
        });
        let spec = spawn_spec_for(req).unwrap();
        assert!(
            !spec.command.contains("--should-not-appear"),
            "a user template is never rewritten: {}",
            spec.command
        );
    }

    fn custom_cli() -> CustomCli {
        CustomCli {
            id: "cli:aider".to_string(),
            label: "Aider".to_string(),
            command_template: "aider --model {model} --message {task}".to_string(),
            default_model: String::new(),
            models: vec![],
            login_command: None,
        }
    }

    // ── Adapter command construction ──────────────────────────────────────

    #[test]
    fn fresh_dispatch_per_delegate() {
        let expect = [
            ("claude-code", "claude --model 'm-1' 'fix the bug'"),
            ("codex", "codex -m 'm-1' 'fix the bug'"),
            ("opencode", "opencode run -m 'm-1' 'fix the bug'"),
            ("omp", "omp --model 'm-1' 'fix the bug'"),
        ];
        for (provider, command) in expect {
            let mut req = request(provider);
            req.task = Some("fix the bug".to_string());
            req.model = Some("m-1".to_string());
            let spec = spawn_spec_for(req).unwrap();
            assert_eq!(spec.command, command, "{provider}");
            assert!(
                spec.detect_session_id,
                "{provider}: adapters watch for the CLI's own session id"
            );
        }
    }

    #[test]
    fn a_reasoning_effort_reaches_only_the_cli_that_takes_one() {
        // The picker is fed by the CLI's own manifest, so the level arriving
        // here is one Codex published. It rides as a `-c` override, which
        // changes this launch without touching ~/.codex/config.toml.
        let expect = [
            (
                "codex",
                "codex -m 'gpt-6-astra' -c model_reasoning_effort='max' 'fix the bug'",
            ),
            ("claude-code", "claude --model 'gpt-6-astra' 'fix the bug'"),
            ("opencode", "opencode run -m 'gpt-6-astra' 'fix the bug'"),
            ("omp", "omp --model 'gpt-6-astra' 'fix the bug'"),
        ];
        for (provider, command) in expect {
            let mut req = request(provider);
            req.task = Some("fix the bug".to_string());
            req.model = Some("gpt-6-astra".to_string());
            req.effort = Some("max".to_string());
            assert_eq!(spawn_spec_for(req).unwrap().command, command, "{provider}");
        }
    }

    #[test]
    fn a_blank_effort_leaves_the_cli_on_its_own_default() {
        // "Auto" in the picker is the absence of a level, and a whitespace
        // value from a stale setting has to read the same way — never as an
        // empty `-c model_reasoning_effort=`, which Codex would reject.
        for effort in [None, Some(String::new()), Some("  ".to_string())] {
            let mut req = request("codex");
            req.task = Some("fix the bug".to_string());
            req.effort = effort.clone();
            assert_eq!(
                spawn_spec_for(req).unwrap().command,
                "codex 'fix the bug'",
                "{effort:?}"
            );
        }
    }

    #[test]
    fn a_mission_one_shot_carries_no_effort() {
        // Approval freezes worker kind, provider and model into the task
        // Markdown; an effort is not part of that frozen spec, so a Mission
        // attempt runs at the CLI's own configured level.
        let mut req = request("codex");
        req.task = Some("fix the bug".to_string());
        req.effort = Some("max".to_string());
        req.one_shot = true;
        let command = spawn_spec_for(req).unwrap().command;
        assert!(!command.contains("model_reasoning_effort"), "{command}");
    }

    #[test]
    fn resume_dispatch_per_delegate() {
        let expect = [
            ("claude-code", "claude --resume 'sess-9'"),
            ("codex", "codex resume 'sess-9'"),
            ("opencode", "opencode -s 'sess-9'"),
            ("omp", "omp --resume 'sess-9'"),
        ];
        for (provider, command) in expect {
            let mut req = request(provider);
            req.resume_session_id = Some("sess-9".to_string());
            assert_eq!(spawn_spec_for(req).unwrap().command, command, "{provider}");
        }
    }

    #[test]
    fn one_shot_takes_the_mission_command() {
        let expect = [
            (
                "claude-code",
                "claude -p --permission-mode acceptEdits --output-format text 'fix the bug'",
            ),
            (
                "codex",
                "codex exec -s workspace-write --skip-git-repo-check --color never 'fix the bug'",
            ),
            ("opencode", "opencode run 'fix the bug'"),
            ("omp", "omp -p --auto-approve --mode text 'fix the bug'"),
        ];
        for (provider, command) in expect {
            let mut req = request(provider);
            req.task = Some("fix the bug".to_string());
            req.one_shot = true;
            assert_eq!(spawn_spec_for(req).unwrap().command, command, "{provider}");
        }
    }

    #[test]
    fn one_shot_without_a_task_is_the_adapters_error() {
        let mut req = request("claude-code");
        req.one_shot = true;
        let err = spawn_spec_for(req).unwrap_err();
        assert!(
            err.contains("requires a task prompt"),
            "mission_command's own error surfaces: {err}"
        );
    }

    // ── Custom-CLI template path ──────────────────────────────────────────

    #[test]
    fn custom_cli_fills_its_template() {
        let mut req = request("cli:aider");
        req.task = Some("don't break".to_string());
        req.model = Some("gpt x".to_string());
        req.custom_cli = Some(custom_cli());
        let spec = spawn_spec_for(req).unwrap();
        assert_eq!(
            spec.command,
            "aider --model 'gpt x' --message 'don'\\''t break'"
        );
        assert!(
            !spec.detect_session_id,
            "no adapter — nobody knows how this CLI announces a session id"
        );
    }

    #[test]
    fn custom_cli_refuses_one_shot_mission_dispatch() {
        let mut req = request("cli:aider");
        req.task = Some("fix".to_string());
        req.one_shot = true;
        req.custom_cli = Some(custom_cli());
        assert_eq!(
            spawn_spec_for(req).unwrap_err(),
            "Custom Delegate CLIs are not yet supported for durable Missions."
        );
    }

    #[test]
    fn unknown_provider_is_an_error() {
        assert_eq!(
            spawn_spec_for(request("gemini-cli")).unwrap_err(),
            "No delegate PTY command for provider: gemini-cli"
        );
    }

    // ── Mission linkage ───────────────────────────────────────────────────

    #[test]
    fn mission_link_requires_the_full_pair() {
        for (mission_id, task_id) in [(Some("m-1"), None), (None, Some("t-1"))] {
            let mut req = request("codex");
            req.mission_id = mission_id.map(str::to_string);
            req.mission_task_id = task_id.map(str::to_string);
            assert_eq!(
                spawn_spec_for(req).unwrap_err(),
                "Delegate Mission linkage requires both missionId and missionTaskId."
            );
        }
    }

    #[test]
    fn mission_link_requires_a_workspace() {
        let mut req = request("codex");
        req.mission_id = Some("m-1".to_string());
        req.mission_task_id = Some("t-1".to_string());
        assert_eq!(
            spawn_spec_for(req).unwrap_err(),
            "A durable Delegate Mission attempt requires a workspace."
        );
    }

    #[test]
    fn mission_link_lands_in_the_spec() {
        let mut req = request("codex");
        req.cwd = Some("/tmp/ws".to_string());
        req.mission_id = Some("m-1".to_string());
        req.mission_task_id = Some("t-1".to_string());
        let spec = spawn_spec_for(req).unwrap();
        assert_eq!(
            spec.mission_link,
            Some(DelegateMissionLink {
                workspace_root: "/tmp/ws".to_string(),
                mission_id: "m-1".to_string(),
                task_id: "t-1".to_string(),
            })
        );
        // No linkage requested → none recorded.
        let spec = spawn_spec_for(request("codex")).unwrap();
        assert_eq!(spec.mission_link, None);
    }

    // ── Env assembly ──────────────────────────────────────────────────────

    #[test]
    fn hook_url_becomes_the_klide_hook_url_env() {
        let mut req = request("claude-code");
        req.hook_url = Some("http://127.0.0.1:9/hook/tok/convo-1".to_string());
        let spec = spawn_spec_for(req).unwrap();
        assert_eq!(
            spec.env,
            vec![(
                "KLIDE_HOOK_URL".to_string(),
                "http://127.0.0.1:9/hook/tok/convo-1".to_string()
            )]
        );
        // No hook server → no env at all (the CLI sees the var as absent,
        // never as empty).
        assert!(spawn_spec_for(request("claude-code")).unwrap().env.is_empty());
    }

    // ── cwd validation ────────────────────────────────────────────────────

    #[test]
    fn cwd_rule_treats_blank_as_absent_and_rejects_non_directories() {
        assert_eq!(validated_cwd(None), Ok(None));
        assert_eq!(validated_cwd(Some("  ".to_string())), Ok(None));
        let dir = std::env::temp_dir().to_string_lossy().to_string();
        assert_eq!(validated_cwd(Some(dir.clone())), Ok(Some(dir)));
        let missing = "/definitely/not/a/dir/klide-pty-spawn-test";
        assert_eq!(
            validated_cwd(Some(missing.to_string())),
            Err(format!("Delegate cwd is not a directory: {missing}"))
        );
    }
}
