use super::chat_stream::StreamItem;
use super::runs::{
    bounded_tool_input, bounded_tool_result, cap_messages, clean_title, mtime_ms, project_name,
    tool_file_path, transcript_status, AgentRun, RunMessage, RunToolCall, TranscriptState,
};
use super::{shell_quote, ChatSpec, Delegate, Env, McpServerSpec, McpWiring, RunCandidate, RunParser};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// GitHub Copilot CLI (`copilot`, npm `@github/copilot`) — runs on the
/// user's Copilot plan, logged in with `copilot login` or a GitHub token in
/// the environment. Its TUI takes a first prompt with `-i`; a headless turn
/// reads the prompt from stdin and, with `--output-format json`, reports
/// itself as one event per line (`assistant.message_delta`,
/// `tool.execution_start` / `_complete`, a closing `result` carrying the
/// session id `--resume` continues). Sessions live under
/// `$COPILOT_HOME/session-state/<id>/events.jsonl`, written in the same
/// event vocabulary as the stream, which is what Mission Control reads.
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
    fn discover_runs(&self, env: &dyn Env) -> Vec<RunCandidate> {
        let Some(root) = self.sessions_dir(env) else { return Vec::new() };
        let Ok(sessions) = std::fs::read_dir(root) else { return Vec::new() };
        sessions
            .flatten()
            .map(|entry| entry.path().join("events.jsonl"))
            .filter(|events| events.is_file())
            .map(|events| RunCandidate { mtime_ms: mtime_ms(&events), key: events.to_string_lossy().into() })
            .collect()
    }
    fn run_parser(&self, _env: &dyn Env) -> Box<dyn RunParser> {
        struct Sessions;
        impl RunParser for Sessions {
            fn parse(&self, key: &str) -> Option<AgentRun> {
                parse_run(std::path::Path::new(key))
            }
        }
        Box::new(Sessions)
    }
    fn read_run(&self, _env: &dyn Env, key: &str) -> Result<Vec<RunMessage>, String> {
        let content = std::fs::read_to_string(key).map_err(|e| e.to_string())?;
        let mut messages: Vec<RunMessage> = Vec::new();
        // A result lands lines after its call; remember where each call went.
        let mut calls: HashMap<String, (usize, usize)> = HashMap::new();
        for value in events(&content) {
            let data = &value["data"];
            match value["type"].as_str() {
                Some("user.message") => {
                    if let Some(text) = data["content"].as_str().and_then(user_text) {
                        messages.push(RunMessage { role: "user".into(), text, tools: vec![], images: vec![] });
                    }
                }
                Some("assistant.message") => {
                    let text = data["content"].as_str().unwrap_or("").trim().to_string();
                    let tools: Vec<RunToolCall> = data["toolRequests"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|call| RunToolCall {
                            name: tool_name(call["name"].as_str().unwrap_or("tool")).into(),
                            id: call["toolCallId"].as_str().map(str::to_string),
                            input: call.get("arguments").map(bounded_tool_input),
                            summary: call["intentionSummary"].as_str().map(clean_title),
                            ..Default::default()
                        })
                        .collect();
                    if text.is_empty() && tools.is_empty() {
                        continue;
                    }
                    for (i, tool) in tools.iter().enumerate() {
                        if let Some(id) = &tool.id {
                            calls.insert(id.clone(), (messages.len(), i));
                        }
                    }
                    messages.push(RunMessage { role: "assistant".into(), text, tools, images: vec![] });
                }
                Some("tool.execution_complete") => {
                    let Some(&(m, t)) = data["toolCallId"].as_str().and_then(|id| calls.get(id)) else { continue };
                    let tool = &mut messages[m].tools[t];
                    tool.ok = data["success"].as_bool();
                    tool.result = Some(bounded_tool_result(&tool_result_text(data)));
                }
                _ => {}
            }
        }
        cap_messages(&mut messages);
        Ok(messages)
    }
}

/// Every parseable line of a session log. A torn last line (a live session)
/// is skipped, like any reader of an append-only log.
fn events(content: &str) -> impl Iterator<Item = Value> + '_ {
    content.lines().filter_map(|line| serde_json::from_str(line).ok())
}

/// Copilot's file tools under the names the shared file-touch heuristic knows.
fn tool_name(name: &str) -> &str {
    match name {
        "view" => "read",
        "create" => "create_file",
        other => other,
    }
}

/// What the person typed. A turn Klide sent headless opens with its own
/// preamble and the folded conversation; the newest `[user]` block is the
/// request. A context wrapper (`<…>`) is not a message.
fn user_text(content: &str) -> Option<String> {
    let content = match content.strip_prefix(KLIDE_PREAMBLE) {
        Some(rest) => rest.rsplit("[user]\n").next().unwrap_or(rest),
        None => content,
    };
    let text = content.trim();
    (!text.is_empty() && !text.starts_with('<')).then(|| text.to_string())
}

/// The first line of every prompt `delegate::chat` folds for a headless turn.
const KLIDE_PREAMBLE: &str = "You are running as a subscription CLI backend inside Klide.";

fn parse_run(path: &std::path::Path) -> Option<AgentRun> {
    let content = std::fs::read_to_string(path).ok()?;
    let (mut id, mut cwd, mut model, mut title, mut last_event) = (None, None, None, None, None);
    let (mut created_ms, mut count, mut subagents) = (0i64, 0u32, 0u32);
    let (mut input_tokens, mut output_tokens) = (0i64, 0i64);
    let mut files: HashSet<String> = HashSet::new();
    let mut state = TranscriptState::Unknown;
    for value in events(&content) {
        let data = &value["data"];
        match value["type"].as_str() {
            Some("session.start") => {
                id = id.or_else(|| data["sessionId"].as_str().map(str::to_string));
                cwd = cwd.or_else(|| data.pointer("/context/cwd").and_then(Value::as_str).map(str::to_string));
                created_ms = data["startTime"]
                    .as_str()
                    .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
                    .map_or(0, |t| t.timestamp_millis());
            }
            Some("user.message") => {
                count += 1;
                state = TranscriptState::Working;
                if title.is_none() {
                    title = data["content"].as_str().and_then(user_text).map(|t| clean_title(&t));
                }
            }
            Some("assistant.message") => {
                count += 1;
                // `auto` is the picker's word; the message names the model.
                model = model.or_else(|| data["model"].as_str().map(str::to_string));
                let calls = data["toolRequests"].as_array().map_or(&[][..], Vec::as_slice);
                for call in calls {
                    let name = tool_name(call["name"].as_str().unwrap_or(""));
                    if let Some(file) = tool_file_path(name, &call["arguments"]) {
                        files.insert(file);
                    }
                    subagents += u32::from(name == "task");
                }
                state = if calls.is_empty() { TranscriptState::TurnComplete } else { TranscriptState::Working };
                if let Some(text) = data["content"].as_str().filter(|t| !t.trim().is_empty()) {
                    last_event = Some(clean_title(text.trim()));
                }
            }
            // Input counts the prompt minus cache reads (re-reads of the same
            // prefix), as every other parser does; cache writes are new input.
            Some("session.usage_record") => {
                let usage = &data["usage"];
                let n = |key: &str| usage[key].as_i64().unwrap_or(0);
                input_tokens += (n("inputTokens") - n("cacheReadTokens")).max(0);
                output_tokens += n("outputTokens");
            }
            Some("session.shutdown") => state = TranscriptState::TurnComplete,
            _ => {}
        }
    }
    let updated_ms = mtime_ms(path);
    let id = id.or_else(|| path.parent()?.file_name().map(|n| n.to_string_lossy().into()))?;
    Some(AgentRun {
        status: transcript_status(updated_ms, state),
        project: cwd.as_deref().and_then(project_name),
        path: path.to_string_lossy().into(),
        source: "copilot".into(),
        title: title.unwrap_or_else(|| "Copilot session".into()),
        cost_usd: crate::pricing::list_price_cost(model.as_deref().unwrap_or(""), input_tokens, output_tokens),
        model,
        cwd,
        git_branch: None,
        worktree: None,
        created_ms: if created_ms == 0 { updated_ms } else { created_ms },
        updated_ms,
        message_count: count,
        input_tokens,
        output_tokens,
        files_touched: files.len() as u32,
        subagent_count: subagents,
        last_event,
        parent_id: None,
        id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec<'a>(resume: Option<&'a str>, mcp: Option<&'a McpWiring>, allowed: &'a [String]) -> ChatSpec<'a> {
        ChatSpec { model: "gpt-6-luna", effort: None, resume, mcp, allowed_commands: allowed }
    }

    // A session log as copilot 1.0.101 writes it, trimmed: a headless turn
    // Klide sent (preamble + folded conversation), a file read, an answer.
    const SESSION: &str = concat!(
        r#"{"type":"session.start","data":{"sessionId":"852e69ac","startTime":"2026-10-21T14:07:30.000Z","context":{"cwd":"/ws/klide"}}}"#, "\n",
        r#"{"type":"session.model_change","data":{"newModel":"auto"}}"#, "\n",
        r#"{"type":"user.message","data":{"content":"You are running as a subscription CLI backend inside Klide.\nAnswer…\n\n[system]\nmode\n\n[user]\nRead note.txt and reply with its contents only.\n\n"}}"#, "\n",
        r#"{"type":"session.usage_record","data":{"usage":{"inputTokens":16106,"outputTokens":87,"cacheReadTokens":100,"cacheWriteTokens":16000}}}"#, "\n",
        r#"{"type":"assistant.message","data":{"model":"gpt-6-luna","content":"","toolRequests":[{"toolCallId":"call_1","name":"view","arguments":{"path":"/ws/klide/note.txt"},"intentionSummary":"view the file"}]}}"#, "\n",
        r#"{"type":"tool.execution_complete","data":{"toolCallId":"call_1","success":true,"result":{"content":"copilot-smoke-ok\n"}}}"#, "\n",
        r#"{"type":"assistant.message","data":{"model":"gpt-6-luna","content":"copilot-smoke-ok","toolRequests":[]}}"#, "\n",
        r#"{"type":"session.shutdown","data":{}}"#, "\n",
        r#"{"type":"assistant.mess"#,
    );

    fn session_file(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("klide-copilot-{name}-{}", std::process::id())).join("852e69ac");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("events.jsonl"), SESSION).unwrap();
        dir.join("events.jsonl")
    }

    #[test]
    fn a_session_log_becomes_a_board_row() {
        let path = session_file("row");
        let run = parse_run(&path).unwrap();
        assert_eq!((run.id.as_str(), run.source.as_str()), ("852e69ac", "copilot"));
        assert_eq!(run.title, "Read note.txt and reply with its contents only.");
        assert_eq!(run.model.as_deref(), Some("gpt-6-luna"));
        assert_eq!(run.cwd.as_deref(), Some("/ws/klide"));
        assert_eq!(run.project.as_deref(), Some("klide"));
        assert_eq!((run.input_tokens, run.output_tokens), (16006, 87));
        assert_eq!((run.message_count, run.files_touched), (3, 1));
        assert_eq!(run.last_event.as_deref(), Some("copilot-smoke-ok"));
        assert_eq!(run.status, "done");
        assert_eq!(run.created_ms, 1_792_591_650_000);
    }

    #[test]
    fn a_session_log_reads_as_the_back_and_forth() {
        let path = session_file("read");
        let messages = Copilot.read_run(&crate::delegate::ProcessEnv, path.to_str().unwrap()).unwrap();
        assert_eq!(messages.len(), 3);
        assert_eq!((messages[0].role.as_str(), messages[0].text.as_str()), ("user", "Read note.txt and reply with its contents only."));
        let read = &messages[1].tools[0];
        assert_eq!((read.name.as_str(), read.id.as_deref(), read.ok), ("read", Some("call_1"), Some(true)));
        assert_eq!(read.result.as_deref(), Some("copilot-smoke-ok"));
        assert_eq!(messages[2].text, "copilot-smoke-ok");
    }

    #[test]
    fn discovery_finds_each_sessions_log() {
        let path = session_file("discover");
        let home = path.parent().unwrap().parent().unwrap().to_path_buf();
        let state = home.join(".copilot").join("session-state");
        std::fs::create_dir_all(state.join("empty")).unwrap();
        std::fs::rename(path.parent().unwrap(), state.join("852e69ac")).unwrap();
        let env = crate::delegate::home::test_env(&home);
        let found = Copilot.discover_runs(&env);
        assert_eq!(found.len(), 1);
        assert!(found[0].key.ends_with("session-state/852e69ac/events.jsonl"));
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
