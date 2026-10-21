use super::chat_stream::StreamItem;
use super::{shell_quote, AgentRun, ChatSpec, Delegate, Env, McpServerSpec, McpWiring, RunCandidate, RunMessage, RunParser};
use serde_json::Value;

/// GitHub Copilot CLI (`copilot`, npm `@github/copilot`) — runs on the
/// user's Copilot plan, logged in with `copilot login` or a GitHub token in
/// the environment. Its TUI takes a first prompt with `-i`; a headless turn
/// reads the prompt from stdin and, with `--output-format json`, reports
/// itself as one event per line (`assistant.message_delta`,
/// `tool.execution_start` / `_complete`, a closing `result` carrying the
/// session id `--resume` continues). Sessions live under
/// `$COPILOT_HOME/session-state`; importing them into Mission Control is not
/// done yet.
pub struct Copilot;

/// The tool name the session-only MCP config registers Klide under, and the
/// `--allow-tool` pattern that lets every one of its tools run headless.
const MCP_SERVER: &str = "klide";

/// Klide's approved commands as Copilot `--allow-tool` patterns. An exact
/// command stays exact (`shell(git status)`); a trailing ` *` becomes
/// Copilot's stem prefix (`shell(npm run:*)`). Any other wildcard has no
/// Copilot spelling, so it is dropped — narrower than what Klide approved,
/// never wider — and so is a `)` that would close the pattern early.
fn allowed_tool_args(commands: &[String], klide_mcp: bool) -> Vec<String> {
    let mut patterns: Vec<String> = commands
        .iter()
        .map(|c| c.trim())
        .filter(|c| !c.is_empty() && !c.contains(')'))
        .filter_map(|c| match c.strip_suffix(" *") {
            Some(stem) if !stem.contains(['*', '?']) && !stem.trim().is_empty() => {
                Some(format!("shell({}:*)", stem.trim()))
            }
            _ if !c.contains(['*', '?']) => Some(format!("shell({c})")),
            _ => None,
        })
        .collect();
    if klide_mcp {
        patterns.push(MCP_SERVER.into());
    }
    patterns.into_iter().flat_map(|p| ["--allow-tool".to_string(), p]).collect()
}

/// A tool result is `{content}` on success and `{message}` (or `error`) on
/// failure; the row shows whichever text is there.
fn tool_result_text(data: &Value) -> String {
    data.pointer("/result/content")
        .or_else(|| data.pointer("/error/message"))
        .or_else(|| data.get("error"))
        .map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string()))
        .unwrap_or_default()
}

impl Delegate for Copilot {
    fn id(&self) -> &'static str {
        "copilot"
    }
    fn binary(&self) -> &'static str {
        "copilot"
    }
    fn label(&self) -> &'static str {
        "Copilot"
    }
    fn config_home(&self, env: &dyn Env) -> Option<std::path::PathBuf> {
        super::home::overridable(env, "COPILOT_HOME", ".copilot")
    }
    fn sessions_dir(&self, env: &dyn Env) -> Option<std::path::PathBuf> {
        self.config_home(env).map(|home| home.join("session-state"))
    }
    fn model_arg(&self, model: &str) -> String {
        format!(" --model {}", shell_quote(model))
    }
    fn resume_arg(&self, session: &str) -> String {
        format!(" --resume {}", shell_quote(session))
    }
    /// The TUI's first message rides `-i`; a bare positional is not a prompt.
    fn spawn_command(
        &self,
        task: Option<&str>,
        model: Option<&str>,
        resume: Option<&str>,
        _effort: Option<&str>,
    ) -> String {
        let resume = resume
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|id| self.resume_arg(id))
            .unwrap_or_default();
        let model = self.mission_model_arg(model);
        let task = task
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(|t| format!(" -i {}", shell_quote(t)))
            .unwrap_or_default();
        format!("copilot{resume}{model}{task}")
    }
    fn mission_command(&self, task: Option<&str>, model: Option<&str>) -> Result<String, String> {
        let task = shell_quote(self.mission_task(task)?);
        let model = self.mission_model_arg(model);
        Ok(format!("copilot -s --no-ask-user --allow-tool write{model} -p {task}"))
    }
    /// `--additional-mcp-config @file` augments `~/.copilot/mcp-config.json`
    /// for this session only; the user's own servers stay as they are.
    fn mcp_wiring(&self, spec: &McpServerSpec) -> Option<McpWiring> {
        let path = format!("{}/{}.copilot-mcp.json", spec.config_dir, spec.file_stem);
        let content = serde_json::json!({ "mcpServers": { MCP_SERVER: {
            "type": "local", "command": spec.command, "args": spec.args,
            "env": spec.env_json(), "tools": ["*"],
        }}});
        Some(McpWiring {
            args: vec!["--additional-mcp-config".into(), format!("@{path}")],
            files: vec![(path, content.to_string())],
            ..Default::default()
        })
    }
    /// Headless, prompt on stdin. Edits are allowed without a prompt nobody is
    /// there to answer (Claude Code's `acceptEdits`); shell commands stay
    /// denied unless the project approved them.
    fn chat_args(&self, _cwd: &str, model: &str) -> Result<Vec<String>, String> {
        let mut args: Vec<String> = ["-s", "--no-ask-user", "--allow-tool", "write"]
            .into_iter()
            .map(str::to_string)
            .collect();
        if !model.trim().is_empty() && !model.eq_ignore_ascii_case(super::CLI_DEFAULT_MODEL) {
            args.extend(["--model".into(), model.trim().into()]);
        }
        Ok(args)
    }
    fn chat_stream_args(&self, cwd: &str, spec: &ChatSpec) -> Option<Vec<String>> {
        let mut args = self.chat_args(cwd, spec.model).ok()?;
        // `-s` would drop the stats line from prose output; the JSON stream
        // has none, and keeping it would be one flag that does nothing.
        args.retain(|a| a != "-s");
        args.extend(["--output-format".into(), "json".into()]);
        if let Some(session) = spec.resume.map(str::trim).filter(|s| !s.is_empty()) {
            args.extend(["--resume".into(), session.into()]);
        }
        args.extend(allowed_tool_args(spec.allowed_commands, spec.mcp.is_some()));
        Some(args)
    }
    /// `--resume <id>` continues the named session, so the runner may send just
    /// the newest message.
    fn resumes_sessions(&self) -> bool {
        true
    }
    /// Copilot's dialect: `assistant.message_delta` streams the answer and
    /// `assistant.message` repeats it whole (dropped once deltas were seen);
    /// `assistant.reasoning` is the finished thought, `tool.execution_*` the
    /// call and its result, `session.usage_checkpoint` the last call's tokens,
    /// and `result` closes the turn with the session id. Ephemeral events
    /// (MCP status, deltas of reasoning) are otherwise ignored.
    fn parse_stream_line(&self, line: &str) -> Vec<StreamItem> {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            return Vec::new();
        };
        let data = &value["data"];
        let text = |key: &str| data.get(key).and_then(Value::as_str).filter(|s| !s.is_empty());
        match value.get("type").and_then(Value::as_str) {
            Some("assistant.message_delta") => text("deltaContent")
                .map(|t| vec![StreamItem::TextDelta(t.into())])
                .unwrap_or_default(),
            Some("assistant.message") => text("content")
                .map(|t| vec![StreamItem::Text(t.into())])
                .unwrap_or_default(),
            Some("assistant.reasoning") => match (text("reasoningId"), text("content")) {
                (Some(id), Some(t)) => vec![StreamItem::ThinkingPart { id: id.into(), text: t.into() }],
                _ => Vec::new(),
            },
            Some("tool.execution_start") => match text("toolCallId") {
                Some(id) => vec![StreamItem::ToolCall {
                    id: id.into(),
                    name: text("toolName").unwrap_or("tool").into(),
                    input: data.get("arguments").cloned().unwrap_or(Value::Null),
                }],
                None => Vec::new(),
            },
            Some("tool.execution_complete") => match text("toolCallId") {
                Some(id) => vec![StreamItem::ToolResult {
                    id: id.into(),
                    ok: data.get("success").and_then(Value::as_bool).unwrap_or(false),
                    content: tool_result_text(data),
                }],
                None => Vec::new(),
            },
            // Totals here are the session's, so a resumed session's would grow
            // across turns; the last call's are this turn's context.
            Some("session.usage_checkpoint") => {
                let snapshot = data.pointer("/accountingSnapshot");
                let tokens = |key: &str| snapshot.and_then(|s| s.get(key)).and_then(Value::as_u64);
                match (tokens("lastCallInputTokens"), tokens("lastCallOutputTokens")) {
                    (Some(prompt), Some(completion)) => vec![StreamItem::Usage {
                        id: "copilot-last-call".into(),
                        prompt,
                        completion,
                        cost: None,
                        context_window: None,
                    }],
                    _ => Vec::new(),
                }
            }
            Some("session.error") => vec![StreamItem::Error(
                text("message").unwrap_or("Copilot reported an error").into(),
            )],
            Some("result") => {
                let mut items = Vec::new();
                if let Some(id) = value.get("sessionId").and_then(Value::as_str) {
                    items.push(StreamItem::Session(id.into()));
                }
                match value.get("exitCode").and_then(Value::as_i64) {
                    Some(0) | None => {}
                    Some(code) => items.push(StreamItem::Error(format!("Copilot exited with code {code}"))),
                }
                items.push(StreamItem::Finished { cost_usd: None, turns: None });
                items
            }
            _ => Vec::new(),
        }
    }
    fn login_commands(&self) -> Vec<String> {
        vec!["copilot login".into()]
    }
    fn check_auth(&self, _path: &str) -> Result<(bool, String), String> {
        Ok((true, "Copilot is installed; authentication is managed by the CLI.".into()))
    }
    fn install_paths(&self, home: &str) -> Vec<String> {
        vec![format!("{home}/.local/bin/copilot")]
    }
    fn update_args(&self) -> Option<&'static [&'static str]> {
        Some(&["update"])
    }
    fn release_package(&self) -> Option<&'static str> {
        Some("@github/copilot")
    }
    fn supports_session_import(&self) -> bool {
        false
    }
    fn discover_runs(&self, _env: &dyn Env) -> Vec<RunCandidate> {
        Vec::new()
    }
    fn run_parser(&self, _env: &dyn Env) -> Box<dyn RunParser> {
        struct NoHistory;
        impl RunParser for NoHistory {
            fn parse(&self, _key: &str) -> Option<AgentRun> {
                None
            }
        }
        Box::new(NoHistory)
    }
    fn read_run(&self, _env: &dyn Env, _key: &str) -> Result<Vec<RunMessage>, String> {
        Err("Copilot session history import is not supported yet.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec<'a>(resume: Option<&'a str>, mcp: Option<&'a McpWiring>, allowed: &'a [String]) -> ChatSpec<'a> {
        ChatSpec { model: "gpt-6-luna", effort: None, resume, mcp, allowed_commands: allowed }
    }

    #[test]
    fn launches_quote_the_prompt_and_honour_the_default_model() {
        assert_eq!(
            Copilot.spawn_command(Some("hi $(x)"), Some("default"), Some("abc"), None),
            "copilot --resume 'abc' -i 'hi $(x)'"
        );
        assert_eq!(Copilot.spawn_command(None, Some("gpt-6-luna"), None, None), "copilot --model 'gpt-6-luna'");
        assert_eq!(
            Copilot.mission_command(Some("fix it"), None).unwrap(),
            "copilot -s --no-ask-user --allow-tool write -p 'fix it'"
        );
        assert!(Copilot.mission_command(None, None).is_err());
    }

    #[test]
    fn a_stream_turn_resumes_and_carries_the_projects_approvals() {
        let allowed = ["git status".to_string(), "npm run *".into(), "rm -rf *.tmp".into(), "a)b".into()];
        let wiring = McpWiring::default();
        let args = Copilot.chat_stream_args("/ws", &spec(Some("s-1"), Some(&wiring), &allowed)).unwrap();
        assert_eq!(
            args.join(" "),
            "--no-ask-user --allow-tool write --model gpt-6-luna --output-format json --resume s-1 \
             --allow-tool shell(git status) --allow-tool shell(npm run:*) --allow-tool klide"
        );
        let fresh = Copilot.chat_stream_args("/ws", &spec(None, None, &[])).unwrap();
        assert!(!fresh.contains(&"--resume".to_string()) && !fresh.contains(&"klide".to_string()));
    }

    #[test]
    fn klide_is_a_session_only_mcp_server() {
        let wiring = Copilot
            .mcp_wiring(&McpServerSpec {
                command: "/app/klide".into(),
                args: vec!["mcp".into(), "coordination".into()],
                endpoint_path: "/tmp/endpoint".into(),
                session_id: "c:copilot".into(),
                secret_path: "/tmp/secret-file".into(),
                config_dir: "/tmp/cfg".into(),
                file_stem: "c-copilot".into(),
            })
            .unwrap();
        assert_eq!(wiring.args, ["--additional-mcp-config", "@/tmp/cfg/c-copilot.copilot-mcp.json"]);
        let server = &serde_json::from_str::<Value>(&wiring.files[0].1).unwrap()["mcpServers"]["klide"];
        assert_eq!(server["command"], "/app/klide");
        assert_eq!(server["tools"][0], "*");
    }

    // Lines captured from copilot 1.0.101 (`--output-format json`), trimmed.
    #[test]
    fn reads_copilots_event_stream() {
        let parse = |line: &str| Copilot.parse_stream_line(line);
        assert_eq!(
            parse(r#"{"type":"assistant.message_delta","data":{"messageId":"m","deltaContent":"pong"},"ephemeral":true}"#),
            [StreamItem::TextDelta("pong".into())]
        );
        assert_eq!(
            parse(r#"{"type":"assistant.message","data":{"messageId":"m","content":"pong","toolRequests":[]}}"#),
            [StreamItem::Text("pong".into())]
        );
        assert!(parse(r#"{"type":"assistant.message","data":{"content":"","toolRequests":[{"name":"view"}]}}"#).is_empty());
        assert_eq!(
            parse(r#"{"type":"assistant.reasoning","data":{"reasoningId":"r1","content":"**Checking**"}}"#),
            [StreamItem::ThinkingPart { id: "r1".into(), text: "**Checking**".into() }]
        );
        assert_eq!(
            parse(r#"{"type":"tool.execution_start","data":{"toolCallId":"call_1","toolName":"view","arguments":{"path":"/ws/note.txt"}}}"#),
            [StreamItem::ToolCall { id: "call_1".into(), name: "view".into(), input: serde_json::json!({"path":"/ws/note.txt"}) }]
        );
        assert_eq!(
            parse(r#"{"type":"tool.execution_complete","data":{"toolCallId":"call_1","success":true,"result":{"content":"hello\n","detailedContent":"diff"}}}"#),
            [StreamItem::ToolResult { id: "call_1".into(), ok: true, content: "hello\n".into() }]
        );
        assert_eq!(
            parse(r#"{"type":"tool.execution_complete","data":{"toolCallId":"call_2","success":false,"error":{"message":"denied"}}}"#),
            [StreamItem::ToolResult { id: "call_2".into(), ok: false, content: "denied".into() }]
        );
        assert_eq!(
            parse(r#"{"type":"session.usage_checkpoint","data":{"accountingSnapshot":{"lastCallInputTokens":1847,"lastCallOutputTokens":5}}}"#),
            [StreamItem::Usage { id: "copilot-last-call".into(), prompt: 1847, completion: 5, cost: None, context_window: None }]
        );
        assert_eq!(
            parse(r#"{"type":"result","timestamp":"t","sessionId":"46c8602a","exitCode":0,"usage":{"premiumRequests":1}}"#),
            [StreamItem::Session("46c8602a".into()), StreamItem::Finished { cost_usd: None, turns: None }]
        );
        assert!(parse(r#"{"type":"session.mcp_server_status_changed","data":{"status":"pending"},"ephemeral":true}"#).is_empty());
        assert!(parse("Error: Model \"x\" from --model flag is not available.").is_empty());
    }
}
