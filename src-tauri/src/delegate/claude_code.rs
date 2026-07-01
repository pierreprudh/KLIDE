use super::runs::{
    cap_messages, clean_title, extract_user_text, mtime_ms, project_name, recency_status,
    tool_file_path, AgentRun, RunMessage, RunToolCall,
};
use super::{shell_quote, Delegate, RunCandidate, RunParser};
use std::collections::HashSet;

/// Claude Code — Anthropic's CLI. Its TUI accepts the task as the first
/// positional arg directly, so no subcommand is needed. Sessions land in
/// `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`.
pub struct ClaudeCode;

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

    fn resume_arg(&self, session_id: &str) -> String {
        format!(" --resume {}", shell_quote(session_id))
    }

    /// Headless: `-p` reads the prompt from stdin and prints the answer.
    /// `acceptEdits` lets Goal-mode runs touch files without an interactive
    /// permission prompt nobody is there to answer.
    fn chat_args(&self, _cwd: &str, model: &str) -> Result<Vec<String>, String> {
        Ok(vec![
            "-p".into(),
            "--model".into(),
            model.into(),
            "--permission-mode".into(),
            "acceptEdits".into(),
            "--output-format".into(),
            "text".into(),
        ])
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
        let content = std::fs::read_to_string(key).map_err(|e| e.to_string())?;
        let mut msgs: Vec<RunMessage> = Vec::new();
        for line in content.lines() {
            let v: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let role = match v.get("type").and_then(|t| t.as_str()) {
                Some("user") => "user",
                Some("assistant") => "assistant",
                _ => continue,
            };
            if let Some((text, tools)) = v.get("message").and_then(message_text) {
                msgs.push(RunMessage {
                    role: role.to_string(),
                    text,
                    tools,
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

fn parse_run(path: &std::path::Path) -> Option<AgentRun> {
    let content = std::fs::read_to_string(path).ok()?;
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
    for line in content.lines() {
        let v: serde_json::Value = match serde_json::from_str(line) {
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
            Some("user") => {
                if counts_as_main {
                    count += 1;
                    if title.is_none() {
                        if let Some(t) = v.get("message").and_then(extract_user_text) {
                            title = Some(clean_title(&t));
                        }
                    }
                }
            }
            Some("assistant") => {
                if counts_as_main {
                    count += 1;
                    // Newest assistant turn wins — "what the run last did".
                    if let Some((t, _)) = v.get("message").and_then(message_text) {
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
            _ => {}
        }
    }
    let updated_ms = mtime_ms(path);
    if created_ms == 0 {
        created_ms = updated_ms;
    }
    let cost_usd =
        crate::pricing::cost_for_run(model.as_deref().unwrap_or(""), input_tokens, output_tokens);
    Some(AgentRun {
        status: recency_status(updated_ms),
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

// Walk a message's content into readable text plus structured tool calls: text
// parts concatenate; tool_use parts become structured RunToolCall entries (no
// longer folded into the text as "[tool: <name>]"). Thinking / tool_result
// noise is dropped — it has no place in a résumé view. Returns None only when
// there is neither text nor a tool call to show.
fn message_text(message: &serde_json::Value) -> Option<(String, Vec<RunToolCall>)> {
    let content = message.get("content")?;
    if let Some(s) = content.as_str() {
        let t = s.trim();
        return if t.is_empty() || t.starts_with('<') {
            None
        } else {
            Some((t.to_string(), vec![]))
        };
    }
    if let Some(arr) = content.as_array() {
        let mut buf = String::new();
        let mut tools: Vec<RunToolCall> = Vec::new();
        for part in arr {
            match part.get("type").and_then(|t| t.as_str()) {
                Some("text") => {
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
                Some("tool_use") => {
                    let name = part.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                    tools.push(RunToolCall {
                        name: name.to_string(),
                        summary: None,
                    });
                }
                _ => {}
            }
        }
        let t = buf.trim().to_string();
        if !t.is_empty() || !tools.is_empty() {
            return Some((t, tools));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
