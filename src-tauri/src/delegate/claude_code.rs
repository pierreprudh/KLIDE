use super::runs::{
    bounded_tool_input, bounded_tool_result, cap_messages, clean_title, extract_user_text,
    mtime_ms, project_name, tool_file_path, transcript_status, AgentRun, RunMessage, RunToolCall,
    TranscriptState,
};
use super::chat_stream::{message_blocks, result_text, StreamItem};
use super::{shell_quote, ChatSpec, Delegate, McpServerSpec, McpWiring, RunCandidate, RunParser};
use std::collections::{HashMap, HashSet};

/// Claude Code — Anthropic's CLI. Its TUI accepts the task as the first
/// positional arg directly, so no subcommand is needed. Sessions land in
/// `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`.
pub struct ClaudeCode;

/// Klide's approved commands as Claude Code tool permissions.
///
/// A pattern is passed through as the Bash tool's argument — `gh *` becomes
/// `Bash(gh *)`, an exact `npm test` becomes `Bash(npm test)` — because the two
/// wildcard vocabularies already agree on `*`. An empty list adds no flag at
/// all rather than an empty one, which the CLI would read as "allow nothing".
fn allowed_tools_args(commands: &[String]) -> Vec<String> {
    let specs: Vec<String> = commands
        .iter()
        .map(|c| c.trim())
        .filter(|c| !c.is_empty())
        // A `)` in a pattern would close the permission spec early and change
        // what it means, so such a pattern is dropped rather than reinterpreted.
        .filter(|c| !c.contains(')'))
        .map(|c| format!("Bash({c})"))
        .collect();
    if specs.is_empty() {
        return Vec::new();
    }
    let mut args = vec!["--allowedTools".to_string()];
    args.extend(specs);
    args
}

impl Delegate for ClaudeCode {
    fn id(&self) -> &'static str {
        "claude-code"
    }

    fn binary(&self) -> &'static str {
        "claude"
    }

    fn model_arg(&self, model: &str) -> String {
        format!(" --model {}", shell_quote(model))
    }

    /// `--mcp-config <file>` adds servers for this invocation only, on top of
    /// whatever the user configured — no write to `~/.claude.json`, nothing
    /// to clean up when the session ends.
    fn mcp_wiring(&self, spec: &McpServerSpec) -> Option<McpWiring> {
        let path = format!("{}/{}.claude-mcp.json", spec.config_dir, spec.file_stem);
        let content = serde_json::json!({
            "mcpServers": {
                "klide": {
                    "type": "stdio",
                    "command": spec.command,
                    "args": spec.args,
                    "env": spec.env_json(),
                }
            }
        });
        Some(McpWiring {
            flags: format!(" --mcp-config {}", shell_quote(&path)),
            env: vec![],
            files: vec![(path, content.to_string())],
        })
    }

    fn resume_arg(&self, session_id: &str) -> String {
        format!(" --resume {}", shell_quote(session_id))
    }

    fn mission_command(&self, task: Option<&str>, model: Option<&str>) -> Result<String, String> {
        let task = self.mission_task(task)?;
        let model_arg = self.mission_model_arg(model);
        Ok(format!(
            "claude -p{model_arg} --permission-mode acceptEdits --output-format text {}",
            shell_quote(task)
        ))
    }

    /// Headless: `-p` reads the prompt from stdin and prints the answer.
    /// `acceptEdits` lets Goal-mode runs touch files without an interactive
    /// permission prompt nobody is there to answer.
    fn chat_args(&self, _cwd: &str, model: &str) -> Result<Vec<String>, String> {
        let mut args: Vec<String> = vec!["-p".into()];
        if !model.is_empty() {
            args.extend(["--model".into(), model.into()]);
        }
        args.extend([
            "--permission-mode".into(),
            "acceptEdits".into(),
            "--output-format".into(),
            "text".into(),
        ]);
        Ok(args)
    }

    /// Claude Code reports every step of a headless turn as JSONL — assistant
    /// text, its own `tool_use` calls, the matching `tool_result`s, a closing
    /// cost line. `--verbose` is required for `stream-json` under `-p`.
    fn chat_stream_args(&self, cwd: &str, spec: &ChatSpec) -> Option<Vec<String>> {
        let mut args = self.chat_args(cwd, spec.model).ok()?;
        // Same invocation, structured output: replace the *value* of the
        // existing `--output-format` rather than appending a second, conflicting
        // one. Located by its flag, not by searching for the string "text" —
        // that would rewrite a model or prompt argument that happened to be
        // called "text".
        match args.iter().position(|a| a == "--output-format") {
            Some(flag) if flag + 1 < args.len() => args[flag + 1] = "stream-json".to_string(),
            _ => args.extend(["--output-format".to_string(), "stream-json".to_string()]),
        }
        args.push("--verbose".into());
        // Without this the CLI emits each assistant block only once complete, so
        // a Focus turn sat silent and then landed in one lump — and time-to-first
        // token measured the whole block, not the first token.
        args.push("--include-partial-messages".into());
        // Continue the session this conversation already opened instead of
        // starting a new one. Without it every turn is a stranger: Claude Code
        // re-reads a whole transcript pasted onto stdin, keeps none of its own
        // context or prompt cache, and files a separate run on disk per message.
        if let Some(session) = spec.resume.map(str::trim).filter(|s| !s.is_empty()) {
            args.extend(["--resume".to_string(), session.to_string()]);
        }
        // Claude Code auto-allows a small safe set of commands and refuses the
        // rest — `echo` runs, `gh pr list` comes back "This command requires
        // approval" — and a headless turn has no terminal to approve it in, so
        // the delegate could not run anything real. `--allowedTools` carries
        // over the approvals the project already granted in Klide, which is
        // narrower than the alternative of dropping the permission mode.
        args.extend(allowed_tools_args(spec.allowed_commands));
        Some(args)
    }

    /// `--resume <id>` continues the named session, so the runner may send just
    /// the newest message.
    fn resumes_sessions(&self) -> bool {
        true
    }

    /// Claude Code's dialect is Anthropic's, wrapped one object per line:
    /// a `system`/`init` line naming the session, `assistant` messages holding
    /// text and `tool_use` blocks, the matching `tool_result`s addressed to
    /// `user` (that is how they are fed back to the model), raw `stream_event`
    /// deltas from `--include-partial-messages`, and a closing `result` line.
    fn parse_stream_line(&self, line: &str) -> Vec<StreamItem> {
        let line = line.trim();
        if line.is_empty() {
            return Vec::new();
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            return Vec::new();
        };
        match value.get("type").and_then(|v| v.as_str()) {
            // Only `init` carries the session id; the other `system` lines
            // (hook_started, hook_response, …) are noise for our purposes.
            Some("system") => match value.get("subtype").and_then(|v| v.as_str()) {
                Some("init") => value
                    .get("session_id")
                    .and_then(|v| v.as_str())
                    .map(|id| vec![StreamItem::Session(id.to_string())])
                    .unwrap_or_default(),
                _ => Vec::new(),
            },
            Some("assistant") => message_blocks(&value)
                .iter()
                .filter_map(assistant_block)
                .collect(),
            Some("user") => message_blocks(&value)
                .iter()
                .filter_map(tool_result_block)
                .collect(),
            // Raw Anthropic stream events. Only the text deltas matter: tool
            // calls are read from the assembled `assistant` message instead, so
            // a partial `input_json_delta` never has to be reassembled here.
            Some("stream_event") => {
                let event = value.get("event");
                let is_text_delta = event.and_then(|e| e.get("type")).and_then(|v| v.as_str())
                    == Some("content_block_delta")
                    && event
                        .and_then(|e| e.get("delta"))
                        .and_then(|d| d.get("type"))
                        .and_then(|v| v.as_str())
                        == Some("text_delta");
                if !is_text_delta {
                    return Vec::new();
                }
                event
                    .and_then(|e| e.get("delta"))
                    .and_then(|d| d.get("text"))
                    .and_then(|v| v.as_str())
                    .filter(|text| !text.is_empty())
                    .map(|text| vec![StreamItem::TextDelta(text.to_string())])
                    .unwrap_or_default()
            }
            Some("result") => vec![StreamItem::Finished {
                cost_usd: value.get("total_cost_usd").and_then(|v| v.as_f64()),
                turns: value.get("num_turns").and_then(|v| v.as_i64()),
            }],
            _ => Vec::new(),
        }
    }

    /// Claude Code is the one delegate with a first-class hooks system —
    /// Klide's status hooks ride `~/.claude/settings.json`.
    fn ensure_status_hooks(&self, home: &str) -> Result<bool, String> {
        super::status::install_claude_hooks(home)
    }

    fn login_commands(&self) -> Vec<String> {
        ["--claudeai", "--console", "--sso"]
            .iter()
            .map(|flag| format!("claude auth login {flag}"))
            .chain(std::iter::once("claude setup-token".to_string()))
            .collect()
    }

    /// `claude auth status` prints JSON: `{ loggedIn, authMethod, apiProvider }`.
    fn check_auth(&self, command_path: &str) -> Result<(bool, String), String> {
        let output = std::process::Command::new(command_path)
            .args(["auth", "status"])
            .output()
            .map_err(|e| format!("Unable to check Claude auth: {e}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let value = serde_json::from_str::<serde_json::Value>(&stdout).ok();
        let field = |key: &str| {
            value
                .as_ref()
                .and_then(|v| v.get(key))
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string()
        };
        let logged_in = value
            .as_ref()
            .and_then(|v| v.get("loggedIn"))
            .and_then(|v| v.as_bool())
            .unwrap_or(output.status.success());
        Ok((
            logged_in,
            if logged_in {
                format!(
                    "Logged in via {} ({})",
                    field("authMethod"),
                    field("apiProvider")
                )
            } else {
                "Not logged in".to_string()
            },
        ))
    }

    fn install_paths(&self, home: &str) -> Vec<String> {
        vec![format!("{home}/.local/bin/claude")]
    }

    fn discover_runs(&self, home: &str) -> Vec<RunCandidate> {
        let mut out = Vec::new();
        let root = std::path::Path::new(home).join(".claude/projects");
        if let Ok(projects) = std::fs::read_dir(&root) {
            for proj in projects.flatten() {
                if !proj.path().is_dir() {
                    continue;
                }
                if let Ok(files) = std::fs::read_dir(proj.path()) {
                    for f in files.flatten() {
                        let p = f.path();
                        if p.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                            out.push(RunCandidate {
                                mtime_ms: mtime_ms(&p),
                                key: p.to_string_lossy().to_string(),
                            });
                            continue;
                        }
                        if !p.is_dir() {
                            continue;
                        }
                        let subagents = p.join("subagents");
                        if let Ok(subagent_files) = std::fs::read_dir(&subagents) {
                            for sf in subagent_files.flatten() {
                                let sp = sf.path();
                                if sp.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                                    out.push(RunCandidate {
                                        mtime_ms: mtime_ms(&sp),
                                        key: sp.to_string_lossy().to_string(),
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
        out
    }

    fn run_parser(&self, _home: &str) -> Box<dyn RunParser> {
        Box::new(ClaudeRunParser)
    }

    fn read_run(&self, _home: &str, key: &str) -> Result<Vec<RunMessage>, String> {
        use std::io::BufRead;
        // Streamed, with the same oversized-line guard `parse_run` carries and
        // for the same reason: Claude inlines whole tool outputs, so a long
        // session is tens of megabytes of which one line can be most of it.
        // Slurping the file and building a `Value` per line is what made a
        // single transcript dominate a page. A skipped line is a giant tool
        // result in practice — its call keeps its name and arguments and simply
        // reports no output, which is the same trade `parse_run` already makes.
        let file = std::fs::File::open(key).map_err(|e| e.to_string())?;
        let reader = std::io::BufReader::new(file);
        let mut msgs: Vec<RunMessage> = Vec::new();
        // tool_use_id → where that call landed. A CLI records the call in one
        // message and its result in a later one, so the result has to be folded
        // back onto the row it belongs to rather than shown as a turn of its
        // own (which is why they used to be dropped as noise).
        let mut placed: HashMap<String, (usize, usize)> = HashMap::new();
        for line in reader.lines() {
            let line = match line {
                Ok(line) => line,
                Err(_) => break,
            };
            if line.len() > MAX_PARSE_LINE {
                continue;
            }
            let v: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let role = match v.get("type").and_then(|t| t.as_str()) {
                Some("user") => "user",
                Some("assistant") => "assistant",
                _ => continue,
            };
            let Some(message) = v.get("message") else {
                continue;
            };
            // Results first, and independently of whether this message shows:
            // a turn that is *only* tool results still has something to say —
            // just not on a line of its own.
            fold_tool_results(message, &mut msgs, &placed);
            if let Some((text, tools, images)) = message_text(message) {
                let index = msgs.len();
                for (slot, call) in tools.iter().enumerate() {
                    if let Some(id) = &call.id {
                        placed.insert(id.clone(), (index, slot));
                    }
                }
                msgs.push(RunMessage {
                    role: role.to_string(),
                    text,
                    tools,
                    images,
                });
            }
        }
        cap_messages(&mut msgs);
        Ok(msgs)
    }
}

struct ClaudeRunParser;

impl RunParser for ClaudeRunParser {
    fn parse(&self, key: &str) -> Option<AgentRun> {
        parse_run(std::path::Path::new(key))
    }
}

/// The line length past which a transcript line is skipped rather than parsed.
/// Shared by both readers — one number, one reason (see `parse_run`).
const MAX_PARSE_LINE: usize = 32 * 1024;

fn parse_run(path: &std::path::Path) -> Option<AgentRun> {
    // Claude transcripts inline full tool output, so a long session runs to tens
    // of megabytes on one line apiece. Slurping the file and building a
    // `serde_json::Value` for every line is what made a single 90 MB transcript
    // dominate a page. Stream it and skip JSON-parsing oversized lines instead —
    // the same guard `parse_codex_run` already carries.
    //
    // An oversized line is a tool-result blob in practice, so it still counts as
    // a turn (read off the raw bytes) but contributes no tokens, tool paths, or
    // title. That trade is deliberate: those live on the small metadata lines.
    let file = std::fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);
    let id = path.file_stem()?.to_string_lossy().to_string();
    let parent_id = claude_subagent_parent_id(path);
    let is_subagent_log = parent_id.is_some();
    let (mut title, mut model, mut cwd, mut branch) = (None, None, None, None);
    let mut count: u32 = 0;
    let mut created_ms: i64 = 0;
    let (mut input_tokens, mut output_tokens): (i64, i64) = (0, 0);
    let mut files: HashSet<String> = HashSet::new();
    let mut subagent_count: u32 = 0;
    let mut last_event: Option<String> = None;
    let mut transcript_state = TranscriptState::Unknown;
    for line in std::io::BufRead::lines(reader) {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.len() > MAX_PARSE_LINE {
            if oversized_line_counts_as_turn(&line, is_subagent_log) {
                count += 1;
            }
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // Sub-agent (Task / Agent) turns are recorded inline with this flag.
        // They're the sub-agent's *own* back-and-forth, not the operator's
        // conversation, so they don't count toward this run's message_count
        // and their `Agent` calls don't inflate the sub-agent tally (a
        // sub-agent that spawns its own sub-agent is the child's concern).
        let is_sidechain = v
            .get("isSidechain")
            .and_then(|b| b.as_bool())
            .unwrap_or(false);
        // In a parent Claude transcript, `isSidechain` lines are the child
        // agent's chatter and should not inflate the parent's message count.
        // In `.../<parent>/subagents/<agent>.jsonl`, every real turn carries
        // that same flag, so treat it as the subagent's own main transcript.
        let counts_as_main = is_subagent_log || !is_sidechain;
        // Capture first timestamp as creation time
        if created_ms == 0 {
            if let Some(ts) = v.get("ts").and_then(|t| t.as_i64()) {
                created_ms = ts;
            }
        }
        if cwd.is_none() {
            cwd = v.get("cwd").and_then(|c| c.as_str()).map(str::to_string);
        }
        if branch.is_none() {
            if let Some(b) = v.get("gitBranch").and_then(|b| b.as_str()) {
                if !b.is_empty() {
                    branch = Some(b.to_string());
                }
            }
        }
        match v.get("type").and_then(|t| t.as_str()) {
            Some("user") if counts_as_main => {
                count += 1;
                // A prompt or a tool result hands work back to Claude.
                transcript_state = TranscriptState::Working;
                if title.is_none() {
                    if let Some(t) = v.get("message").and_then(extract_user_text) {
                        title = Some(clean_title(&t));
                    }
                }
            }
            Some("assistant") => {
                if counts_as_main {
                    count += 1;
                    // An assistant response that requests a tool is still in
                    // flight. A response without one is a completed turn,
                    // waiting at Claude's composer for the next user prompt.
                    let uses_tool = v
                        .get("message")
                        .and_then(|m| m.get("content"))
                        .and_then(|c| c.as_array())
                        .is_some_and(|parts| {
                            parts.iter().any(|part| {
                                part.get("type").and_then(|t| t.as_str()) == Some("tool_use")
                            })
                        });
                    transcript_state = if uses_tool {
                        TranscriptState::Working
                    } else {
                        TranscriptState::TurnComplete
                    };
                    // Newest assistant turn wins — "what the run last did".
                    if let Some((t, _, _)) = v.get("message").and_then(message_text) {
                        last_event = Some(clean_title(&t));
                    }
                }
                if model.is_none() {
                    model = v
                        .get("message")
                        .and_then(|m| m.get("model"))
                        .and_then(|m| m.as_str())
                        .map(str::to_string);
                }
                // Each assistant line carries that turn's usage. Cache *reads*
                // are excluded (re-reads of the same prefix); cache *creation*
                // is genuine new input so it counts.
                if let Some(u) = v.get("message").and_then(|m| m.get("usage")) {
                    let n = |key: &str| u.get(key).and_then(|x| x.as_i64()).unwrap_or(0);
                    input_tokens += n("input_tokens") + n("cache_creation_input_tokens");
                    output_tokens += n("output_tokens");
                }
                // Walk the assistant content for tool_use parts and record
                // every file the agent touched. We dedupe by path string so a
                // long session that re-reads a file doesn't double-count it.
                if let Some(arr) = v
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array())
                {
                    for part in arr {
                        if part.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                            let name = part.get("name").and_then(|n| n.as_str()).unwrap_or("");
                            let input = part.get("input").unwrap_or(&serde_json::Value::Null);
                            if let Some(path) = tool_file_path(name, input) {
                                files.insert(path);
                            }
                            // Claude spawns sub-agents through the `Task` tool
                            // (older builds) or the `Agent` tool (current). Each
                            // call is one sub-agent; we tally them from the main
                            // transcript only — sidechain turns are skipped above.
                            if counts_as_main && (name == "Agent" || name == "Task") {
                                subagent_count += 1;
                            }
                        }
                    }
                }
            }
            // Headless Claude runs append an explicit result record. Interactive
            // sessions do not, which is why assistant/tool markers above remain
            // necessary for historical runs created outside Klide.
            Some("result") if counts_as_main => {
                transcript_state = TranscriptState::TurnComplete;
            }
            _ => {}
        }
    }
    let updated_ms = mtime_ms(path);
    if created_ms == 0 {
        created_ms = updated_ms;
    }
    if cwd.is_none() {
        cwd = claude_project_cwd(path);
    }
    let cost_usd =
        crate::pricing::cost_for_run(model.as_deref().unwrap_or(""), input_tokens, output_tokens);
    Some(AgentRun {
        status: transcript_status(updated_ms, transcript_state),
        project: cwd.as_deref().and_then(project_name),
        id,
        path: path.to_string_lossy().to_string(),
        source: "claude-code".to_string(),
        title: title.unwrap_or_else(|| "Untitled session".to_string()),
        model,
        cwd,
        git_branch: branch,
        worktree: None, // filled centrally in list_agent_runs from cwd
        created_ms,
        updated_ms,
        message_count: count,
        input_tokens,
        output_tokens,
        files_touched: files.len() as u32,
        cost_usd,
        subagent_count,
        last_event,
        parent_id,
    })
}

/// Whether an oversized transcript line is one of the operator's turns, decided
/// from the raw bytes because the point of the size guard is to not parse it.
/// Mirrors the `counts_as_main` rule the parsed path applies: sidechain lines are
/// a sub-agent's own chatter and belong to the child's message count, not this
/// run's — unless this *is* the sub-agent's transcript, where they're all it has.
fn oversized_line_counts_as_turn(line: &str, is_subagent_log: bool) -> bool {
    let is_turn = line.contains(r#""type":"user""#) || line.contains(r#""type":"assistant""#);
    let is_sidechain = line.contains(r#""isSidechain":true"#);
    is_turn && (is_subagent_log || !is_sidechain)
}

fn claude_subagent_parent_id(path: &std::path::Path) -> Option<String> {
    let subagents_dir = path.parent()?;
    if subagents_dir.file_name()?.to_str()? != "subagents" {
        return None;
    }
    subagents_dir
        .parent()?
        .file_name()
        .map(|id| id.to_string_lossy().to_string())
        .filter(|id| !id.is_empty())
}

fn claude_project_cwd(path: &std::path::Path) -> Option<String> {
    let mut components = path.components();
    while let Some(component) = components.next() {
        if component.as_os_str() != "projects" {
            continue;
        }
        let encoded = components.next()?.as_os_str().to_string_lossy();
        let rest = encoded.strip_prefix('-')?;
        let cwd = format!("/{}", rest.replace('-', "/"));
        return std::path::Path::new(&cwd).is_dir().then_some(cwd);
    }
    None
}

// Turn a Claude Code image content block into a self-contained `data:` URI so
// the conversation view can render the actual picture. Returns None if it isn't
// a base64-inlined image (url sources are rare here and not self-contained). A
// hard size cap keeps one pathological paste from bloating the payload.
fn image_data_uri(part: &serde_json::Value) -> Option<String> {
    let source = part.get("source")?;
    if source.get("type").and_then(|t| t.as_str()) != Some("base64") {
        return None;
    }
    let media_type = source
        .get("media_type")
        .and_then(|m| m.as_str())
        .unwrap_or("image/png");
    let data = source.get("data").and_then(|d| d.as_str())?;
    // ~8 MB of base64 ≈ a 6 MB image; skip anything larger.
    if data.is_empty() || data.len() > 8_000_000 {
        return None;
    }
    Some(format!("data:{media_type};base64,{data}"))
}

// Walk a message's content into readable text, structured tool calls, and any
// inline images (as data URIs): text parts concatenate; tool_use parts become
// structured RunToolCall entries (no longer folded into the text as
// "[tool: <name>]"); base64 image parts become `data:` URIs. The redundant
// "[Image: source: <path>]" breadcrumb the CLI writes next to a paste is
// dropped, since the picture now renders on its own. Thinking / tool_result
// noise is dropped — it has no place in a résumé view. Returns None only when
// there is nothing (text, tool call, or image) to show.
fn message_text(message: &serde_json::Value) -> Option<(String, Vec<RunToolCall>, Vec<String>)> {
    let content = message.get("content")?;
    if let Some(s) = content.as_str() {
        let t = s.trim();
        return if t.is_empty() || t.starts_with('<') {
            None
        } else {
            Some((t.to_string(), vec![], vec![]))
        };
    }
    if let Some(arr) = content.as_array() {
        let mut buf = String::new();
        let mut tools: Vec<RunToolCall> = Vec::new();
        let mut images: Vec<String> = Vec::new();
        for part in arr {
            match part.get("type").and_then(|t| t.as_str()) {
                Some("text") => {
                    if let Some(t) = part.get("text").and_then(|x| x.as_str()) {
                        let t = t.trim();
                        // Drop the "[Image: source: …]" line the CLI writes
                        // alongside a pasted image — the image itself renders.
                        if t.is_empty() || t.starts_with("[Image: source:") {
                            continue;
                        }
                        if !buf.is_empty() {
                            buf.push('\n');
                        }
                        buf.push_str(t);
                    }
                }
                Some("tool_use") => {
                    let name = part.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                    let input = part.get("input").cloned();
                    tools.push(RunToolCall {
                        name: name.to_string(),
                        id: part
                            .get("id")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string()),
                        // Deliberately not a pre-rendered label. The row draws
                        // its own one-line summary from these arguments, and a
                        // second summariser here would be a second answer to
                        // "what did this call do" — `summarize_call`'s output
                        // already carries the tool name, which the row renders
                        // separately.
                        summary: None,
                        input: input.as_ref().map(bounded_tool_input),
                        result: None,
                        ok: None,
                    });
                }
                Some("image") => {
                    if let Some(uri) = image_data_uri(part) {
                        images.push(uri);
                    }
                }
                _ => {}
            }
        }
        let t = buf.trim().to_string();
        if !t.is_empty() || !tools.is_empty() || !images.is_empty() {
            return Some((t, tools, images));
        }
    }
    None
}

/// Fold a message's `tool_result` blocks onto the calls they answer. A result
/// is not a turn: it belongs under the row that made the call, which is
/// somewhere above in the conversation already. Unmatched ids are ignored —
/// a result whose call was skipped (oversized line, capped transcript) has
/// nothing to attach to, and inventing a row for it would read as a tool
/// nobody called.
fn fold_tool_results(
    message: &serde_json::Value,
    msgs: &mut [RunMessage],
    placed: &HashMap<String, (usize, usize)>,
) {
    let Some(parts) = message.get("content").and_then(|c| c.as_array()) else {
        return;
    };
    for part in parts {
        if part.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
            continue;
        }
        let Some(id) = part.get("tool_use_id").and_then(|v| v.as_str()) else {
            continue;
        };
        let Some(&(index, slot)) = placed.get(id) else {
            continue;
        };
        let Some(call) = msgs.get_mut(index).and_then(|m| m.tools.get_mut(slot)) else {
            continue;
        };
        // `is_error` absent means it worked — the CLI only writes the flag to
        // say otherwise.
        call.ok = Some(
            !part
                .get("is_error")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        );
        let text = bounded_tool_result(&result_text(part.get("content")));
        if !text.is_empty() {
            call.result = Some(text);
        }
    }
}

/// One `assistant` content block → an item. Text and tool calls only; other
/// block types (thinking, redacted) carry nothing this vocabulary holds.
fn assistant_block(block: &serde_json::Value) -> Option<StreamItem> {
    match block.get("type").and_then(|v| v.as_str()) {
        Some("text") => {
            let text = block.get("text").and_then(|v| v.as_str())?;
            // Empty text blocks appear between tool calls; they would add blank
            // lines to the answer.
            (!text.is_empty()).then(|| StreamItem::Text(text.to_string()))
        }
        Some("tool_use") => Some(StreamItem::ToolCall {
            id: block
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            name: block
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("tool")
                .to_string(),
            input: block.get("input").cloned().unwrap_or(serde_json::Value::Null),
        }),
        _ => None,
    }
}

/// One `tool_result` block → an item. `is_error` absent means it worked.
fn tool_result_block(block: &serde_json::Value) -> Option<StreamItem> {
    if block.get("type").and_then(|v| v.as_str()) != Some("tool_result") {
        return None;
    }
    Some(StreamItem::ToolResult {
        id: block
            .get("tool_use_id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        ok: !block
            .get("is_error")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        content: result_text(block.get("content")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Captured from a real `claude -p --output-format stream-json --verbose
    // --include-partial-messages` run, trimmed to the lines that matter. Kept
    // verbatim so a CLI change shows up here as a failing test rather than as an
    // empty conversation.
    const INIT: &str = r#"{"type":"system","subtype":"init","cwd":"/ws","session_id":"abc-123"}"#;
    const HOOK: &str = r#"{"type":"system","subtype":"hook_started","hook_id":"9dec"}"#;
    const TEXT_AND_CALL: &str = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"I'll read the first line."},{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"/ws/README.md","limit":1}}]}}"#;
    const RESULT_LINE: &str = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"1\t<div align=\"center\">"}]}}"#;
    const RATE_LIMIT: &str = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}"#;
    const FINISHED: &str = r#"{"type":"result","subtype":"success","total_cost_usd":0.348942,"num_turns":2}"#;

    #[test]
    fn reads_session_text_calls_and_results_from_a_real_turn() {
        assert_eq!(
            ClaudeCode.parse_stream_line(INIT),
            vec![StreamItem::Session("abc-123".into())]
        );
        assert_eq!(
            ClaudeCode.parse_stream_line(TEXT_AND_CALL),
            vec![
                StreamItem::Text("I'll read the first line.".into()),
                StreamItem::ToolCall {
                    id: "toolu_1".into(),
                    name: "Read".into(),
                    input: serde_json::json!({"file_path": "/ws/README.md", "limit": 1}),
                },
            ]
        );
        assert_eq!(
            ClaudeCode.parse_stream_line(RESULT_LINE),
            vec![StreamItem::ToolResult {
                id: "toolu_1".into(),
                ok: true,
                content: "1\t<div align=\"center\">".into(),
            }]
        );
        assert_eq!(
            ClaudeCode.parse_stream_line(FINISHED),
            vec![StreamItem::Finished {
                cost_usd: Some(0.348942),
                turns: Some(2)
            }]
        );
    }

    #[test]
    fn text_deltas_are_read_and_their_scaffolding_ignored() {
        const DELTA: &str = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"One"}}}"#;
        assert_eq!(
            ClaudeCode.parse_stream_line(DELTA),
            vec![StreamItem::TextDelta("One".into())]
        );
        // The frame around the deltas carries no text of its own. Emitting
        // anything for these would double the answer.
        for line in [
            r#"{"type":"stream_event","event":{"type":"message_start","message":{"role":"assistant"}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#,
            r#"{"type":"stream_event","event":{"type":"message_stop"}}"#,
            // Tool arguments stream too, but the call is read from the assembled
            // `assistant` message rather than reassembled from partial JSON.
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"fi"}}}"#,
        ] {
            assert!(ClaudeCode.parse_stream_line(line).is_empty(), "line: {line}");
        }
    }

    #[test]
    fn unknown_and_malformed_lines_are_ignored_not_fatal() {
        for line in [HOOK, RATE_LIMIT, "{not json", "", "   "] {
            assert!(ClaudeCode.parse_stream_line(line).is_empty(), "line: {line}");
        }
    }

    #[test]
    fn tool_result_blocks_flatten_and_errors_are_marked() {
        let blocks = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t2","is_error":true,"content":[{"type":"text","text":"line one"},{"type":"text","text":"line two"}]}]}}"#;
        assert_eq!(
            ClaudeCode.parse_stream_line(blocks),
            vec![StreamItem::ToolResult {
                id: "t2".into(),
                ok: false,
                content: "line one\nline two".into(),
            }]
        );
    }

    /// A tool row that says only "Bash" is true and useless — eight of them in
    /// a row say nothing at all. The call carries what it was asked to do, and
    /// the result that arrives one message later is folded back onto it rather
    /// than dropped as plumbing.
    #[test]
    fn a_replayed_tool_call_carries_its_arguments_and_its_result() {
        let home = temp_home("tool-detail");
        let path = home.join("session.jsonl");
        std::fs::write(
            &path,
            concat!(
                r#"{"type":"user","message":{"content":"check the tree"}}"#,
                "\n",
                r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"git status"}}]}}"#,
                "\n",
                r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"On branch main\nnothing to commit"}]}}"#,
                "\n",
            ),
        )
        .unwrap();

        let msgs = ClaudeCode.read_run("", path.to_str().unwrap()).unwrap();

        // The result is not a turn of its own — it belongs to the call above.
        assert_eq!(msgs.len(), 2);
        let call = &msgs[1].tools[0];
        assert_eq!(call.name, "Bash");
        assert_eq!(
            call.input.as_ref().and_then(|i| i.get("command")),
            Some(&serde_json::Value::String("git status".into()))
        );
        assert_eq!(
            call.result.as_deref(),
            Some("On branch main\nnothing to commit")
        );
        assert_eq!(call.ok, Some(true));
    }

    /// `is_error` is the only thing that says a tool failed; absent means it
    /// worked, and *no result at all* means unknown — never success.
    #[test]
    fn a_failed_result_is_marked_and_an_unanswered_call_stays_unknown() {
        let home = temp_home("tool-error");
        let path = home.join("session.jsonl");
        std::fs::write(
            &path,
            concat!(
                r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"false"}},{"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"/ws/gone.rs"}}]}}"#,
                "
",
                r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"exit 1"}]}}"#,
                "
",
            ),
        )
        .unwrap();

        let msgs = ClaudeCode.read_run("", path.to_str().unwrap()).unwrap();
        let tools = &msgs[0].tools;

        assert_eq!(tools[0].ok, Some(false));
        assert_eq!(tools[0].result.as_deref(), Some("exit 1"));
        // No result line ever arrived for the second call.
        assert_eq!(tools[1].ok, None);
        assert_eq!(tools[1].result, None);
        assert_eq!(
            tools[1].input.as_ref().and_then(|i| i.get("file_path")),
            Some(&serde_json::Value::String("/ws/gone.rs".into()))
        );
    }

    /// The reader skips a line too big to parse, exactly as `parse_run` does.
    /// Its call keeps its name and arguments and simply reports no output.
    #[test]
    fn an_oversized_result_line_leaves_its_call_intact() {
        let home = temp_home("tool-oversized");
        let path = home.join("session.jsonl");
        let blob = "x".repeat(64 * 1024);
        std::fs::write(
            &path,
            format!(
                concat!(
                    r#"{{"type":"assistant","message":{{"content":[{{"type":"tool_use","id":"t1","name":"Read","input":{{"file_path":"/ws/huge.log"}}}}]}}}}"#,
                    "
",
                    r#"{{"type":"user","message":{{"content":[{{"type":"tool_result","tool_use_id":"t1","content":"{blob}"}}]}}}}"#,
                    "
",
                ),
                blob = blob
            ),
        )
        .unwrap();

        let msgs = ClaudeCode.read_run("", path.to_str().unwrap()).unwrap();

        assert_eq!(msgs.len(), 1);
        assert_eq!(
            msgs[0].tools[0].input.as_ref().and_then(|i| i.get("file_path")),
            Some(&serde_json::Value::String("/ws/huge.log".into()))
        );
        assert_eq!(msgs[0].tools[0].result, None);
    }

    fn temp_home(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("klide-delegate-test-claude-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const FIXTURE: &str = concat!(
        r#"{"type":"user","ts":1000,"cwd":"/Users/x/proj","gitBranch":"main","message":{"content":"fix the login bug"}}"#,
        "\n",
        r#"{"type":"assistant","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":100,"cache_creation_input_tokens":50,"cache_read_input_tokens":9000,"output_tokens":20},"content":[{"type":"text","text":"On it."},{"type":"tool_use","name":"read_file"}]}}"#,
        "\n",
        r#"not json"#,
        "\n",
    );

    /// Claude inlines whole tool results, so a long session carries multi-megabyte
    /// lines. The parser streams past them instead of deserializing them, but they
    /// are still turns — the count has to come off the raw bytes.
    #[test]
    fn oversized_lines_still_count_as_turns_without_being_parsed() {
        let home = temp_home("oversized");
        let p = home.join("big.jsonl");
        let blob = "x".repeat(64 * 1024);
        let oversized_turn = format!(r#"{{"type":"user","message":{{"content":"{blob}"}}}}"#);
        // A sidechain turn is the sub-agent's own chatter; in a *parent*
        // transcript it must not inflate the parent's count, oversized or not.
        let oversized_sidechain = format!(
            r#"{{"type":"assistant","isSidechain":true,"message":{{"content":"{blob}"}}}}"#
        );
        std::fs::write(
            &p,
            format!("{FIXTURE}{oversized_turn}\n{oversized_sidechain}\n"),
        )
        .unwrap();

        let run = parse_run(&p).unwrap();

        // 2 small turns from FIXTURE + the oversized user turn; sidechain excluded.
        assert_eq!(run.message_count, 3);
        // Metadata still comes off the small lines.
        assert_eq!(run.cwd.as_deref(), Some("/Users/x/proj"));
        assert_eq!(run.model.as_deref(), Some("claude-sonnet-4-6"));
        assert_eq!(run.title, "fix the login bug");

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn chat_args_run_headless_with_accept_edits() {
        let args = ClaudeCode
            .chat_args("/tmp/ws", "claude-sonnet-4-6")
            .unwrap();
        assert_eq!(
            args.join(" "),
            "-p --model claude-sonnet-4-6 --permission-mode acceptEdits --output-format text"
        );
    }

    /// One turn's terms, with only what a test cares about spelled out.
    fn spec<'a>(model: &'a str, resume: Option<&'a str>, allowed: &'a [String]) -> ChatSpec<'a> {
        ChatSpec { model, resume, allowed_commands: allowed }
    }

    #[test]
    fn stream_args_swap_the_format_value_and_add_verbose() {
        let args = ClaudeCode.chat_stream_args("/tmp/ws", &spec("claude-sonnet-5", None, &[])).unwrap();
        assert_eq!(
            args.join(" "),
            "-p --model claude-sonnet-5 --permission-mode acceptEdits \
             --output-format stream-json --verbose --include-partial-messages"
        );
        // Exactly one format flag — a second would conflict.
        assert_eq!(args.iter().filter(|a| *a == "--output-format").count(), 1);
        assert!(!args.contains(&"text".to_string()));
    }

    #[test]
    fn stream_args_rewrite_the_flag_value_not_a_model_named_text() {
        // The value is found via `--output-format`, so a model argument that
        // happens to be the word "text" survives untouched.
        let args = ClaudeCode.chat_stream_args("/tmp/ws", &spec("text", None, &[])).unwrap();
        assert_eq!(
            args.join(" "),
            "-p --model text --permission-mode acceptEdits \
             --output-format stream-json --verbose --include-partial-messages"
        );
    }

    #[test]
    fn stream_args_resume_the_named_session() {
        let args = ClaudeCode
            .chat_stream_args("/tmp/ws", &spec("claude-sonnet-5", Some("abc-123"), &[]))
            .unwrap();
        assert!(args.windows(2).any(|w| w == ["--resume", "abc-123"]));
        // A blank id is not a session — it must not produce a bare `--resume`,
        // which would make the CLI open its interactive picker.
        let args = ClaudeCode
            .chat_stream_args("/tmp/ws", &spec("claude-sonnet-5", Some("  "), &[]))
            .unwrap();
        assert!(!args.contains(&"--resume".to_string()));
    }

    #[test]
    fn approved_commands_become_bash_tool_permissions() {
        let allowed = vec!["gh *".to_string(), "npm test".to_string()];
        let args = ClaudeCode
            .chat_stream_args("/tmp/ws", &spec("", None, &allowed))
            .unwrap();
        let at = args.iter().position(|a| a == "--allowedTools").expect("flag");
        assert_eq!(&args[at + 1..at + 3], ["Bash(gh *)", "Bash(npm test)"]);
    }

    #[test]
    fn nothing_approved_adds_no_permission_flag() {
        // An empty `--allowedTools` reads as "allow nothing", which is worse
        // than leaving the CLI on its own default set.
        let args = ClaudeCode
            .chat_stream_args("/tmp/ws", &spec("", None, &[]))
            .unwrap();
        assert!(!args.contains(&"--allowedTools".to_string()));
        // Blank entries are not approvals either.
        let blank = vec!["  ".to_string()];
        let args = ClaudeCode
            .chat_stream_args("/tmp/ws", &spec("", None, &blank))
            .unwrap();
        assert!(!args.contains(&"--allowedTools".to_string()));
    }

    #[test]
    fn a_pattern_that_would_close_the_spec_early_is_dropped() {
        // `Bash(gh pr list)`)` would mean something other than the approval the
        // user gave, so the pattern is refused rather than reinterpreted.
        let allowed = vec!["gh pr) --hack".to_string(), "cargo *".to_string()];
        let args = ClaudeCode
            .chat_stream_args("/tmp/ws", &spec("", None, &allowed))
            .unwrap();
        let at = args.iter().position(|a| a == "--allowedTools").expect("flag");
        assert_eq!(&args[at + 1..], ["Bash(cargo *)"]);
    }

    #[test]
    fn chat_args_without_model_leave_the_cli_default() {
        let args = ClaudeCode.chat_args("/tmp/ws", "").unwrap();
        assert_eq!(
            args.join(" "),
            "-p --permission-mode acceptEdits --output-format text"
        );
    }

    #[test]
    fn parses_a_session_log() {
        let home = temp_home("parse");
        let p = home.join("session.jsonl");
        std::fs::write(&p, FIXTURE).unwrap();
        let run = parse_run(&p).unwrap();
        assert_eq!(run.source, "claude-code");
        assert_eq!(run.title, "fix the login bug");
        assert_eq!(run.model.as_deref(), Some("claude-sonnet-4-6"));
        assert_eq!(run.cwd.as_deref(), Some("/Users/x/proj"));
        assert_eq!(run.project.as_deref(), Some("proj"));
        assert_eq!(run.git_branch.as_deref(), Some("main"));
        assert_eq!(run.created_ms, 1000);
        assert_eq!(run.message_count, 2);
        assert_eq!(run.status, "running", "the last assistant turn requested a tool");
        // Last assistant turn, first line — "what the run last did".
        assert_eq!(run.last_event.as_deref(), Some("On it."));
        // Cache reads excluded, cache creation counted.
        assert_eq!(run.input_tokens, 150);
        assert_eq!(run.output_tokens, 20);
        // The fixture's tool_use has no `input.file_path`, so files_touched
        // stays at 0. The dedicated file-extraction test below exercises
        // the path collection with a real path.
        assert_eq!(run.files_touched, 0);
        // Claude Sonnet 4.6 at 100+50=150 input + 20 output = 0.00045 + 0.0003.
        let c = run.cost_usd.expect("sonnet has a known price");
        assert!((c - 0.00075).abs() < 1e-6, "got {c}");
    }

    #[test]
    fn final_assistant_text_and_result_records_settle_the_turn() {
        let home = temp_home("lifecycle");
        let p = home.join("session.jsonl");
        std::fs::write(
            &p,
            concat!(
                r#"{"type":"user","message":{"content":"finish it"}}"#,
                "\n",
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Done and verified."}]}}"#,
                "\n",
            ),
        )
        .unwrap();
        assert_eq!(parse_run(&p).unwrap().status, "done");

        std::fs::write(&p, format!("{FIXTURE}{FINISHED}\n")).unwrap();
        assert_eq!(
            parse_run(&p).unwrap().status,
            "done",
            "the headless result marker wins over an earlier tool request"
        );
    }

    #[test]
    fn falls_back_to_encoded_project_directory_for_cwd() {
        let home = temp_home("cwd-fallback");
        let workspace = std::env::temp_dir()
            .join("klideclaudecwdfallback")
            .join("workspace");
        let _ = std::fs::remove_dir_all(workspace.parent().unwrap());
        std::fs::create_dir_all(&workspace).unwrap();
        let encoded = workspace.to_string_lossy().replace('/', "-");
        let dir = home.join(".claude/projects").join(encoded);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("session.jsonl");
        std::fs::write(
            &p,
            r#"{"type":"user","ts":1000,"message":{"content":"missing cwd"}}"#,
        )
        .unwrap();

        let run = parse_run(&p).unwrap();

        assert_eq!(run.cwd.as_deref(), workspace.to_str());
        assert_eq!(run.project.as_deref(), Some("workspace"));
        let _ = std::fs::remove_dir_all(workspace.parent().unwrap());
    }

    #[test]
    fn parses_files_touched_from_tool_use_calls() {
        // Each tool_use with a recognised name + file_path key is counted,
        // and the same path is only counted once even if re-touched.
        let home = temp_home("files");
        let p = home.join("session.jsonl");
        std::fs::write(
            &p,
            concat!(
                r#"{"type":"user","ts":1000,"cwd":"/proj","message":{"content":"go"}}"#, "\n",
                r#"{"type":"assistant","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":1,"output_tokens":1},"content":["#,
                r#"{"type":"tool_use","name":"Read","input":{"file_path":"/proj/src/main.rs"}},"#,
                r#"{"type":"tool_use","name":"edit","input":{"file_path":"/proj/src/main.rs"}},"#,
                r#"{"type":"tool_use","name":"write","input":{"file_path":"/proj/Cargo.toml"}},"#,
                r#"{"type":"tool_use","name":"Bash","input":{"command":"ls","file_path":"/proj/src/main.rs"}}"#,
                "]}}\n",
            ),
        )
        .unwrap();
        let run = parse_run(&p).unwrap();
        assert_eq!(
            run.files_touched, 2,
            "Bash should not be counted, dedupe should drop the re-edit"
        );
    }

    #[test]
    fn counts_sub_agents_and_excludes_sidechain_turns() {
        // Two Agent calls in the main transcript = 2 sub-agents. The
        // sidechain assistant turn (the sub-agent's own reply) must not
        // count toward message_count, and an Agent call *inside* a sidechain
        // belongs to the child run, so it doesn't inflate this run's tally.
        let home = temp_home("subagents");
        let p = home.join("session.jsonl");
        std::fs::write(
            &p,
            concat!(
                r#"{"type":"user","ts":1000,"cwd":"/proj","message":{"content":"do two things"}}"#, "\n",
                r#"{"type":"assistant","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":1,"output_tokens":1},"content":[{"type":"tool_use","name":"Agent","input":{}},{"type":"tool_use","name":"Task","input":{}}]}}"#, "\n",
                r#"{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"sub-agent working"},{"type":"tool_use","name":"Agent","input":{}}]}}"#, "\n",
            ),
        )
        .unwrap();
        let run = parse_run(&p).unwrap();
        assert_eq!(
            run.subagent_count, 2,
            "two main-transcript Agent/Task calls"
        );
        assert_eq!(run.message_count, 2, "sidechain assistant turn is excluded");
    }

    #[test]
    fn discovers_jsonl_files_under_projects() {
        let home = temp_home("discover");
        let proj = home.join(".claude/projects/-Users-x-proj");
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::write(proj.join("a.jsonl"), FIXTURE).unwrap();
        std::fs::write(proj.join("ignored.txt"), "x").unwrap();
        let found = ClaudeCode.discover_runs(home.to_str().unwrap());
        assert_eq!(found.len(), 1);
        assert!(found[0].key.ends_with("a.jsonl"));
    }

    #[test]
    fn discovers_subagent_jsonl_files_under_parent_sessions() {
        let home = temp_home("discover-subagents");
        let proj = home.join(".claude/projects/-Users-x-proj");
        let subagents = proj.join("parent-123/subagents");
        std::fs::create_dir_all(&subagents).unwrap();
        std::fs::write(proj.join("parent-123.jsonl"), FIXTURE).unwrap();
        std::fs::write(subagents.join("agent-a1.jsonl"), FIXTURE).unwrap();
        std::fs::write(subagents.join("ignored.txt"), "x").unwrap();

        let mut keys: Vec<String> = ClaudeCode
            .discover_runs(home.to_str().unwrap())
            .into_iter()
            .map(|c| c.key)
            .collect();
        keys.sort();

        assert_eq!(keys.len(), 2);
        assert!(keys.iter().any(|k| k.ends_with("parent-123.jsonl")));
        assert!(keys
            .iter()
            .any(|k| k.ends_with("parent-123/subagents/agent-a1.jsonl")));
    }

    #[test]
    fn parses_subagent_log_as_child_run() {
        let home = temp_home("parse-subagent");
        let subagents = home.join(".claude/projects/-Users-x-proj/parent-123/subagents");
        std::fs::create_dir_all(&subagents).unwrap();
        let p = subagents.join("agent-a1.jsonl");
        std::fs::write(
            &p,
            concat!(
                r#"{"type":"user","isSidechain":true,"timestamp":"2026-06-23T09:15:22.629Z","cwd":"/Users/x/proj","message":{"content":"Explore the harness\nwith details"}}"#, "\n",
                r#"{"type":"assistant","isSidechain":true,"message":{"model":"claude-haiku-4-5","usage":{"input_tokens":3,"output_tokens":5},"content":[{"type":"text","text":"Mapped the terrain."}]}}"#, "\n",
            ),
        )
        .unwrap();

        let run = parse_run(&p).unwrap();

        assert_eq!(run.id, "agent-a1");
        assert_eq!(run.parent_id.as_deref(), Some("parent-123"));
        assert_eq!(run.title, "Explore the harness");
        assert_eq!(run.message_count, 2);
        assert_eq!(run.model.as_deref(), Some("claude-haiku-4-5"));
        assert_eq!(run.cwd.as_deref(), Some("/Users/x/proj"));
        assert_eq!(run.last_event.as_deref(), Some("Mapped the terrain."));
    }

    #[test]
    fn read_run_keeps_the_back_and_forth_only() {
        let home = temp_home("read");
        let p = home.join("session.jsonl");
        std::fs::write(&p, FIXTURE).unwrap();
        let msgs = ClaudeCode.read_run("", p.to_str().unwrap()).unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[1].text, "On it.");
        assert_eq!(msgs[1].tools.len(), 1);
        assert_eq!(msgs[1].tools[0].name, "read_file");
    }

    #[test]
    fn read_run_recovers_images_and_drops_the_source_breadcrumb() {
        let home = temp_home("images");
        let p = home.join("session.jsonl");
        let fixture = concat!(
            r#"{"type":"user","message":{"content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo="}},{"type":"text","text":"[Image #1] make it blue"},{"type":"text","text":"[Image: source: /Users/x/.claude/image-cache/s/1.png]"}]}}"#,
            "\n",
        );
        std::fs::write(&p, fixture).unwrap();
        let msgs = ClaudeCode.read_run("", p.to_str().unwrap()).unwrap();
        assert_eq!(msgs.len(), 1);
        // The instruction survives; the "[Image: source: …]" breadcrumb is dropped.
        assert_eq!(msgs[0].text, "[Image #1] make it blue");
        // The base64 image becomes a self-contained data URI.
        assert_eq!(msgs[0].images.len(), 1);
        assert!(msgs[0].images[0].starts_with("data:image/png;base64,iVBORw0KGgo="));
    }
}
