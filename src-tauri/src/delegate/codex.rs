use super::runs::{
    cap_messages, clean_title, mtime_ms, project_name, recency_status, tool_file_path,
};
use super::{shell_quote, AgentRun, Delegate, RunCandidate, RunMessage, RunParser};
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

    /// Codex has no hooks, but its `notify` program covers turn ends and
    /// approvals — Klide's shim posts those (see status.rs).
    fn ensure_status_hooks(&self, home: &str) -> Result<bool, String> {
        super::status::install_codex_hooks(home)
    }

    fn model_arg(&self, model: &str) -> String {
        format!(" -m {}", shell_quote(model))
    }

    fn resume_arg(&self, session_id: &str) -> String {
        format!(" resume {}", shell_quote(session_id))
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

    fn discover_runs(&self, home: &str) -> Vec<RunCandidate> {
        let root = std::path::Path::new(home).join(".codex/sessions");
        let mut files = Vec::new();
        collect_rollouts(&root, &mut files);
        files
            .into_iter()
            .map(|p| RunCandidate {
                mtime_ms: mtime_ms(&p),
                key: p.to_string_lossy().to_string(),
            })
            .collect()
    }

    fn run_parser(&self, home: &str) -> Box<dyn RunParser> {
        Box::new(CodexRunParser {
            index: load_index(home),
        })
    }

    fn read_run(&self, _home: &str, key: &str) -> Result<Vec<RunMessage>, String> {
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
                    if p.get("type").and_then(|t| t.as_str()) == Some("function_call") {
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
                    if p.get("type").and_then(|t| t.as_str()) == Some("message")
                        && p.get("role").and_then(|r| r.as_str()) == Some("assistant")
                    {
                        if let Some(t) = message_text(p) {
                            last_event = Some(clean_title(&t));
                        }
                    }
                }
            }
            Some("event_msg") => {
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
        crate::pricing::cost_for_run(model.as_deref().unwrap_or(""), input_tokens, output_tokens);
    Some(AgentRun {
        status: recency_status(updated_ms),
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

fn load_index(home: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let path = std::path::Path::new(home).join(".codex/session_index.jsonl");
    if let Ok(content) = std::fs::read_to_string(&path) {
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

#[cfg(test)]
mod tests {
    use super::*;

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
        // gpt-5.4 at 600 input + 55 output = 0.0015 + 0.00055.
        let c = run.cost_usd.expect("gpt-5.4 has a known price");
        assert!((c - 0.00205).abs() < 1e-6, "got {c}");
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
        let found = Codex.discover_runs(home.to_str().unwrap());
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
        let msgs = Codex.read_run("", p.to_str().unwrap()).unwrap();
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
        let map = load_index(home.to_str().unwrap());
        assert_eq!(map.get("sess-1").map(String::as_str), Some("My thread"));
    }
}
