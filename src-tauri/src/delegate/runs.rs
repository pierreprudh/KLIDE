// Run records and shared parsing helpers for the Delegate seam.
//
// Mission Control reads the local session logs that delegate CLIs leave on
// disk, so Klide can show your real recent runs across tools in one board:
//   • Claude Code → ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
//   • Codex       → ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
//                   (+ ~/.codex/session_index.jsonl for human thread names)
//   • OpenCode    → SQLite at ~/.local/share/opencode/opencode.db
// Read-only: we never write to those files. Each adapter owns its own
// format; what's shared lives here.

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRun {
    pub id: String,
    pub path: String, // absolute path to the session log, for reading its transcript
    pub source: String, // "claude-code" | "codex" | "opencode"
    pub title: String,
    pub model: Option<String>,
    pub cwd: Option<String>,
    pub project: Option<String>, // last path segment of cwd
    pub git_branch: Option<String>,
    pub created_ms: i64, // 0 if unknown (external tools may not store creation time)
    pub updated_ms: i64,
    pub message_count: u32,
    // Real token usage summed from the session log (0 when the source doesn't
    // record usage). Input excludes cache reads — they'd dwarf everything else.
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub status: String, // "running" (touched <2min ago) | "done"
    /// Count of unique file paths the agent touched in tool calls (Read,
    /// Edit, Write, apply_patch, etc.). 0 when the source doesn't record
    /// tool calls or the session had no file-touching tools.
    pub files_touched: u32,
    /// Estimated run cost in USD, computed from input/output tokens and the
    /// per-model price table in `crate::pricing`. `None` for local,
    /// subscription, passthrough, or unknown models.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    /// Number of sub-agents this run spawned, counted from the transcript's
    /// own tool calls (Claude's `Agent` / `Task` tool). 0 when the source
    /// doesn't expose sub-agent calls or none ran. Distinct from `parent_id`,
    /// which links a run to a *separate* parent session; here the sub-agents
    /// live inside this run's own log, so we surface a count rather than rows.
    pub subagent_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>, // set when we can infer parent from spawn mapping
}

// One readable line of a run's conversation, for the Mission Control detail
// pane. We strip system/context wrappers and tool plumbing so what shows is the
// actual back-and-forth (a "résumé" of the session).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunMessage {
    pub role: String, // "user" | "assistant"
    pub text: String,
}

/// A run a delegate left on disk, before parsing: just enough to sort and
/// page. `key` is whatever the adapter's parser needs to find the run again —
/// a file path for the JSONL CLIs, a session id for OpenCode.
pub struct RunCandidate {
    pub key: String,
    pub mtime_ms: i64,
}

pub(crate) fn mtime_ms(path: &std::path::Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn project_name(cwd: &str) -> Option<String> {
    std::path::Path::new(cwd)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
}

pub(crate) fn clean_title(s: &str) -> String {
    let one = s.split('\n').next().unwrap_or(s).trim();
    one.chars().take(120).collect()
}

pub(crate) fn recency_status(updated_ms: i64) -> String {
    if now_ms() - updated_ms < 120_000 {
        "running".to_string()
    } else {
        "done".to_string()
    }
}

// The first genuine user prompt becomes the run's title. Skips system/tool
// wrappers (content that begins with "<", e.g. "<command-name>…").
pub(crate) fn extract_user_text(message: &serde_json::Value) -> Option<String> {
    let content = message.get("content")?;
    if let Some(s) = content.as_str() {
        let t = s.trim();
        return if !t.is_empty() && !t.starts_with('<') {
            Some(t.to_string())
        } else {
            None
        };
    }
    if let Some(arr) = content.as_array() {
        for part in arr {
            if part.get("type").and_then(|v| v.as_str()) == Some("text") {
                if let Some(t) = part.get("text").and_then(|v| v.as_str()) {
                    let t = t.trim();
                    if !t.is_empty() && !t.starts_with('<') {
                        return Some(t.to_string());
                    }
                }
            }
        }
    }
    None
}

/// Heuristic: does this tool name + argument blob look like a file path the
/// agent touched? Returns the path if so, `None` otherwise. Conservative —
/// we only flag tools whose argument shape is unambiguous across the
/// providers we read from (Claude Code, Codex, OpenCode). Tools with fuzzy
/// argument shapes (Bash, shell_command, grep_files, apply_patch) are
/// intentionally skipped: matching them would either over-count or require
/// a per-tool parser we don't want to maintain here.
pub(crate) fn tool_file_path(name: &str, args: &serde_json::Value) -> Option<String> {
    // Recognise the canonical file-touching tool names. Case-insensitive to
    // survive provider / wire-format variations ("Read" vs "read" vs
    // "read_file"). Anything else returns None — we don't try to second-guess
    // tools we don't know.
    let n = name.to_ascii_lowercase();
    let is_file_tool = matches!(
        n.as_str(),
        "read"
            | "read_file"
            | "write"
            | "write_file"
            | "create_file"
            | "edit"
            | "edit_file"
            | "str_replace"
            | "str_replace_based_edit_tool"
            | "multi_edit"
            | "multiedit"
            | "notebookedit"
            | "notebook_edit"
    );
    if !is_file_tool {
        return None;
    }
    // The path key varies by tool: Read/Write/Edit use `file_path`, OpenCode
    // tools use `filePath`, some pass `path`. Try them in order.
    let raw = args
        .get("file_path")
        .or_else(|| args.get("filePath"))
        .or_else(|| args.get("filepath"))
        .or_else(|| args.get("path"))?;
    let trimmed = raw.as_str()?.trim();
    if trimmed.is_empty() {
        return None;
    }
    // A real file path has a separator. Reject bare words like "foo" or
    // glob patterns like "**/*.ts" that some grep tools use — those aren't
    // a single file the agent read.
    if !(trimmed.contains('/') || trimmed.contains('\\')) {
        return None;
    }
    Some(trimmed.to_string())
}

/// Bound a detail-pane payload: trim long messages, keep the most recent ~80.
pub(crate) fn cap_messages(msgs: &mut Vec<RunMessage>) {
    for m in msgs.iter_mut() {
        if m.text.chars().count() > 4000 {
            m.text = m.text.chars().take(4000).collect::<String>() + "…";
        }
    }
    let len = msgs.len();
    if len > 80 {
        msgs.drain(0..len - 80);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_title_takes_first_line_capped() {
        let long = format!("{}\nsecond line", "x".repeat(200));
        let t = clean_title(&long);
        assert_eq!(t.chars().count(), 120);
        assert!(!t.contains('\n'));
    }

    #[test]
    fn user_text_skips_command_wrappers() {
        let wrapped = serde_json::json!({ "content": "<command-name>/clear</command-name>" });
        assert_eq!(extract_user_text(&wrapped), None);
        let plain = serde_json::json!({ "content": [{ "type": "text", "text": " fix it " }] });
        assert_eq!(extract_user_text(&plain).as_deref(), Some("fix it"));
    }

    #[test]
    fn tool_file_path_recognises_known_file_tools() {
        // Canonical snake_case keys.
        assert_eq!(
            tool_file_path("read", &serde_json::json!({ "file_path": "/src/a.rs" })),
            Some("/src/a.rs".to_string())
        );
        assert_eq!(
            tool_file_path("edit", &serde_json::json!({ "file_path": "src/b.ts" })),
            Some("src/b.ts".to_string())
        );
        // camelCase (OpenCode).
        assert_eq!(
            tool_file_path("read", &serde_json::json!({ "filePath": "x/y.md" })),
            Some("x/y.md".to_string())
        );
        // Bare `path` key (some Codex tools).
        assert_eq!(
            tool_file_path("write", &serde_json::json!({ "path": "./out.txt" })),
            Some("./out.txt".to_string())
        );
    }

    #[test]
    fn tool_file_path_rejects_unknown_tools_and_bad_values() {
        // Bash, shell_command, apply_patch — too ambiguous to count.
        assert_eq!(tool_file_path("bash", &serde_json::json!({ "file_path": "/a" })), None);
        assert_eq!(tool_file_path("shell_command", &serde_json::json!({ "file_path": "/a" })), None);
        assert_eq!(tool_file_path("apply_patch", &serde_json::json!({ "file_path": "/a" })), None);
        // No path key.
        assert_eq!(tool_file_path("read", &serde_json::json!({ "limit": 10 })), None);
        // Empty / whitespace path.
        assert_eq!(tool_file_path("read", &serde_json::json!({ "file_path": "" })), None);
        assert_eq!(tool_file_path("read", &serde_json::json!({ "file_path": "   " })), None);
        // Bare word without a separator (looks like a glob, not a file).
        assert_eq!(tool_file_path("read", &serde_json::json!({ "file_path": "foo" })), None);
    }

    #[test]
    fn cap_messages_trims_and_keeps_recent_80() {
        let mut msgs: Vec<RunMessage> = (0..100)
            .map(|i| RunMessage {
                role: "user".into(),
                text: format!("m{i}"),
            })
            .collect();
        msgs[99].text = "y".repeat(5000);
        cap_messages(&mut msgs);
        assert_eq!(msgs.len(), 80);
        assert_eq!(msgs[0].text, "m20");
        assert_eq!(msgs[79].text.chars().count(), 4001); // 4000 + ellipsis
    }
}
