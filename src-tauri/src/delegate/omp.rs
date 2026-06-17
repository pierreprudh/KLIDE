use super::runs::{
    cap_messages, clean_title, extract_user_text, mtime_ms, project_name, recency_status,
    tool_file_path, AgentRun, RunMessage,
};
use super::{shell_quote, Delegate, RunCandidate, RunParser};
use std::collections::HashSet;

/// Oh My Pi (`omp`) — a terminal coding agent with IDE-grade tooling (LSP,
/// subagents, 40+ providers). Its TUI accepts the task as the first positional
/// arg directly, so no subcommand is needed; resuming is the `--resume <id>`
/// flag (ID prefix, path, or picker). Sessions land in
/// `~/.omp/agent/sessions/<encoded-cwd>/<iso-ts>_<session-uuid>.jsonl`, one
/// JSON object per line, Anthropic-shaped content blocks. Each assistant line
/// carries its own `usage` block — including omp's own cost accounting across
/// the many providers it routes to.
pub struct Omp;

impl Delegate for Omp {
    fn id(&self) -> &'static str {
        "omp"
    }

    fn binary(&self) -> &'static str {
        "omp"
    }

    fn model_arg(&self, model: &str) -> String {
        format!(" --model {}", shell_quote(model))
    }

    fn resume_arg(&self, session_id: &str) -> String {
        format!(" --resume {}", shell_quote(session_id))
    }

    /// Headless: `-p` processes the prompt and exits, printing plain text.
    /// `--auto-approve` lets Goal-mode runs touch files without an interactive
    /// permission prompt nobody is there to answer (mirrors Claude's
    /// `acceptEdits` and Codex's `workspace-write`). The cwd rides in via the
    /// trait's `chat_invocation`, which sets the child's working directory.
    fn chat_args(&self, _cwd: &str, model: &str) -> Result<Vec<String>, String> {
        Ok(vec![
            "-p".into(),
            "--model".into(),
            model.into(),
            "--auto-approve".into(),
            "--mode".into(),
            "text".into(),
        ])
    }

    fn discover_runs(&self, home: &str) -> Vec<RunCandidate> {
        let mut out = Vec::new();
        let root = std::path::Path::new(home).join(".omp/agent/sessions");
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
                        }
                    }
                }
            }
        }
        out
    }

    fn run_parser(&self, _home: &str) -> Box<dyn RunParser> {
        Box::new(OmpRunParser)
    }

    fn read_run(&self, _home: &str, key: &str) -> Result<Vec<RunMessage>, String> {
        let content = std::fs::read_to_string(key).map_err(|e| e.to_string())?;
        let mut msgs: Vec<RunMessage> = Vec::new();
        for line in content.lines() {
            let v: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if v.get("type").and_then(|t| t.as_str()) != Some("message") {
                continue;
            }
            let message = match v.get("message") {
                Some(m) => m,
                None => continue,
            };
            let role = match message.get("role").and_then(|r| r.as_str()) {
                Some("user") => "user",
                Some("assistant") => "assistant",
                _ => continue,
            };
            if let Some(text) = message_text(message) {
                if role == "user" && text.starts_with('<') {
                    continue; // environment / context wrappers
                }
                msgs.push(RunMessage {
                    role: role.to_string(),
                    text,
                });
            }
        }
        cap_messages(&mut msgs);
        Ok(msgs)
    }
}

struct OmpRunParser;

impl RunParser for OmpRunParser {
    fn parse(&self, key: &str) -> Option<AgentRun> {
        parse_run(std::path::Path::new(key))
    }
}

fn parse_run(path: &std::path::Path) -> Option<AgentRun> {
    let content = std::fs::read_to_string(path).ok()?;
    let (mut id, mut title, mut model, mut cwd) = (None, None, None, None);
    let mut count: u32 = 0;
    let mut created_ms: i64 = 0;
    let (mut input_tokens, mut output_tokens): (i64, i64) = (0, 0);
    let mut cost_sum: f64 = 0.0;
    let mut files: HashSet<String> = HashSet::new();
    let mut last_event: Option<String> = None;
    for line in content.lines() {
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        match v.get("type").and_then(|t| t.as_str()) {
            // The opening `session` record carries the id, cwd, and creation
            // time (ISO 8601). Everything else is a child of it.
            Some("session") => {
                if id.is_none() {
                    id = v.get("id").and_then(|x| x.as_str()).map(str::to_string);
                }
                if cwd.is_none() {
                    cwd = v.get("cwd").and_then(|c| c.as_str()).map(str::to_string);
                }
                if created_ms == 0 {
                    created_ms = v
                        .get("timestamp")
                        .and_then(|t| t.as_str())
                        .and_then(iso_to_ms)
                        .unwrap_or(0);
                }
            }
            // `--model` switches mid-session are logged; the first one is the
            // model the run started on.
            Some("model_change") if model.is_none() => {
                model = v.get("model").and_then(|m| m.as_str()).map(str::to_string);
            }
            Some("message") => {
                let message = match v.get("message") {
                    Some(m) => m,
                    None => continue,
                };
                let role = message.get("role").and_then(|r| r.as_str()).unwrap_or("");
                count += 1;
                if role == "user" && title.is_none() {
                    if let Some(t) = extract_user_text(message) {
                        title = Some(clean_title(&t));
                    }
                }
                if role == "assistant" {
                    // Newest assistant turn wins — "what the run last did".
                    if let Some(t) = message_text(message) {
                        last_event = Some(clean_title(&t));
                    }
                    if model.is_none() {
                        model = message
                            .get("model")
                            .and_then(|m| m.as_str())
                            .map(str::to_string);
                    }
                    // Each assistant line carries that turn's usage. Cache
                    // *reads* are excluded (re-reads of the same prefix);
                    // cache *writes* are genuine new input so they count —
                    // mirroring the Claude parser. omp also records its own
                    // cost across the providers it routes to; sum it.
                    if let Some(u) = message.get("usage") {
                        let n = |key: &str| u.get(key).and_then(|x| x.as_i64()).unwrap_or(0);
                        input_tokens += n("input") + n("cacheWrite");
                        output_tokens += n("output");
                        cost_sum += u
                            .get("cost")
                            .and_then(|c| c.get("total"))
                            .and_then(|x| x.as_f64())
                            .unwrap_or(0.0);
                    }
                    // Walk the assistant content for tool_use parts and record
                    // every file the agent touched (deduped by path string).
                    // omp uses Anthropic-shaped blocks: `tool_use` with `name`
                    // and `input`, the same shape the shared helper expects.
                    if let Some(arr) = message.get("content").and_then(|c| c.as_array()) {
                        for part in arr {
                            if part.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                                let name = part.get("name").and_then(|n| n.as_str()).unwrap_or("");
                                let input = part.get("input").unwrap_or(&serde_json::Value::Null);
                                if let Some(p) = tool_file_path(name, input) {
                                    files.insert(p);
                                }
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
    let id = id.unwrap_or_else(|| {
        // Filename is `<iso-ts>_<session-uuid>` — the uuid after the last
        // underscore is the resumable session id.
        let stem = path.file_stem().map(|s| s.to_string_lossy().to_string());
        stem.as_deref()
            .and_then(|s| s.rsplit('_').next())
            .map(str::to_string)
            .or(stem)
            .unwrap_or_default()
    });
    // Prefer omp's own recorded cost (accurate across its 40+ providers); fall
    // back to Klide's price table when the session logged no cost (e.g. local
    // models, which are free either way).
    let cost_usd = if cost_sum > 0.0 {
        Some(cost_sum)
    } else {
        crate::pricing::cost_for_run(model.as_deref().unwrap_or(""), input_tokens, output_tokens)
    };
    Some(AgentRun {
        status: recency_status(updated_ms),
        project: cwd.as_deref().and_then(project_name),
        id,
        path: path.to_string_lossy().to_string(),
        source: "omp".to_string(),
        title: title.unwrap_or_else(|| "omp session".to_string()),
        model,
        cwd,
        git_branch: None, // omp's session record doesn't store the git branch
        created_ms,
        updated_ms,
        message_count: count,
        input_tokens,
        output_tokens,
        files_touched: files.len() as u32,
        cost_usd,
        subagent_count: 0, // omp's session record doesn't expose sub-agent calls.
        last_event,
        parent_id: None,
    })
}

/// Parse an ISO 8601 / RFC 3339 timestamp (e.g. "2026-06-15T13:28:06.376Z")
/// into epoch milliseconds. Returns None if it doesn't parse.
fn iso_to_ms(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

// Walk a message's content into a single readable string: text parts
// concatenate, tool_use parts collapse to a one-line "[tool: <name>]".
// Thinking / tool_result noise is dropped — it has no place in a résumé view.
fn message_text(message: &serde_json::Value) -> Option<String> {
    let content = message.get("content")?;
    if let Some(s) = content.as_str() {
        let t = s.trim();
        return if t.is_empty() || t.starts_with('<') {
            None
        } else {
            Some(t.to_string())
        };
    }
    if let Some(arr) = content.as_array() {
        let mut buf = String::new();
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
                    if !buf.is_empty() {
                        buf.push('\n');
                    }
                    buf.push_str(&format!("[tool: {name}]"));
                }
                _ => {}
            }
        }
        let t = buf.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("klide-delegate-test-omp-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // A real (trimmed) omp session: session header, a model change, a user
    // message, and an assistant reply carrying usage + a tool_use.
    const FIXTURE: &str = concat!(
        r#"{"type":"session","version":3,"id":"019ecb77-cbe7-7000","timestamp":"2026-06-15T13:28:06.376Z","cwd":"/Users/x/proj"}"#,
        "\n",
        r#"{"type":"model_change","model":"claude-sonnet-4-6","timestamp":"2026-06-15T13:28:06.400Z"}"#,
        "\n",
        r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"fix the login bug"}]}}"#,
        "\n",
        r#"{"type":"message","message":{"role":"assistant","model":"claude-sonnet-4-6","content":[{"type":"text","text":"On it."},{"type":"tool_use","name":"read","input":{"file_path":"/Users/x/proj/src/auth.rs"}}],"usage":{"input":100,"output":20,"cacheRead":9000,"cacheWrite":50,"cost":{"total":0.0025}}}}"#,
        "\n",
        r#"not json"#,
        "\n",
    );

    #[test]
    fn dispatch_and_resume_command_strings() {
        let dispatch = Omp.spawn_command(Some("fix the bug"), Some("opus"), None);
        assert_eq!(dispatch, "omp --model 'opus' 'fix the bug'");
        let resume = Omp.spawn_command(None, None, Some("019ecb77"));
        assert_eq!(resume, "omp --resume '019ecb77'");
    }

    #[test]
    fn chat_args_run_headless_with_auto_approve() {
        let args = Omp.chat_args("/tmp/ws", "claude-sonnet-4-6").unwrap();
        assert_eq!(
            args.join(" "),
            "-p --model claude-sonnet-4-6 --auto-approve --mode text"
        );
    }

    #[test]
    fn parses_a_session_log() {
        let home = temp_home("parse");
        let p = home.join("2026-06-15T13-28-06_019ecb77.jsonl");
        std::fs::write(&p, FIXTURE).unwrap();
        let run = parse_run(&p).unwrap();
        assert_eq!(run.source, "omp");
        assert_eq!(run.id, "019ecb77-cbe7-7000"); // from the session line, not the filename
        assert_eq!(run.title, "fix the login bug");
        assert_eq!(run.model.as_deref(), Some("claude-sonnet-4-6"));
        assert_eq!(run.cwd.as_deref(), Some("/Users/x/proj"));
        assert_eq!(run.project.as_deref(), Some("proj"));
        assert_eq!(run.created_ms, 1781530086376); // ISO parsed to epoch ms
        assert_eq!(run.message_count, 2);
        // input (100) + cacheWrite (50); cacheRead excluded. output = 20.
        assert_eq!(run.input_tokens, 150);
        assert_eq!(run.output_tokens, 20);
        // omp's own recorded cost wins over the price-table estimate.
        let c = run.cost_usd.expect("session recorded a cost");
        assert!((c - 0.0025).abs() < 1e-9, "got {c}");
        // One file touched via the tool_use block.
        assert_eq!(run.files_touched, 1);
    }

    #[test]
    fn local_model_run_falls_back_to_no_cost() {
        // An Ollama run logs cost.total = 0; with no price-table entry the run
        // shows no cost rather than a bogus zero.
        let home = temp_home("local");
        let p = home.join("s.jsonl");
        std::fs::write(
            &p,
            concat!(
                r#"{"type":"session","id":"s1","timestamp":"2026-06-15T13:28:06.376Z","cwd":"/proj"}"#, "\n",
                r#"{"type":"message","message":{"role":"assistant","model":"llama3.1:8b","content":[{"type":"text","text":"hi"}],"usage":{"input":10,"output":2,"cost":{"total":0}}}}"#, "\n",
            ),
        )
        .unwrap();
        let run = parse_run(&p).unwrap();
        assert_eq!(run.model.as_deref(), Some("llama3.1:8b"));
        assert!(run.cost_usd.is_none(), "local model has no cost");
    }

    #[test]
    fn discovers_jsonl_under_encoded_cwd_dirs() {
        let home = temp_home("discover");
        let proj = home.join(".omp/agent/sessions/--Users-x-proj--");
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::write(proj.join("a.jsonl"), FIXTURE).unwrap();
        std::fs::write(proj.join("session.json"), "x").unwrap();
        let found = Omp.discover_runs(home.to_str().unwrap());
        assert_eq!(found.len(), 1);
        assert!(found[0].key.ends_with("a.jsonl"));
    }

    #[test]
    fn read_run_keeps_the_back_and_forth_only() {
        let home = temp_home("read");
        let p = home.join("s.jsonl");
        std::fs::write(&p, FIXTURE).unwrap();
        let msgs = Omp.read_run("", p.to_str().unwrap()).unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].text, "fix the login bug");
        assert_eq!(msgs[1].text, "On it.\n[tool: read]");
    }
}
