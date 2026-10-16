//! CLI launch adapters. Hermes Focus turns use ACP with session-scoped MCP;
//! terminal history import remains unsupported for these adapters.
use super::{shell_quote, AgentRun, Delegate, Env, RunCandidate, RunMessage, RunParser};

pub struct CliDelegate {
    id: &'static str,
    label: &'static str,
    binary: &'static str,
}
pub static AMP: CliDelegate = CliDelegate {
    id: "amp",
    label: "Amp",
    binary: "amp",
};
pub static CURSOR: CliDelegate = CliDelegate {
    id: "cursor",
    label: "Cursor",
    binary: "cursor-agent",
};
pub static FACTORY: CliDelegate = CliDelegate {
    id: "factory",
    label: "Factory",
    binary: "droid",
};
pub static HERMES: CliDelegate = CliDelegate {
    id: "hermes",
    label: "Hermes",
    binary: "hermes",
};

struct NoHistory;
impl RunParser for NoHistory {
    fn parse(&self, _key: &str) -> Option<AgentRun> {
        None
    }
}

impl Delegate for CliDelegate {
    fn uses_acp(&self, spec: &super::ChatSpec) -> bool {
        // Hermes ACP currently has no reasoning-effort setter. Preserve the
        // existing CLI path for explicit effort rather than silently drop it.
        self.id == "hermes" && spec.effort.is_none()
            && !spec.model.starts_with(crate::harness_source::PREFIX)
    }
    fn resumes_sessions(&self) -> bool { self.id == "hermes" }
    fn mcp_wiring(&self, spec: &super::McpServerSpec) -> Option<super::McpWiring> {
        if self.id != "hermes" { return None; }
        Some(super::McpWiring {
            env: vec![(super::hermes_acp::MCP_ENV.into(), serde_json::json!([{
                "name": "klide", "command": spec.command, "args": spec.args,
                "env": spec.env_pairs().into_iter().map(|(name, value)| serde_json::json!({"name":name,"value":value})).collect::<Vec<_>>()
            }]).to_string())],
            ..Default::default()
        })
    }
    fn id(&self) -> &'static str {
        self.id
    }
    fn label(&self) -> &'static str {
        self.label
    }
    fn binary(&self) -> &'static str {
        self.binary
    }
    fn config_home(&self, env: &dyn Env) -> Option<std::path::PathBuf> {
        match self.id {
            "amp" => super::home::xdg(env, "XDG_CONFIG_HOME", ".config", "amp"),
            "hermes" => super::home::overridable(env, "HERMES_HOME", ".hermes"),
            _ => super::home_dir(env).map(|home| home.join(format!(".{}", self.id))),
        }
    }
    fn model_arg(&self, model: &str) -> String {
        // Amp routes models itself and has no model-selection flag.
        if self.id == "amp" {
            String::new()
        } else {
            let model = if self.id == "hermes" {
                crate::hermes_settings::model_value(model)
            } else {
                model.into()
            };
            format!(" --model {}", shell_quote(&model))
        }
    }
    fn resume_arg(&self, session: &str) -> String {
        format!(" --resume {}", shell_quote(session))
    }
    fn spawn_command(
        &self,
        task: Option<&str>,
        model: Option<&str>,
        resume: Option<&str>,
        effort: Option<&str>,
    ) -> String {
        let task = task.map(str::trim).filter(|s| !s.is_empty());
        let model = self.mission_model_arg(model);
        let resume = resume.map(str::trim).filter(|s| !s.is_empty());
        if self.id == "amp" {
            // Amp accepts an initial interactive message on stdin, not as a
            // positional argument. Thread continuation is a subcommand.
            let prefix = resume
                .map(|id| format!("amp threads continue {}", shell_quote(id)))
                .unwrap_or_else(|| "amp".into());
            return task
                .map(|t| format!("printf '%s\\n' {} | {prefix}", shell_quote(t)))
                .unwrap_or(prefix);
        }
        let prefix = if self.id == "hermes" {
            "hermes chat"
        } else {
            self.binary
        };
        let resume = resume.map(|id| self.resume_arg(id)).unwrap_or_default();
        let prompt = task
            .map(|t| {
                format!(
                    " {}{}",
                    if self.id == "hermes" { "--query " } else { "" },
                    shell_quote(t)
                )
            })
            .unwrap_or_default();
        let effort = if self.id == "hermes" {
            effort.filter(|level| crate::harness_source::EFFORT_LEVELS.contains(level))
                .map(|level| format!(" --reasoning {}", shell_quote(level))).unwrap_or_default()
        } else { String::new() };
        format!("{prefix}{resume}{model}{effort}{prompt}")
    }
    fn mission_command(&self, task: Option<&str>, model: Option<&str>) -> Result<String, String> {
        let task = shell_quote(self.mission_task(task)?);
        let model = self.mission_model_arg(model);
        Ok(match self.id {
            "amp" => format!("amp --execute {task}"),
            "cursor" => format!("cursor-agent --print --output-format text{model} {task}"),
            "factory" => format!("droid exec --output-format text{model} {task}"),
            _ => format!("hermes chat --quiet --oneshot{model} --query {task}"),
        })
    }
    fn chat_args(&self, _cwd: &str, model: &str) -> Result<Vec<String>, String> {
        let mut args: Vec<String> = match self.id {
            "amp" => vec!["--execute"],
            "cursor" => vec!["--print", "--output-format", "text"],
            "factory" => vec!["exec", "--output-format", "text"],
            _ => vec!["chat", "--quiet", "--oneshot", "--query-file", "-"],
        }
        .into_iter()
        .map(str::to_string)
        .collect();
        if self.id != "amp"
            && !model.trim().is_empty()
            && !model.eq_ignore_ascii_case(super::CLI_DEFAULT_MODEL)
        {
            args.extend([
                "--model".into(),
                if self.id == "hermes" {
                    crate::hermes_settings::model_value(model)
                } else {
                    model.into()
                },
            ]);
        }
        Ok(args)
    }
    fn chat_invocation(&self, cwd: &str, model: &str) -> Result<tokio::process::Command, String> {
        let cli = crate::cli::resolve_command(self.binary())?;
        let args = self.chat_args(cwd, model)?;
        // Cursor documents a positional prompt. Move stdin to that argument
        // without evaluating any prompt text as shell code.
        let mut command = if self.id == "cursor" {
            let mut c = tokio::process::Command::new("sh");
            c.args([
                "-c",
                "prompt=$(cat); exec \"$@\" \"$prompt\"",
                "klide-cursor",
            ])
            .arg(cli)
            .args(args);
            c
        } else {
            let mut c = tokio::process::Command::new(cli);
            c.args(args);
            c
        };
        if self.id == "hermes" {
            if let Some(settings) = crate::hermes_settings::selection(Some(model))? {
                command.args(settings.args(Some(model))?);
                let env = crate::hermes_settings::runtime_env(
                    &settings.provider,
                    Some(std::path::Path::new(cwd)),
                )?;
                crate::hermes_settings::check_environment_overrides(&env)?;
                command.envs(env);
            }
        }
        command.current_dir(cwd);
        Ok(command)
    }
    fn login_commands(&self) -> Vec<String> {
        vec![match self.id {
            "amp" => "amp login",
            "cursor" => "cursor-agent login",
            "factory" => "droid",
            _ => "hermes setup",
        }
        .into()]
    }
    fn check_auth(&self, _path: &str) -> Result<(bool, String), String> {
        Ok((
            true,
            format!(
                "{} is installed; authentication is managed by the CLI.",
                self.label
            ),
        ))
    }
    fn install_paths(&self, home: &str) -> Vec<String> {
        vec![format!("{home}/.local/bin/{}", self.binary)]
    }
    fn version_args(&self) -> &'static [&'static str] {
        if self.id == "amp" { &["version"] } else { &["--version"] }
    }
    fn update_args(&self) -> Option<&'static [&'static str]> { Some(&["update"]) }
    // Standalone releases are not tied to a verified npm version feed.
    // The CLI's own updater works; Klide does not claim it can compare releases.
    fn release_package(&self) -> Option<&'static str> { None }
    fn supports_session_import(&self) -> bool { false }
    fn discover_runs(&self, _env: &dyn Env) -> Vec<RunCandidate> {
        Vec::new()
    }
    fn run_parser(&self, _env: &dyn Env) -> Box<dyn RunParser> {
        Box::new(NoHistory)
    }
    fn read_run(&self, _env: &dyn Env, _key: &str) -> Result<Vec<RunMessage>, String> {
        Err(format!(
            "{} session history import is not supported yet.",
            self.label
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hermes_acp_keeps_effort_turns_on_the_compatible_transport() {
        let spec = super::super::ChatSpec { model: "", effort: None, resume: None, mcp: None, allowed_commands: &[] };
        assert!(HERMES.uses_acp(&spec));
        assert!(!AMP.uses_acp(&spec));
        assert!(!HERMES.uses_acp(&super::super::ChatSpec { effort: Some("high"), ..spec }));
        let wiring = HERMES.mcp_wiring(&super::super::McpServerSpec {
            command:"/app/klide".into(), args:vec!["mcp".into(), "coordination".into()],
            endpoint_path:"/tmp/endpoint".into(), session_id:"conversation:hermes".into(), secret_path:"/tmp/secret-file".into(),
            config_dir:"/tmp".into(), file_stem:"hermes".into(),
        }).unwrap();
        let servers: serde_json::Value = serde_json::from_str(&wiring.env[0].1).unwrap();
        assert_eq!(servers[0]["name"], "klide");
        assert_eq!(servers[0]["env"][2]["value"], "/tmp/secret-file");
        assert!(wiring.args.is_empty() && wiring.files.is_empty());
    }
    #[test]
    fn launches_use_cli_defaults_and_quote_prompts() {
        for d in [&AMP, &CURSOR, &FACTORY, &HERMES] {
            let command = d
                .mission_command(Some("don't run $(touch /tmp/nope)"), Some("default"))
                .unwrap();
            assert!(!command.contains("--model"));
            assert!(command.contains(&shell_quote("don't run $(touch /tmp/nope)")));
            assert!(d.mission_command(None, None).is_err());
        }
        assert_eq!(
            HERMES.chat_args("/tmp", "default").unwrap(),
            ["chat", "--quiet", "--oneshot", "--query-file", "-"]
        );
        assert_eq!(AMP.chat_args("/tmp", "default").unwrap(), ["--execute"]);
        assert!(HERMES
            .spawn_command(Some("hello"), None, None, None)
            .contains("--query 'hello'"));
    }
}
