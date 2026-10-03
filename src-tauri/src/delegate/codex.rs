use super::runs::{
    cap_messages, clean_title, mtime_ms, project_name, tool_file_path, transcript_status,
    TranscriptState,
};
use super::chat_stream::{result_text, StreamItem};
use super::{shell_quote, AgentRun, ChatSpec, Delegate, Env, McpServerSpec, McpWiring, RunCandidate, RunMessage, RunParser};
use serde_json::Value;
use std::collections::HashMap;
use std::collections::HashSet;

/// Codex — OpenAI's CLI. Its TUI accepts the task as the first positional
/// arg; resuming is a subcommand (`codex resume <id>`), not a flag. Sessions
/// land in `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`, with
/// human thread names in `~/.codex/session_index.jsonl`.
pub struct Codex;

impl Delegate for Codex {
    fn id(&self) -> &'static str {
        "codex"
    }

    fn binary(&self) -> &'static str {
        "codex"
    }

    fn label(&self) -> &'static str {
        "Codex"
    }

    /// `~/.codex`, or `$CODEX_HOME` when the user moved it — the same
    /// variable `ocx` and the CLI itself read.
    fn config_home(&self, env: &dyn Env) -> Option<std::path::PathBuf> {
        super::home::overridable(env, "CODEX_HOME", ".codex")
    }

    fn sessions_dir(&self, env: &dyn Env) -> Option<std::path::PathBuf> {
        self.config_home(env).map(|d| d.join("sessions"))
    }

    /// `config.toml` — the `notify` hook goes in, the gateway's
    /// `openai_base_url` comes out, connectors are read from it.
    fn config_file(&self, env: &dyn Env) -> Option<std::path::PathBuf> {
        self.config_home(env).map(|d| d.join("config.toml"))
    }

    /// One plaintext `auth.json` (`auth_mode`, `OPENAI_API_KEY`, `tokens`).
    fn auth_files(&self, env: &dyn Env) -> Vec<std::path::PathBuf> {
        self.config_home(env)
            .map(|d| vec![d.join("auth.json")])
            .unwrap_or_default()
    }

    /// The CLI's own model manifest, refreshed from OpenAI and then obeyed.
    fn models_cache(&self, env: &dyn Env) -> Option<std::path::PathBuf> {
        self.config_home(env).map(|d| d.join("models_cache.json"))
    }

    fn supports_accounts(&self) -> bool {
        true
    }

    /// Codex has no hooks, but its `notify` program covers turn ends and
    /// approvals — Klide's shim posts those (see status.rs).
    fn ensure_status_hooks(&self, env: &dyn Env) -> Result<bool, String> {
        let (Some(hooks), Some(config)) = (super::home::klide_hooks_dir(env), self.config_file(env))
        else {
            return Err("Could not resolve home directory".to_string());
        };
        super::status::install_codex_hooks(&hooks, &config)
    }

    fn model_arg(&self, model: &str) -> String {
        format!(" -m {}", shell_quote(model))
    }

    /// Codex takes per-invocation config overrides as `-c key=value` with a
    /// TOML value, so the server needs no file at all. `-c` is a global flag,
    /// valid after `resume <id>` and `exec` alike.
    fn mcp_wiring(&self, spec: &McpServerSpec) -> Option<McpWiring> {
        let toml_str = |s: &str| format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""));
        let args = spec
            .args
            .iter()
            .map(|a| toml_str(a))
            .collect::<Vec<_>>()
            .join(",");
        let env = format!(
            "{{{}}}",
            spec.env_pairs()
                .iter()
                .map(|(k, v)| format!("{k}={}", toml_str(v)))
                .collect::<Vec<_>>()
                .join(",")
        );
        let args = [
            format!("mcp_servers.klide.command={}", toml_str(&spec.command)),
            format!("mcp_servers.klide.args=[{args}]"),
            format!("mcp_servers.klide.env={env}"),
        ]
        .into_iter()
        .flat_map(|kv| ["-c".to_string(), kv])
        .collect::<Vec<_>>();
        Some(McpWiring {
            args,
            env: vec![],
            files: vec![],
        })
    }

    fn resume_arg(&self, session_id: &str) -> String {
        format!(" resume {}", shell_quote(session_id))
    }

    /// Codex has no effort flag — it reads `model_reasoning_effort` from
    /// `~/.codex/config.toml`, and `-c key=value` overrides one config key for
    /// this launch only. Klide passes the level the user picked that way, so
    /// the choice reaches the CLI without editing the user's config file.
    fn effort_arg(&self, level: &str) -> Option<String> {
        Some(format!(
            " -c model_reasoning_effort={}",
            shell_quote(level)
        ))
    }

    fn mission_command(&self, task: Option<&str>, model: Option<&str>) -> Result<String, String> {
        let task = self.mission_task(task)?;
        let model_arg = self.mission_model_arg(model);
        Ok(format!(
            "codex exec{model_arg} -s workspace-write --skip-git-repo-check --color never {}",
            shell_quote(task)
        ))
    }

    /// Headless: `exec … -` reads the prompt from stdin. `workspace-write`
    /// sandboxes edits to the workspace; the cwd rides in via `-C`.
    fn chat_args(&self, cwd: &str, model: &str) -> Result<Vec<String>, String> {
        let mut args: Vec<String> = vec!["exec".into()];
        if !model.is_empty() {
            args.extend(["-m".into(), model.into()]);
        }
        args.extend([
            "-s".into(),
            "workspace-write".into(),
            "-C".into(),
            cwd.into(),
            "--skip-git-repo-check".into(),
            "--color".into(),
            "never".into(),
            "-".into(),
        ]);
        Ok(args)
    }

    /// `--json` puts one event per line on stdout: `thread.started` names the
    /// session, every step is an `item.*` (an `agent_message`, a
    /// `command_execution`, a `file_change`, an `mcp_tool_call`, …) and
    /// `turn.completed` / `turn.failed` close it. A remembered session
    /// continues through the `resume` subcommand, which takes neither `-s` nor
    /// `-C`: the sandbox rides a `-c` override and the cwd is the child's own
    /// working directory (set by `chat_invocation`). The prompt stays on stdin
    /// (`-`) in both shapes.
    fn chat_stream_args(&self, cwd: &str, spec: &ChatSpec) -> Option<Vec<String>> {
        let mut args: Vec<String> = vec!["exec".into()];
        match spec.resume.map(str::trim).filter(|s| !s.is_empty()) {
            Some(session) => {
                args.extend(["resume".into(), session.into()]);
                if !spec.model.is_empty() {
                    args.extend(["-m".into(), spec.model.into()]);
                }
                args.extend(["-c".into(), "sandbox_mode=\"workspace-write\"".into()]);
            }
            None => {
                if !spec.model.is_empty() {
                    args.extend(["-m".into(), spec.model.into()]);
                }
                args.extend(["-s".into(), "workspace-write".into(), "-C".into(), cwd.into()]);
            }
        }
        // Same override the PTY launch uses: Codex has no effort flag of its own.
        if let Some(level) = spec.effort.map(str::trim).filter(|l| !l.is_empty()) {
            args.extend(["-c".into(), format!("model_reasoning_effort={level}")]);
        }
        args.extend(["--skip-git-repo-check".into(), "--json".into(), "-".into()]);
        Some(args)
    }

    /// `codex exec resume <thread_id> -` continues the named thread.
    fn resumes_sessions(&self) -> bool {
        true
    }

    /// Codex's dialect (`codex-rs/exec/src/exec_events.rs`): a `thread.started`
    /// line with the id to resume, then `item.started` / `item.updated` /
    /// `item.completed` wrapping one `item` whose `type` says what it is. A
    /// command, a patch or an MCP call is one item that progresses, so the call
    /// is re-emitted as it goes (the fold upserts by id) and its result exists
    /// only at `item.completed`. Text has no deltas: an `agent_message` arrives
    /// whole, reported as a part so the runner streams whatever is new.
    fn parse_stream_line(&self, line: &str) -> Vec<StreamItem> {
        let line = line.trim();
        if line.is_empty() {
            return Vec::new();
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        match value.get("type").and_then(Value::as_str) {
            Some("thread.started") => value
                .get("thread_id")
                .and_then(Value::as_str)
                .map(|id| vec![StreamItem::Session(id.to_string())])
                .unwrap_or_default(),
            // Both lines arrive for one failure, with the same message; the
            // emitter keeps the last, so nothing is said twice.
            Some("error") => vec![StreamItem::Error(codex_message(&value))],
            Some("turn.failed") => vec![StreamItem::Error(
                value.get("error").map(codex_message).unwrap_or_else(|| "Codex turn failed".to_string()),
            )],
            Some("turn.completed") => vec![StreamItem::Finished { cost_usd: None, turns: None }],
            Some(kind @ ("item.started" | "item.updated" | "item.completed")) => value
                .get("item")
                .map(|item| codex_item(item, kind == "item.completed"))
                .unwrap_or_default(),
            _ => Vec::new(),
        }
    }


    fn login_commands(&self) -> Vec<String> {
        [
            "",
            " --device-auth",
            " --with-api-key",
            " --with-access-token",
        ]
        .iter()
        .map(|tail| format!("codex login{tail}"))
        .collect()
    }

    /// `codex login status` prints plain text; "logged in" anywhere in a
    /// successful run means authenticated. stderr is the fallback channel.
    fn check_auth(&self, command_path: &str) -> Result<(bool, String), String> {
        let output = std::process::Command::new(command_path)
            .args(["login", "status"])
            .output()
            .map_err(|e| format!("Unable to check Codex login: {e}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let text = if stdout.is_empty() { stderr } else { stdout };
        let connected = output.status.success() && text.to_lowercase().contains("logged in");
        Ok((
            connected,
            if text.is_empty() {
                "Unknown".to_string()
            } else {
                text
            },
        ))
    }

    fn install_paths(&self, home: &str) -> Vec<String> {
        vec![
            format!("{home}/.local/bin/codex"),
            "/Applications/Codex.app/Contents/Resources/codex".to_string(),
        ]
    }

    fn update_args(&self) -> Option<&'static [&'static str]> {
        Some(&["update"])
    }

    fn release_package(&self) -> Option<&'static str> {
        Some("@openai/codex")
    }

    fn discover_runs(&self, env: &dyn Env) -> Vec<RunCandidate> {
        let mut files = Vec::new();
        if let Some(root) = self.sessions_dir(env) {
            collect_rollouts(&root, &mut files);
        }
        files
            .into_iter()
            .map(|p| RunCandidate {
                mtime_ms: mtime_ms(&p),
                key: p.to_string_lossy().to_string(),
            })
            .collect()
    }

    fn run_parser(&self, env: &dyn Env) -> Box<dyn RunParser> {
        Box::new(CodexRunParser {
            index: self
                .session_index(env)
                .map(|path| load_index(&path))
                .unwrap_or_default(),
        })
    }

    /// The title comes from the session index, not the rollout file, so a
    /// remembered parse must move when the index does.
    fn parse_inputs_stamp(&self, env: &dyn Env) -> u64 {
        self.session_index(env)
            .map(|path| crate::file_memo::mtime_epoch(&path))
            .unwrap_or(0)
    }

    fn read_run(&self, _env: &dyn Env, key: &str) -> Result<Vec<RunMessage>, String> {
        let content = std::fs::read_to_string(key).map_err(|e| e.to_string())?;
        let mut msgs: Vec<RunMessage> = Vec::new();
        for line in content.lines() {
            let v: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if v.get("type").and_then(|t| t.as_str()) != Some("response_item") {
                continue;
            }
            let payload = match v.get("payload") {
                Some(p) if p.get("type").and_then(|t| t.as_str()) == Some("message") => p,
                _ => continue,
            };
            let role = payload.get("role").and_then(|r| r.as_str()).unwrap_or("");
            if role != "user" && role != "assistant" {
                continue; // skip developer/system noise
            }
            if let Some(text) = message_text(payload) {
                if role == "user" && text.starts_with('<') {
                    continue; // environment / permissions context wrappers
                }
                msgs.push(RunMessage {
                    role: role.to_string(),
                    text,
                    // Codex flattens tool activity into its own text stream; no
                    // structured tool parts to surface here.
                    tools: vec![],
                    images: vec![],
                });
            }
        }
        cap_messages(&mut msgs);
        Ok(msgs)
    }
}

struct CodexRunParser {
    /// Session id → human thread name, from session_index.jsonl. Loaded once
    /// per page, not per candidate.
    index: HashMap<String, String>,
}

impl RunParser for CodexRunParser {
    fn parse(&self, key: &str) -> Option<AgentRun> {
        parse_run(std::path::Path::new(key), &self.index)
    }
}

fn parse_run(path: &std::path::Path, index: &HashMap<String, String>) -> Option<AgentRun> {
    use std::io::BufRead;
    // Codex rollout files can be hundreds of MB — tool outputs are written
    // inline, one giant JSON object per line. Building a serde_json::Value tree
    // for every line is what made the Stats panel freeze the machine on large
    // histories. Stream the file and skip JSON-parsing oversized lines: those
    // are always tool-output `response_item` records, which we only need to
    // count, never inspect. The metadata and token-usage lines we do read are
    // always small.
    const MAX_PARSE_LINE: usize = 32 * 1024;
    let file = std::fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);
    let (mut id, mut cwd, mut branch, mut model) = (None, None, None, None);
    let mut count: u32 = 0;
    let (mut input_tokens, mut output_tokens): (i64, i64) = (0, 0);
    let mut files: HashSet<String> = HashSet::new();
    let mut last_event: Option<String> = None;
    let mut transcript_state = TranscriptState::Unknown;
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.len() > MAX_PARSE_LINE {
            // Codex Desktop can put a full base-instructions blob on the
            // opening session_meta line. That line still carries cwd/id/branch,
            // so parse it; keep skipping oversized response_item tool output.
            if is_session_meta_line(&line) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                    capture_session_meta(v.get("payload"), &mut id, &mut cwd, &mut branch);
                }
            } else {
                count += 1; // oversized line = a tool-output response_item
            }
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let payload = v.get("payload");
        match v.get("type").and_then(|t| t.as_str()) {
            Some("session_meta") => {
                capture_session_meta(payload, &mut id, &mut cwd, &mut branch);
            }
            Some("turn_context") if model.is_none() => {
                if let Some(m) = payload
                    .and_then(|p| p.get("model"))
                    .and_then(|m| m.as_str())
                {
                    if !m.is_empty() {
                        model = Some(m.to_string());
                    }
                }
            }
            Some("response_item") => {
                count += 1;
                // function_call response_items carry the tool name and a
                // stringified JSON `arguments` blob. Parse it the same way
                // the message-detail reader does and feed it through the
                // shared tool_file_path helper so the three adapters agree
                // on what counts as a "file the agent touched".
                if let Some(p) = payload {
                    let item_type = p.get("type").and_then(|t| t.as_str());
                    if item_type == Some("function_call") {
                        transcript_state = TranscriptState::Working;
                        let name = p.get("name").and_then(|n| n.as_str()).unwrap_or("");
                        if let Some(args_str) = p.get("arguments").and_then(|a| a.as_str()) {
                            if let Ok(args) = serde_json::from_str::<serde_json::Value>(args_str) {
                                if let Some(path) = tool_file_path(name, &args) {
                                    files.insert(path);
                                }
                            }
                        }
                    }
                    // Track the newest assistant message as the run's last event.
                    if item_type == Some("function_call_output") {
                        transcript_state = TranscriptState::Working;
                    }
                    if item_type == Some("message") {
                        match p.get("role").and_then(|r| r.as_str()) {
                            Some("user") => transcript_state = TranscriptState::Working,
                            Some("assistant") => {
                                transcript_state = TranscriptState::TurnComplete;
                                if let Some(t) = message_text(p) {
                                    last_event = Some(clean_title(&t));
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
            Some("event_msg") => {
                match payload.and_then(|p| p.get("type")).and_then(|t| t.as_str()) {
                    Some("task_started") | Some("user_message") => {
                        transcript_state = TranscriptState::Working;
                    }
                    Some("task_complete") | Some("turn_aborted") => {
                        transcript_state = TranscriptState::TurnComplete;
                    }
                    _ => {}
                }
                // `token_count` events carry a *cumulative* total for the
                // session — keep overwriting so the last one wins. Cached
                // input is subtracted to mirror the Claude parser.
                if let Some(total) = payload
                    .filter(|p| p.get("type").and_then(|t| t.as_str()) == Some("token_count"))
                    .and_then(|p| p.get("info"))
                    .and_then(|i| i.get("total_token_usage"))
                {
                    let n = |key: &str| total.get(key).and_then(|x| x.as_i64()).unwrap_or(0);
                    input_tokens = (n("input_tokens") - n("cached_input_tokens")).max(0);
                    output_tokens = n("output_tokens");
                }
            }
            _ => {}
        }
    }
    let id = id.unwrap_or_else(|| {
        path.file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default()
    });
    let updated_ms = mtime_ms(path);
    // Cost is computed from the same model + token totals we just summed; the
    // model is moved into AgentRun below, so capture the cost before then.
    let cost_usd =
        crate::pricing::list_price_cost(model.as_deref().unwrap_or(""), input_tokens, output_tokens);
    Some(AgentRun {
        status: transcript_status(updated_ms, transcript_state),
        title: index
            .get(&id)
            .cloned()
            .unwrap_or_else(|| "Codex session".to_string()),
        project: cwd.as_deref().and_then(project_name),
        id,
        path: path.to_string_lossy().to_string(),
        source: "codex".to_string(),
        model,
        cwd,
        git_branch: branch,
        worktree: None,         // filled centrally in list_agent_runs from cwd
        created_ms: updated_ms, // fallback to mtime
        updated_ms,
        message_count: count,
        input_tokens,
        output_tokens,
        files_touched: files.len() as u32,
        cost_usd,
        subagent_count: 0, // Codex's rollout log doesn't expose sub-agent calls.
        last_event,
        parent_id: None,
    })
}

fn is_session_meta_line(line: &str) -> bool {
    line.contains(r#""type":"session_meta""#) || line.contains(r#""type": "session_meta""#)
}

fn capture_session_meta(
    payload: Option<&serde_json::Value>,
    id: &mut Option<String>,
    cwd: &mut Option<String>,
    branch: &mut Option<String>,
) {
    let Some(p) = payload else {
        return;
    };
    if id.is_none() {
        *id = p.get("id").and_then(|x| x.as_str()).map(str::to_string);
    }
    if cwd.is_none() {
        *cwd = p.get("cwd").and_then(|x| x.as_str()).map(str::to_string);
    }
    if branch.is_none() {
        *branch = p
            .get("git")
            .and_then(|g| g.get("branch"))
            .and_then(|b| b.as_str())
            .map(str::to_string);
    }
}

impl Codex {
    /// `session_index.jsonl` — the human thread names beside the rollouts.
    fn session_index(&self, env: &dyn Env) -> Option<std::path::PathBuf> {
        self.config_home(env).map(|d| d.join("session_index.jsonl"))
    }
}

fn load_index(path: &std::path::Path) -> HashMap<String, String> {
    let mut map = HashMap::new();
    if let Ok(content) = std::fs::read_to_string(path) {
        for line in content.lines() {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                if let (Some(id), Some(name)) = (
                    v.get("id").and_then(|x| x.as_str()),
                    v.get("thread_name").and_then(|x| x.as_str()),
                ) {
                    map.insert(id.to_string(), name.to_string());
                }
            }
        }
    }
    map
}

fn collect_rollouts(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                collect_rollouts(&p, out);
            } else if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                if name.starts_with("rollout-") && name.ends_with(".jsonl") {
                    out.push(p);
                }
            }
        }
    }
}

fn message_text(payload: &serde_json::Value) -> Option<String> {
    let content = payload.get("content")?;
    if let Some(arr) = content.as_array() {
        let mut buf = String::new();
        for part in arr {
            if let Some(t) = part.get("text").and_then(|x| x.as_str()) {
                let t = t.trim();
                if !t.is_empty() {
                    if !buf.is_empty() {
                        buf.push('\n');
                    }
                    buf.push_str(t);
                }
            }
        }
        let t = buf.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    } else if let Some(s) = content.as_str() {
        let t = s.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    None
}

/// `{"message": "…"}` — the shape of both a top-level `error` line and the
/// `error` object inside `turn.failed`.
fn codex_message(value: &Value) -> String {
    value
        .get("message")
        .and_then(Value::as_str)
        .filter(|m| !m.trim().is_empty())
        .unwrap_or("Codex reported an error")
        .to_string()
}

/// One `item` of a `codex exec --json` stream, as the call it is and — once
/// `completed` is true — the result it got. Items the conversation has no row
/// for (`reasoning`, `todo_list`, a non-fatal `error` item) yield nothing.
fn codex_item(item: &Value, completed: bool) -> Vec<StreamItem> {
    let id = item.get("id").and_then(Value::as_str).unwrap_or("item").to_string();
    let text = |key: &str| item.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    let status = item.get("status").and_then(Value::as_str).unwrap_or("");
    match item.get("type").and_then(Value::as_str) {
        Some("agent_message") => {
            let text = text("text");
            if text.is_empty() {
                Vec::new()
            } else {
                vec![StreamItem::TextPart { id, text }]
            }
        }
        Some("command_execution") => {
            let command = text("command");
            let mut items = vec![StreamItem::ToolCall {
                id: id.clone(),
                name: "shell".to_string(),
                input: serde_json::json!({ "command": command }),
            }];
            if completed {
                let exit_code = item.get("exit_code").and_then(Value::as_i64);
                let output = text("aggregated_output");
                let (ok, content) = match status {
                    // Codex's own sandbox said no and a headless turn had
                    // nobody to ask. Said in words, so the row reads as a
                    // refusal rather than an empty success.
                    "declined" => (false, "Declined: this command needs an approval the headless turn could not ask for.".to_string()),
                    "failed" => (false, output),
                    _ => (exit_code.map_or(true, |code| code == 0), output),
                };
                items.push(StreamItem::ToolResult { id, ok, content });
            }
            items
        }
        Some("file_change") => {
            let changes: Vec<(String, String)> = item
                .get("changes")
                .and_then(Value::as_array)
                .map(|changes| {
                    changes
                        .iter()
                        .map(|c| {
                            let kind = c.get("kind").and_then(Value::as_str).unwrap_or("update").to_string();
                            let path = c.get("path").and_then(Value::as_str).unwrap_or("").to_string();
                            (kind, path)
                        })
                        .collect()
                })
                .unwrap_or_default();
            // The row's subject: the one file, or the first with a count.
            let subject = match changes.as_slice() {
                [] => String::new(),
                [(_, path)] => path.clone(),
                [(_, path), rest @ ..] => format!("{path} (+{} more)", rest.len()),
            };
            let mut items = vec![StreamItem::ToolCall {
                id: id.clone(),
                name: "apply_patch".to_string(),
                input: serde_json::json!({
                    "path": subject,
                    "changes": item.get("changes").cloned().unwrap_or(Value::Null),
                }),
            }];
            if completed {
                let content = changes.iter().map(|(kind, path)| format!("{kind} {path}")).collect::<Vec<_>>().join("\n");
                items.push(StreamItem::ToolResult { id, ok: status != "failed", content });
            }
            items
        }
        Some("mcp_tool_call") => {
            let server = text("server");
            let tool = text("tool");
            let mut items = vec![StreamItem::ToolCall {
                id: id.clone(),
                name: format!("mcp__{server}__{tool}"),
                input: item.get("arguments").cloned().unwrap_or(Value::Null),
            }];
            if completed {
                let error = item.get("error").and_then(|e| e.get("message").or(Some(e))).and_then(Value::as_str);
                let content = match error {
                    Some(message) => message.to_string(),
                    None => result_text(item.get("result").and_then(|r| r.get("content").or(Some(r)))),
                };
                items.push(StreamItem::ToolResult { id, ok: status != "failed" && error.is_none(), content });
            }
            items
        }
        Some("web_search") => {
            let mut items = vec![StreamItem::ToolCall {
                id: id.clone(),
                name: "web_search".to_string(),
                input: serde_json::json!({ "query": text("query") }),
            }];
            if completed {
                let content = item
                    .get("results")
                    .and_then(Value::as_array)
                    .map(|results| {
                        results
                            .iter()
                            .filter_map(|r| r.get("url").or_else(|| r.get("title")).and_then(Value::as_str))
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_default();
                items.push(StreamItem::ToolResult { id, ok: true, content });
            }
            items
        }
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // `thread.started` and `turn.failed` were captured from a real
    // `codex exec --json` run (codex-cli 0.154); the item lines follow the
    // shapes in codex-rs/exec/src/exec_events.rs.
    const THREAD: &str = r#"{"type":"thread.started","thread_id":"01a0fd2e-8711-7503-8166-aa3e358e0096"}"#;
    const FAILED: &str = r#"{"type":"turn.failed","error":{"message":"You've hit your usage limit."}}"#;
    const CMD_STARTED: &str = r#"{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"bash -lc 'npm test'","aggregated_output":"","status":"in_progress"}}"#;
    const CMD_DONE: &str = r#"{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"bash -lc 'npm test'","aggregated_output":"12 passing\n","exit_code":0,"status":"completed"}}"#;
    const CMD_DECLINED: &str = r#"{"type":"item.completed","item":{"id":"item_3","type":"command_execution","command":"gh pr list","aggregated_output":"","exit_code":null,"status":"declined"}}"#;
    const MESSAGE: &str = r#"{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"done"}}"#;
    const PATCH: &str = r#"{"type":"item.completed","item":{"id":"item_2","type":"file_change","changes":[{"path":"src/a.rs","kind":"update"},{"path":"src/b.rs","kind":"add"}],"status":"completed"}}"#;
    const MCP: &str = r#"{"type":"item.completed","item":{"id":"item_4","type":"mcp_tool_call","server":"klide","tool":"agent_list","arguments":{},"result":{"content":[{"type":"text","text":"[]"}]},"error":null,"status":"completed"}}"#;
    const DONE: &str = r#"{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":2}}"#;

    #[test]
    fn stream_args_ask_for_json_and_keep_the_prompt_on_stdin() {
        let spec = ChatSpec { model: "gpt-5", effort: Some("high"), resume: None, mcp: None, allowed_commands: &[] };
        let args = Codex.chat_stream_args("/ws", &spec).unwrap();
        assert_eq!(args[..3], ["exec", "-m", "gpt-5"]);
        assert!(args.windows(2).any(|w| w == ["-s", "workspace-write"]));
        assert!(args.windows(2).any(|w| w == ["-C", "/ws"]));
        assert!(args.windows(2).any(|w| w == ["-c", "model_reasoning_effort=high"]));
        assert!(args.contains(&"--json".to_string()));
        assert_eq!(args.last().map(String::as_str), Some("-"));
        assert!(!args.contains(&"--color".to_string()));
    }

    #[test]
    fn a_remembered_thread_resumes_without_the_flags_resume_lacks() {
        let spec = ChatSpec { model: "", effort: None, resume: Some("01a0-thread"), mcp: None, allowed_commands: &[] };
        let args = Codex.chat_stream_args("/ws", &spec).unwrap();
        assert_eq!(args[..3], ["exec", "resume", "01a0-thread"]);
        // `exec resume` has no `-s` / `-C`: the sandbox is a config override and
        // the cwd is the child's working directory.
        assert!(!args.contains(&"-s".to_string()));
        assert!(!args.contains(&"-C".to_string()));
        assert!(args.windows(2).any(|w| w == ["-c", "sandbox_mode=\"workspace-write\""]));
        assert!(args.contains(&"--json".to_string()));
        assert_eq!(args.last().map(String::as_str), Some("-"));
        assert!(Codex.resumes_sessions());
    }

    #[test]
    fn thread_started_names_the_session_and_a_failed_turn_is_an_error() {
        assert_eq!(Codex.parse_stream_line(THREAD), vec![StreamItem::Session("01a0fd2e-8711-7503-8166-aa3e358e0096".into())]);
        assert_eq!(Codex.parse_stream_line(FAILED), vec![StreamItem::Error("You've hit your usage limit.".into())]);
        assert_eq!(Codex.parse_stream_line(DONE), vec![StreamItem::Finished { cost_usd: None, turns: None }]);
    }

    #[test]
    fn a_command_is_a_call_while_it_runs_and_gains_its_result_when_done() {
        assert_eq!(
            Codex.parse_stream_line(CMD_STARTED),
            vec![StreamItem::ToolCall { id: "item_0".into(), name: "shell".into(), input: serde_json::json!({"command": "bash -lc 'npm test'"}) }]
        );
        let done = Codex.parse_stream_line(CMD_DONE);
        assert_eq!(done.len(), 2);
        assert_eq!(done[1], StreamItem::ToolResult { id: "item_0".into(), ok: true, content: "12 passing\n".into() });
        // The sandbox's refusal is a failed result that says so.
        let declined = Codex.parse_stream_line(CMD_DECLINED);
        assert!(matches!(&declined[1], StreamItem::ToolResult { ok: false, content, .. } if content.starts_with("Declined")));
    }

    #[test]
    fn text_patches_and_mcp_calls_each_become_rows() {
        assert_eq!(Codex.parse_stream_line(MESSAGE), vec![StreamItem::TextPart { id: "item_1".into(), text: "done".into() }]);
        let patch = Codex.parse_stream_line(PATCH);
        assert!(matches!(&patch[0], StreamItem::ToolCall { name, input, .. } if name == "apply_patch" && input["path"] == "src/a.rs (+1 more)"));
        assert_eq!(patch[1], StreamItem::ToolResult { id: "item_2".into(), ok: true, content: "update src/a.rs\nadd src/b.rs".into() });
        let mcp = Codex.parse_stream_line(MCP);
        assert!(matches!(&mcp[0], StreamItem::ToolCall { name, .. } if name == "mcp__klide__agent_list"));
        assert_eq!(mcp[1], StreamItem::ToolResult { id: "item_4".into(), ok: true, content: "[]".into() });
    }

    #[test]
    fn lines_codex_owns_but_klide_has_no_row_for_yield_nothing() {
        for line in [
            r#"{"type":"turn.started"}"#,
            r#"{"type":"item.completed","item":{"id":"r","type":"reasoning","text":"thinking"}}"#,
            r#"{"type":"item.completed","item":{"id":"t","type":"todo_list","items":[]}}"#,
            "not json",
            "",
        ] {
            assert!(Codex.parse_stream_line(line).is_empty(), "{line}");
        }
    }

    fn temp_home(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("klide-delegate-test-codex-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn fixture() -> String {
        let meta = r#"{"type":"session_meta","payload":{"id":"sess-1","cwd":"/Users/x/proj","git":{"branch":"main"}}}"#;
        let turn = r#"{"type":"turn_context","payload":{"model":"gpt-5.4"}}"#;
        let item = r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"hello codex"}]}}"#;
        // An oversized tool-output line: counted as a message, never parsed.
        let huge = format!(
            r#"{{"type":"response_item","payload":{{"type":"function_call_output","output":"{}"}}}}"#,
            "x".repeat(40 * 1024)
        );
        let tokens = r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":55}}}}"#;
        format!("{meta}\n{turn}\n{item}\n{huge}\n{tokens}\n")
    }

    #[test]
    fn chat_args_run_exec_sandboxed_to_the_workspace() {
        let args = Codex.chat_args("/tmp/ws", "gpt-5.4").unwrap();
        assert_eq!(
            args.join(" "),
            "exec -m gpt-5.4 -s workspace-write -C /tmp/ws --skip-git-repo-check --color never -"
        );
    }

    #[test]
    fn parses_a_rollout_and_skips_oversized_lines() {
        let home = temp_home("parse");
        let p = home.join("rollout-1.jsonl");
        std::fs::write(&p, fixture()).unwrap();
        let mut index = HashMap::new();
        index.insert("sess-1".to_string(), "My thread".to_string());
        let run = parse_run(&p, &index).unwrap();
        assert_eq!(run.id, "sess-1");
        assert_eq!(run.title, "My thread");
        assert_eq!(run.model.as_deref(), Some("gpt-5.4"));
        assert_eq!(run.git_branch.as_deref(), Some("main"));
        assert_eq!(run.message_count, 2); // the normal item + the oversized one
        assert_eq!(run.input_tokens, 600); // cumulative minus cached
        assert_eq!(run.output_tokens, 55);
        assert_eq!(run.files_touched, 0);
        assert_eq!(run.status, "running", "the latest turn starts with a user message");
        // gpt-5.4 at 600 input + 55 output = 0.0015 + 0.00055.
        let c = run.cost_usd.expect("gpt-5.4 has a known price");
        assert!((c - 0.00205).abs() < 1e-6, "got {c}");
    }

    #[test]
    fn task_complete_marker_settles_a_fresh_rollout() {
        let home = temp_home("lifecycle");
        let p = home.join("rollout-1.jsonl");
        let done = r#"{"type":"event_msg","payload":{"type":"task_complete"}}"#;
        std::fs::write(&p, format!("{}{done}\n", fixture())).unwrap();

        assert_eq!(parse_run(&p, &HashMap::new()).unwrap().status, "done");
    }

    #[test]
    fn parses_oversized_session_meta_for_desktop_threads() {
        let home = temp_home("oversized-meta");
        let p = home.join("rollout-1.jsonl");
        let meta = format!(
            r#"{{"type":"session_meta","payload":{{"id":"sess-big","cwd":"/Users/x/proj","git":{{"branch":"main"}},"base_instructions":{{"text":"{}"}}}}}}"#,
            "x".repeat(40 * 1024)
        );
        let item = r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"hello"}]}}"#;
        std::fs::write(&p, format!("{meta}\n{item}\n")).unwrap();

        let run = parse_run(&p, &HashMap::new()).unwrap();

        assert_eq!(run.id, "sess-big");
        assert_eq!(run.cwd.as_deref(), Some("/Users/x/proj"));
        assert_eq!(run.project.as_deref(), Some("proj"));
        assert_eq!(run.git_branch.as_deref(), Some("main"));
        assert_eq!(run.message_count, 1);
    }

    #[test]
    fn parses_files_touched_from_codex_function_calls() {
        // Codex's tool calls live in response_item/function_call rows with a
        // stringified JSON `arguments` blob. Two file touches + one re-touch
        // + a shell_command (not a file tool) = 2 unique paths.
        let home = temp_home("files");
        let p = home.join("rollout-1.jsonl");
        let meta = r#"{"type":"session_meta","payload":{"id":"sess-1","cwd":"/proj","git":{"branch":"main"}}}"#;
        let fc1 = r#"{"type":"response_item","payload":{"type":"function_call","name":"read_file","arguments":"{\"file_path\":\"/proj/src/main.rs\"}","call_id":"c1"}}"#;
        let fc2 = r#"{"type":"response_item","payload":{"type":"function_call","name":"read_file","arguments":"{\"file_path\":\"/proj/src/main.rs\"}","call_id":"c2"}}"#;
        let fc3 = r#"{"type":"response_item","payload":{"type":"function_call","name":"edit","arguments":"{\"file_path\":\"/proj/Cargo.toml\"}","call_id":"c3"}}"#;
        let fc4 = r#"{"type":"response_item","payload":{"type":"function_call","name":"shell_command","arguments":"{\"command\":\"ls\"}","call_id":"c4"}}"#;
        std::fs::write(&p, format!("{meta}\n{fc1}\n{fc2}\n{fc3}\n{fc4}\n")).unwrap();
        let run = parse_run(&p, &HashMap::new()).unwrap();
        assert_eq!(
            run.files_touched, 2,
            "re-read should dedupe, shell_command shouldn't count"
        );
    }

    #[test]
    fn discovers_rollouts_recursively() {
        let home = temp_home("discover");
        let day = home.join(".codex/sessions/2026/06/11");
        std::fs::create_dir_all(&day).unwrap();
        std::fs::write(day.join("rollout-1.jsonl"), fixture()).unwrap();
        std::fs::write(day.join("other.jsonl"), "x").unwrap();
        let found = Codex.discover_runs(&crate::delegate::home::test_env(&home));
        assert_eq!(found.len(), 1);
        assert!(found[0].key.ends_with("rollout-1.jsonl"));
    }

    #[test]
    fn read_run_keeps_user_and_assistant_messages() {
        let home = temp_home("read");
        let p = home.join("rollout-1.jsonl");
        let extra = r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"text":"hi!"}]}}"#;
        let noise = r#"{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"text":"system stuff"}]}}"#;
        std::fs::write(&p, format!("{}{extra}\n{noise}\n", fixture())).unwrap();
        let msgs = Codex.read_run(&crate::delegate::ProcessEnv, p.to_str().unwrap()).unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].text, "hello codex");
        assert_eq!(msgs[1].role, "assistant");
    }

    #[test]
    fn index_maps_session_ids_to_thread_names() {
        let home = temp_home("index");
        let codex = home.join(".codex");
        std::fs::create_dir_all(&codex).unwrap();
        std::fs::write(
            codex.join("session_index.jsonl"),
            r#"{"id":"sess-1","thread_name":"My thread"}"#,
        )
        .unwrap();
        let map = load_index(&codex.join("session_index.jsonl"));
        assert_eq!(map.get("sess-1").map(String::as_str), Some("My thread"));
    }
}
