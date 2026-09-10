use super::runs::{
    cap_messages, clean_title, project_name, tool_file_path, transcript_status, RunToolCall,
    TranscriptState,
};
use super::chat_stream::{result_text, StreamItem};
use super::{shell_quote, AgentRun, ChatSpec, Delegate, McpServerSpec, McpWiring, RunCandidate, RunMessage, RunParser};
use std::collections::HashSet;

/// OpenCode — the SST CLI. The quirkiest of the three:
///
/// - Its TUI treats the first positional arg as a project path
///   (`opencode [project]`), not a prompt — so `opencode '<task>'` tries to
///   cd into `<cwd>/<task>` and dies. The `run` subcommand is the
///   non-interactive mode that *does* take a message.
/// - `run` is only injected when we're actually feeding it a message —
///   without one the CLI errors with "You must provide a message or a
///   command". In resume mode or with no task we use the bare TUI so the
///   user can interact.
/// - Resume is `-s <session-id>`: the positional `[project]` arg is ignored
///   when -s is set, so the TUI comes up in the run's cwd with that
///   session's history loaded.
/// - It announces its own session id on startup, which Mission Control needs
///   to link the run back to its parent.
/// - History lives in SQLite (opencode.db), not JSONL — three tables we care
///   about: `session` (one row per run), `message` (user/assistant turns),
///   and `part` (text/tool fragments per message). The CLI's `opencode
///   session list` only emits a text table with no timestamps, so we read
///   the DB directly, SQLITE_OPEN_READ_ONLY — never write to it.
pub struct OpenCode;

impl Delegate for OpenCode {
    fn id(&self) -> &'static str {
        "opencode"
    }

    fn binary(&self) -> &'static str {
        "opencode"
    }

    /// OpenCode loads JS plugins — Klide drops a status plugin into
    /// `~/.config/opencode/plugin/` (see status.rs).
    fn ensure_status_hooks(&self, home: &str) -> Result<bool, String> {
        super::status::install_opencode_hooks(home)
    }

    fn spawn_prefix(&self, has_task: bool, resuming: bool) -> String {
        if has_task && !resuming {
            format!("{} run", self.binary())
        } else {
            self.binary().to_string()
        }
    }

    fn model_arg(&self, model: &str) -> String {
        format!(" -m {}", shell_quote(model))
    }

    /// OpenCode has no per-invocation MCP flag; `OPENCODE_CONFIG` names an
    /// extra config file merged over the user's, so the server rides in a
    /// per-session file and the env var, not in `~/.config/opencode`.
    fn mcp_wiring(&self, spec: &McpServerSpec) -> Option<McpWiring> {
        let path = format!("{}/{}.opencode.json", spec.config_dir, spec.file_stem);
        let mut command = vec![spec.command.clone()];
        command.extend(spec.args.iter().cloned());
        let content = serde_json::json!({
            "$schema": "https://opencode.ai/config.json",
            "mcp": {
                "klide": {
                    "type": "local",
                    "command": command,
                    "environment": spec.env_json(),
                    "enabled": true,
                }
            }
        });
        Some(McpWiring {
            flags: String::new(),
            env: vec![("OPENCODE_CONFIG".to_string(), path.clone())],
            files: vec![(path, content.to_string())],
        })
    }

    fn resume_arg(&self, session_id: &str) -> String {
        format!(" -s {}", shell_quote(session_id))
    }

    fn mission_command(&self, task: Option<&str>, model: Option<&str>) -> Result<String, String> {
        let task = self.mission_task(task)?;
        let model_arg = self.mission_model_arg(model);
        Ok(format!("opencode run{model_arg} {}", shell_quote(task)))
    }

    /// `opencode run` with no message argument reads the prompt from stdin and
    /// exits — so OpenCode does have a headless mode after all. This used to
    /// return an error ("interactive PTY delegate only"), which was invisible
    /// while Focus filtered delegates out of its picker and became a failed turn
    /// the moment it stopped.
    ///
    /// Note `-p` is NOT the print flag here — for OpenCode it is `--password`.
    /// `--auto` is the permission posture the other adapters already take
    /// (Claude Code's `acceptEdits`, Codex's `workspace-write`): a headless turn
    /// has no terminal to approve anything in.
    fn chat_args(&self, _cwd: &str, model: &str) -> Result<Vec<String>, String> {
        let mut args: Vec<String> = vec!["run".into()];
        if !model.is_empty() {
            args.extend(["--model".into(), model.into()]);
        }
        args.push("--auto".into());
        Ok(args)
    }

    /// `--format json` puts structured events on stdout — which is also what
    /// stops a turn reading as a wall of `stderr:` chrome, since the human
    /// format writes its banner, its `→ Read README.md` progress and the full
    /// output of every command it runs to stderr.
    /// `spec.allowed_commands` is not used: `chat_args` already passes
    /// `--auto`, so OpenCode approves its own tool calls and has nothing to
    /// carry an allowlist into.
    fn chat_stream_args(&self, cwd: &str, spec: &ChatSpec) -> Option<Vec<String>> {
        let mut args = self.chat_args(cwd, spec.model).ok()?;
        args.extend(["--format".to_string(), "json".to_string()]);
        // `-s <id>` continues an existing session (`--continue` would take the
        // last one, which is the wrong session as soon as two conversations run
        // side by side). Named explicitly, so a second Focus thread never
        // resumes the first one's work.
        if let Some(session) = spec.resume.map(str::trim).filter(|s| !s.is_empty()) {
            args.extend(["-s".to_string(), session.to_string()]);
        }
        Some(args)
    }

    /// `opencode run -s <id>` continues the named session.
    fn resumes_sessions(&self) -> bool {
        true
    }

    /// OpenCode's dialect is its own: one event object per line, each wrapping a
    /// `part`. Two differences from Claude Code's shape drive everything here —
    /// a single `tool_use` event carries the call *and* its result (keyed by
    /// `callID`, with `state.status` saying which stage it is in), and text
    /// arrives per part rather than as deltas, so it is reported as
    /// [`StreamItem::TextPart`] and the runner streams the new suffix.
    fn parse_stream_line(&self, line: &str) -> Vec<StreamItem> {
        let line = line.trim();
        if line.is_empty() {
            return Vec::new();
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            return Vec::new();
        };
        let part = value.get("part");
        match value.get("type").and_then(|v| v.as_str()) {
            Some("text") => {
                let Some(part) = part else { return Vec::new() };
                let text = part.get("text").and_then(|v| v.as_str()).unwrap_or_default();
                if text.is_empty() {
                    return Vec::new();
                }
                vec![StreamItem::TextPart {
                    // Without an id every part would look like the same one, and
                    // the suffix logic would drop the second block's text.
                    id: part
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("text")
                        .to_string(),
                    text: text.to_string(),
                }]
            }
            Some("tool_use") => {
                let Some(part) = part else { return Vec::new() };
                let id = part
                    .get("callID")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let name = part
                    .get("tool")
                    .and_then(|v| v.as_str())
                    .unwrap_or("tool")
                    .to_string();
                let state = part.get("state");
                let status = state
                    .and_then(|s| s.get("status"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let mut items = vec![StreamItem::ToolCall {
                    id: id.clone(),
                    name,
                    input: state
                        .and_then(|s| s.get("input"))
                        .cloned()
                        .unwrap_or(serde_json::Value::Null),
                }];
                // A call is re-sent as it progresses (pending → running →
                // completed); emitting the call every time is harmless because
                // the fold upserts by id, and the result only exists at the end.
                match status {
                    "completed" => items.push(StreamItem::ToolResult {
                        id,
                        ok: true,
                        content: result_text(state.and_then(|s| s.get("output"))),
                    }),
                    "error" => items.push(StreamItem::ToolResult {
                        id,
                        ok: false,
                        content: state
                            .and_then(|s| s.get("error"))
                            .and_then(|v| v.as_str())
                            .map(str::to_string)
                            .unwrap_or_else(|| result_text(state.and_then(|s| s.get("output")))),
                    }),
                    _ => {}
                }
                items
            }
            // Every event carries the session id; the first one to arrive is
            // enough, and the runner ignores repeats.
            Some("step_start") => value
                .get("sessionID")
                .and_then(|v| v.as_str())
                .map(|id| vec![StreamItem::Session(id.to_string())])
                .unwrap_or_default(),
            _ => Vec::new(),
        }
    }

    /// OpenCode prints "Using session: <id>" (or similar) when it starts.
    fn extract_session_id(&self, output: &str) -> Option<String> {
        for line in output.lines() {
            let line = line.trim();
            if line.contains("Using session:")
                || line.contains("Session ID:")
                || line.contains("session:")
            {
                // Extract the ID after the colon.
                if let Some(colon_pos) = line.rfind(':') {
                    let after = line[colon_pos + 1..].trim();
                    // Session IDs are typically alphanumeric with dashes.
                    if after.len() > 3
                        && after
                            .chars()
                            .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
                    {
                        return Some(after.to_string());
                    }
                }
                // Fall back to the "oss-" prefix common in OpenCode ids.
                if let Some(pos) = line.find("oss-") {
                    let candidate = &line[pos..];
                    let end = candidate
                        .find(|c: char| !c.is_alphanumeric() && c != '-')
                        .unwrap_or(candidate.len());
                    if end > 3 {
                        return Some(candidate[..end].to_string());
                    }
                }
            }
        }
        None
    }

    /// OpenCode has no Klide-facing login command — auth is configured inside
    /// the TUI itself. Launching it is the only "login" action we can offer.
    fn login_commands(&self) -> Vec<String> {
        vec!["opencode".to_string()]
    }

    fn check_auth(&self, _command_path: &str) -> Result<(bool, String), String> {
        Ok((
            true,
            "OpenCode CLI is installed; authentication is handled by OpenCode.".to_string(),
        ))
    }

    fn install_paths(&self, home: &str) -> Vec<String> {
        vec![
            format!("{home}/.opencode/bin/opencode"),
            format!("{home}/.local/bin/opencode"),
        ]
    }

    /// One candidate per session row. The mtime is the session's own
    /// `time_updated` (not the DB file's mtime — they diverge while the WAL
    /// is being flushed). The key holds the session id, not a file path; the
    /// parser reads it back as an id and looks the row up in the DB.
    fn discover_runs(&self, home: &str) -> Vec<RunCandidate> {
        let mut out = Vec::new();
        if let Some(conn) = connect(home) {
            if let Ok(mut stmt) = conn.prepare("SELECT id, time_updated FROM session") {
                if let Ok(rows) = stmt.query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                }) {
                    for (id, time_updated) in rows.flatten() {
                        out.push(RunCandidate {
                            key: id,
                            mtime_ms: time_updated,
                        });
                    }
                }
            }
        }
        out
    }

    /// OpenCode stores the workspace as a column, so narrowing is a `WHERE`
    /// clause rather than a per-candidate probe. The trailing-slash tolerance
    /// matches `normalize_path`; sessions with a NULL directory are kept, since
    /// the contract says an unknown workspace must not exclude a candidate.
    fn discover_runs_for_workspace(&self, home: &str, workspace_root: &str) -> Vec<RunCandidate> {
        let want = crate::delegate::normalize_path(workspace_root);
        let mut out = Vec::new();
        if let Some(conn) = connect(home) {
            if let Ok(mut stmt) = conn.prepare(
                "SELECT id, time_updated FROM session \
                 WHERE directory IS NULL OR rtrim(directory, '/') = ?1",
            ) {
                if let Ok(rows) = stmt.query_map([&want], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                }) {
                    for (id, time_updated) in rows.flatten() {
                        out.push(RunCandidate {
                            key: id,
                            mtime_ms: time_updated,
                        });
                    }
                }
            }
        }
        out
    }

    /// The connection is opened once per page — opening the SQLite file for
    /// every candidate would dominate the page time.
    fn run_parser(&self, home: &str) -> Box<dyn RunParser> {
        Box::new(OpenCodeRunParser {
            conn: connect(home),
        })
    }

    fn read_run(&self, home: &str, key: &str) -> Result<Vec<RunMessage>, String> {
        let conn =
            connect(home).ok_or_else(|| "OpenCode session database is unavailable".to_string())?;

        let mut msg_stmt = conn
            .prepare(
                "SELECT id, data FROM message WHERE session_id = ?1 \
                 ORDER BY time_created ASC, id ASC",
            )
            .map_err(|e| format!("Unable to query opencode messages: {e}"))?;
        let messages: Vec<(String, serde_json::Value)> = msg_stmt
            .query_map([key], |row| {
                let id: String = row.get(0)?;
                let raw: String = row.get(1)?;
                let data: serde_json::Value =
                    serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);
                Ok((id, data))
            })
            .map_err(|e| format!("Unable to read opencode messages: {e}"))?
            .filter_map(|r| r.ok())
            .collect();

        let mut part_stmt = conn
            .prepare(
                "SELECT message_id, data FROM part WHERE session_id = ?1 \
                 ORDER BY time_created ASC, id ASC",
            )
            .map_err(|e| format!("Unable to query opencode parts: {e}"))?;
        let part_iter = part_stmt
            .query_map([key], |row| {
                let msg_id: String = row.get(0)?;
                let raw: String = row.get(1)?;
                let data: serde_json::Value =
                    serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);
                Ok((msg_id, data))
            })
            .map_err(|e| format!("Unable to read opencode parts: {e}"))?
            .filter_map(|r| r.ok());
        let mut parts_by_message: std::collections::HashMap<String, Vec<serde_json::Value>> =
            std::collections::HashMap::new();
        for (msg_id, data) in part_iter {
            parts_by_message.entry(msg_id).or_default().push(data);
        }

        let mut msgs: Vec<RunMessage> = Vec::new();
        for (msg_id, data) in messages {
            let role = data.get("role").and_then(|r| r.as_str()).unwrap_or("");
            if role != "user" && role != "assistant" {
                continue;
            }
            let parts = parts_by_message.get(&msg_id);
            if let Some((text, tools)) = message_text(parts.map(|v| v.as_slice()).unwrap_or(&[])) {
                if role == "user" && text.starts_with('<') {
                    continue;
                }
                msgs.push(RunMessage {
                    role: role.to_string(),
                    text,
                    tools,
                    images: vec![],
                });
            }
        }
        cap_messages(&mut msgs);
        Ok(msgs)
    }
}

// On macOS opencode 1.15 stores its DB at ~/.local/share/opencode/opencode.db
// (XDG-style). Older installs on Apple use ~/Library/Application Support.
// We try the XDG path first, then fall back to the Apple path so both work.
fn db_path(home: &str) -> Option<std::path::PathBuf> {
    let candidates = [
        std::path::Path::new(home).join(".local/share/opencode/opencode.db"),
        std::path::Path::new(home).join("Library/Application Support/opencode/opencode.db"),
    ];
    candidates.into_iter().find(|p| p.exists())
}

fn connect(home: &str) -> Option<rusqlite::Connection> {
    let path = db_path(home)?;
    rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).ok()
}

// The `model` column on `session` is JSON: {"id":"minimax-m3","providerID":"opencode-go"}.
// Flatten to "opencode-go/minimax-m3" so the user can tell the paid `opencode-go/*`
// models apart from the free `opencode/*` ones on the board.
fn model_label(raw: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let id = value.get("id").and_then(|v| v.as_str())?;
    let provider = value.get("providerID").and_then(|v| v.as_str());
    match provider {
        Some(p) if !p.is_empty() => Some(format!("{p}/{id}")),
        _ => Some(id.to_string()),
    }
}

struct OpenCodeRunParser {
    conn: Option<rusqlite::Connection>,
}

impl RunParser for OpenCodeRunParser {
    fn parse(&self, key: &str) -> Option<AgentRun> {
        parse_run(self.conn.as_ref()?, key)
    }
}

// One round-trip per row: pull everything the board needs, including the
// message count via subquery so we don't fan out one extra query per session.
fn parse_run(conn: &rusqlite::Connection, session_id: &str) -> Option<AgentRun> {
    let mut stmt = conn
        .prepare(
            "SELECT s.id, s.title, s.directory, s.model, s.time_updated, \
                    (SELECT COUNT(*) FROM message WHERE session_id = s.id) AS message_count, \
                    s.parent_id, s.time_created, \
                    (SELECT COALESCE(SUM(json_extract(data, '$.tokens.input')), 0) \
                       FROM message WHERE session_id = s.id) AS input_tokens, \
                    (SELECT COALESCE(SUM(json_extract(data, '$.tokens.output')), 0) \
                       FROM message WHERE session_id = s.id) AS output_tokens \
             FROM session s WHERE s.id = ?1",
        )
        .ok()?;
    let mut rows = stmt.query([session_id]).ok()?;
    let row = match rows.next() {
        Ok(Some(r)) => r,
        _ => return None,
    };
    let id: String = row.get(0).ok()?;
    let title: String = row.get(1).ok()?;
    let cwd: Option<String> = row.get(2).ok()?;
    let model_raw: Option<String> = row.get(3).ok()?;
    let time_updated: i64 = row.get(4).ok()?;
    let message_count: i64 = row.get(5).ok()?;
    // Sub-agent sessions ("(@explore subagent)" etc.) carry the spawning
    // session's id in parent_id — the board nests them under that run.
    let parent_id: Option<String> = row.get(6).ok().flatten();
    let time_created: i64 = row.get(7).unwrap_or(time_updated);
    let input_tokens: i64 = row.get(8).unwrap_or(0);
    let output_tokens: i64 = row.get(9).unwrap_or(0);

    // The latest message is OpenCode's provider-specific turn marker. A user
    // message starts work; an assistant message settles the turn. Recency only
    // bounds the active case so an abandoned/crashed external process cannot
    // leave a historical row "running" forever. A fresh session with no
    // messages has no work and is already done.
    let status = {
        let latest_role: Option<String> = (|| -> Option<String> {
            let mut stmt = conn
                .prepare(
                    "SELECT data FROM message WHERE session_id = ?1 \
                     ORDER BY time_created DESC LIMIT 1",
                )
                .ok()?;
            let mut rows = stmt
                .query_map([session_id], |row| {
                    let raw: String = row.get(0)?;
                    let value: serde_json::Value =
                        serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);
                    Ok(value
                        .get("role")
                        .and_then(|r| r.as_str())
                        .unwrap_or("")
                        .to_string())
                })
                .ok()?;
            rows.next().and_then(|r| r.ok())
        })();
        match latest_role.as_deref() {
            Some("user") => transcript_status(time_updated, TranscriptState::Working),
            _ => "done".to_string(),
        }
    };

    let branch: Option<String> = cwd
        .as_deref()
        .and_then(|cwd| {
            std::process::Command::new("git")
                .args(["-C", cwd, "branch", "--show-current"])
                .output()
                .ok()
        })
        .and_then(|out| {
            if !out.status.success() {
                return None;
            }
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if s.is_empty() {
                None
            } else {
                Some(s)
            }
        });
    let project = cwd.as_deref().and_then(project_name);

    // Walk every tool part in the session and accumulate the unique file
    // paths the agent touched. We do this in Rust rather than a single
    // SELECT DISTINCT json_extract(...) so the same `tool_file_path`
    // heuristic the JSONL adapters use applies — keeping the three
    // adapters in lockstep on what counts as "touched".
    let files_touched: u32 = (|| -> Option<u32> {
        let mut stmt = conn
            .prepare(
                "SELECT data FROM part WHERE session_id = ?1 \
                 AND json_extract(data, '$.type') = 'tool'",
            )
            .ok()?;
        let mut rows = stmt.query([session_id]).ok()?;
        let mut files: HashSet<String> = HashSet::new();
        while let Some(row) = rows.next().ok()? {
            let raw: String = row.get(0).ok()?;
            let value: serde_json::Value =
                serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);
            let name = value.get("tool").and_then(|n| n.as_str()).unwrap_or("");
            let args = value.get("args").unwrap_or(&serde_json::Value::Null);
            if let Some(path) = tool_file_path(name, args) {
                files.insert(path);
            }
        }
        Some(files.len() as u32)
    })()
    .unwrap_or(0);

    let cost_usd = crate::pricing::cost_for_run(
        model_raw.as_deref().unwrap_or(""),
        input_tokens,
        output_tokens,
    );

    // "What the run last did": the newest assistant message's text parts,
    // assembled the same way read_run does. Same schema (part.message_id +
    // time_created) the detail reader uses.
    let last_event: Option<String> = (|| -> Option<String> {
        let msg_id: String = conn
            .query_row(
                "SELECT id FROM message WHERE session_id = ?1 \
                 AND json_extract(data, '$.role') = 'assistant' \
                 ORDER BY time_created DESC, id DESC LIMIT 1",
                [session_id],
                |row| row.get(0),
            )
            .ok()?;
        let mut stmt = conn
            .prepare(
                "SELECT data FROM part WHERE message_id = ?1 \
                 ORDER BY time_created ASC, id ASC",
            )
            .ok()?;
        let parts: Vec<serde_json::Value> = stmt
            .query_map([&msg_id], |row| {
                let raw: String = row.get(0)?;
                Ok(serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null))
            })
            .ok()?
            .filter_map(|r| r.ok())
            .collect();
        message_text(&parts).map(|(t, _)| clean_title(&t))
    })();

    Some(AgentRun {
        status,
        project,
        id,
        // The session id is the only "path" an opencode run has — it's what
        // the user types after `opencode export` to read the full transcript.
        path: session_id.to_string(),
        source: "opencode".to_string(),
        title: {
            let trimmed = title.trim();
            if trimmed.is_empty() {
                "Untitled session".to_string()
            } else {
                clean_title(trimmed)
            }
        },
        model: model_raw.as_deref().and_then(model_label),
        cwd,
        git_branch: branch,
        worktree: None, // filled centrally in list_agent_runs from cwd
        created_ms: time_created,
        updated_ms: time_updated,
        message_count: message_count as u32,
        input_tokens,
        output_tokens,
        files_touched,
        cost_usd,
        // OpenCode nests sub-agents as their own sessions (linked via
        // `parent_id`), so they show as rows rather than an inline count.
        subagent_count: 0,
        last_event,
        parent_id,
    })
}

// Walk a message's parts into readable text plus structured tool calls: text
// parts concatenate; tool parts become structured RunToolCall entries (no
// longer folded into text as "[tool: <name>]"). Step/reasoning/control parts
// are dropped — they're noise in a résumé view. Returns None only when there is
// neither text nor a tool call to show.
fn message_text(parts: &[serde_json::Value]) -> Option<(String, Vec<RunToolCall>)> {
    let mut buf = String::new();
    let mut tools: Vec<RunToolCall> = Vec::new();
    for part in parts {
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
            Some("tool") => {
                let name = part.get("tool").and_then(|n| n.as_str()).unwrap_or("tool");
                tools.push(RunToolCall {
                    name: name.to_string(),
                    ..Default::default()
                });
            }
            _ => {}
        }
    }
    let t = buf.trim().to_string();
    if t.is_empty() && tools.is_empty() {
        None
    } else {
        Some((t, tools))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Captured from a real `opencode run --auto --format json` turn. OpenCode's
    // events wrap a `part`, and one `tool_use` carries the call *and* its result.
    const STEP_START: &str = r#"{"type":"step_start","sessionID":"ses_fef0","part":{"id":"prt_01","type":"step-start"}}"#;
    const TEXT: &str = r#"{"type":"text","sessionID":"ses_fef0","part":{"id":"prt_02","type":"text","text":"DONE"}}"#;
    const TOOL_DONE: &str = r#"{"type":"tool_use","sessionID":"ses_fef0","part":{"type":"tool","tool":"read","callID":"call_1b21","state":{"status":"completed","input":{"filePath":"/ws/TODO.md","limit":1},"output":"<content>\n1: # TODO\n</content>"}}}"#;
    const TOOL_RUNNING: &str = r#"{"type":"tool_use","sessionID":"ses_fef0","part":{"type":"tool","tool":"bash","callID":"call_9","state":{"status":"running","input":{"command":"npm test"}}}}"#;

    #[test]
    fn one_tool_event_yields_both_the_call_and_its_result() {
        assert_eq!(
            OpenCode.parse_stream_line(TOOL_DONE),
            vec![
                StreamItem::ToolCall {
                    id: "call_1b21".into(),
                    name: "read".into(),
                    input: serde_json::json!({"filePath": "/ws/TODO.md", "limit": 1}),
                },
                StreamItem::ToolResult {
                    id: "call_1b21".into(),
                    ok: true,
                    content: "<content>\n1: # TODO\n</content>".into(),
                },
            ]
        );
    }

    #[test]
    fn a_call_still_running_reports_no_result_yet() {
        // Re-sent as it progresses; the fold upserts by id, so emitting the call
        // again is harmless — inventing a result would not be.
        assert_eq!(
            OpenCode.parse_stream_line(TOOL_RUNNING),
            vec![StreamItem::ToolCall {
                id: "call_9".into(),
                name: "bash".into(),
                input: serde_json::json!({"command": "npm test"}),
            }]
        );
    }

    #[test]
    fn a_failed_call_is_marked_not_ok() {
        let line = r#"{"type":"tool_use","part":{"tool":"read","callID":"c3","state":{"status":"error","error":"file not found"}}}"#;
        let items = OpenCode.parse_stream_line(line);
        assert_eq!(
            items[1],
            StreamItem::ToolResult {
                id: "c3".into(),
                ok: false,
                content: "file not found".into(),
            }
        );
    }

    #[test]
    fn text_is_reported_per_part_so_the_runner_can_stream_the_suffix() {
        assert_eq!(
            OpenCode.parse_stream_line(TEXT),
            vec![StreamItem::TextPart {
                id: "prt_02".into(),
                text: "DONE".into()
            }]
        );
    }

    #[test]
    fn the_session_id_comes_off_the_first_step() {
        assert_eq!(
            OpenCode.parse_stream_line(STEP_START),
            vec![StreamItem::Session("ses_fef0".into())]
        );
    }

    #[test]
    fn unknown_and_malformed_lines_are_ignored_not_fatal() {
        for line in [
            r#"{"type":"step_finish","part":{"reason":"stop"}}"#,
            r#"{"type":"something_new","part":{}}"#,
            r#"{"type":"text","part":{"id":"p","text":""}}"#,
            "{not json",
            "",
        ] {
            assert!(OpenCode.parse_stream_line(line).is_empty(), "line: {line}");
        }
    }

    #[test]
    fn stream_args_continue_the_named_session() {
        let args = OpenCode
            .chat_stream_args(
                "/tmp/ws",
                &ChatSpec { model: "", resume: Some("ses_fef0"), allowed_commands: &[] },
            )
            .unwrap();
        // `-s <id>`, never `--continue`: the last session is the wrong one as
        // soon as two conversations run side by side.
        assert!(args.windows(2).any(|w| w == ["-s", "ses_fef0"]));
        assert!(!args.contains(&"--continue".to_string()));
    }

    #[test]
    fn stream_args_ask_for_json_on_stdout() {
        let args = OpenCode
            .chat_stream_args(
                "/tmp/ws",
                &ChatSpec { model: "minimax/minimax-m3", resume: None, allowed_commands: &[] },
            )
            .unwrap();
        assert_eq!(
            args.join(" "),
            "run --model minimax/minimax-m3 --auto --format json"
        );
    }

    fn temp_home(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("klide-delegate-test-opencode-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Build a fixture DB at the XDG path with one session, one user turn
    /// and one assistant turn.
    fn seed_db(home: &std::path::Path) {
        let dir = home.join(".local/share/opencode");
        std::fs::create_dir_all(&dir).unwrap();
        let conn = rusqlite::Connection::open(dir.join("opencode.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE session (id TEXT, title TEXT, directory TEXT, model TEXT, \
                 time_updated INTEGER, time_created INTEGER, parent_id TEXT);
             CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER);
             CREATE TABLE part (id TEXT, session_id TEXT, message_id TEXT, data TEXT, time_created INTEGER);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session VALUES ('oss-1', 'Fix the bug', '/tmp/proj', \
                 '{\"id\":\"minimax-m3\",\"providerID\":\"opencode-go\"}', 2000, 1000, NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO message VALUES \
                 ('m1', 'oss-1', '{\"role\":\"user\",\"tokens\":{\"input\":10,\"output\":0}}', 1),
                 ('m2', 'oss-1', '{\"role\":\"assistant\",\"tokens\":{\"input\":0,\"output\":25}}', 2)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO part VALUES \
                 ('p1', 'oss-1', 'm1', '{\"type\":\"text\",\"text\":\"please fix\"}', 1),
                 ('p2', 'oss-1', 'm2', '{\"type\":\"tool\",\"tool\":\"grep\"}', 2),
                 ('p3', 'oss-1', 'm2', '{\"type\":\"text\",\"text\":\"done\"}', 3)",
            [],
        )
        .unwrap();
    }

    #[test]
    fn chat_runs_headless_with_the_prompt_on_stdin() {
        // `opencode run` with no message argument reads stdin, so OpenCode can
        // hold a Focus conversation. This used to assert the opposite.
        let args = OpenCode.chat_args("/tmp/ws", "minimax/minimax-m3").unwrap();
        assert_eq!(args.join(" "), "run --model minimax/minimax-m3 --auto");
        // `-p` is `--password` for this CLI — passing it as "print" would ask
        // for a prompt on the wrong flag entirely.
        assert!(!args.contains(&"-p".to_string()));
    }

    #[test]
    fn chat_without_model_leaves_the_cli_default() {
        assert_eq!(OpenCode.chat_args("/tmp/ws", "").unwrap().join(" "), "run --auto");
    }

    #[test]
    fn discovers_sessions_with_their_own_timestamps() {
        let home = temp_home("discover");
        seed_db(&home);
        let found = OpenCode.discover_runs(home.to_str().unwrap());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].key, "oss-1");
        assert_eq!(found[0].mtime_ms, 2000);
    }

    #[test]
    fn parses_a_session_row() {
        let home = temp_home("parse");
        seed_db(&home);
        let parser = OpenCode.run_parser(home.to_str().unwrap());
        let run = parser.parse("oss-1").unwrap();
        assert_eq!(run.source, "opencode");
        assert_eq!(run.title, "Fix the bug");
        assert_eq!(run.model.as_deref(), Some("opencode-go/minimax-m3"));
        assert_eq!(run.message_count, 2);
        assert_eq!(run.input_tokens, 10);
        assert_eq!(run.output_tokens, 25);
        // The seed DB has no file-touching tool parts; the file-touched
        // test below covers the extraction path.
        assert_eq!(run.files_touched, 0);
        // opencode-go is passthrough — no known per-model price.
        assert_eq!(run.cost_usd, None);
        // Latest message is the assistant's → the agent finished its turn.
        assert_eq!(run.status, "done");
    }

    #[test]
    fn status_is_running_while_user_waits_on_the_agent() {
        let home = temp_home("status");
        seed_db(&home);
        let conn =
            rusqlite::Connection::open(home.join(".local/share/opencode/opencode.db")).unwrap();
        conn.execute(
            "INSERT INTO message VALUES ('m3', 'oss-1', '{\"role\":\"user\"}', 3)",
            [],
        )
        .unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        conn.execute("UPDATE session SET time_updated = ?1 WHERE id = 'oss-1'", [now])
            .unwrap();
        let parser = OpenCode.run_parser(home.to_str().unwrap());
        assert_eq!(parser.parse("oss-1").unwrap().status, "running");
    }

    #[test]
    fn stale_user_message_does_not_stay_running_forever() {
        let home = temp_home("stale-status");
        seed_db(&home);
        let conn =
            rusqlite::Connection::open(home.join(".local/share/opencode/opencode.db")).unwrap();
        conn.execute(
            "INSERT INTO message VALUES ('m3', 'oss-1', '{\"role\":\"user\"}', 3)",
            [],
        )
        .unwrap();

        let parser = OpenCode.run_parser(home.to_str().unwrap());
        assert_eq!(
            parser.parse("oss-1").unwrap().status,
            "done",
            "the fixture's ancient time_updated bounds an interrupted turn"
        );
    }

    #[test]
    fn read_run_assembles_parts_per_message() {
        let home = temp_home("read");
        seed_db(&home);
        let msgs = OpenCode.read_run(home.to_str().unwrap(), "oss-1").unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].text, "please fix");
        assert_eq!(msgs[1].text, "done");
        assert_eq!(msgs[1].tools.len(), 1);
        assert_eq!(msgs[1].tools[0].name, "grep");
    }

    #[test]
    fn parses_files_touched_from_tool_parts() {
        // Three file-touching tool parts across two messages, plus one
        // re-touch of an already-counted path and one grep tool (not a
        // file tool). Should resolve to 2 unique paths.
        let home = temp_home("files");
        let dir = home.join(".local/share/opencode");
        std::fs::create_dir_all(&dir).unwrap();
        let conn = rusqlite::Connection::open(dir.join("opencode.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE session (id TEXT, title TEXT, directory TEXT, model TEXT, \
                 time_updated INTEGER, time_created INTEGER, parent_id TEXT);
             CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER);
             CREATE TABLE part (id TEXT, session_id TEXT, message_id TEXT, data TEXT, time_created INTEGER);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session VALUES ('oss-1', 't', '/proj', \
                 '{\"id\":\"minimax-m3\",\"providerID\":\"opencode-go\"}', 2000, 1000, NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO message VALUES ('m1', 'oss-1', '{\"role\":\"assistant\"}', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO part VALUES \
                 ('p1', 'oss-1', 'm1', '{\"type\":\"tool\",\"tool\":\"read\",\"args\":{\"filePath\":\"/proj/src/main.rs\"}}', 1), \
                 ('p2', 'oss-1', 'm1', '{\"type\":\"tool\",\"tool\":\"read\",\"args\":{\"filePath\":\"/proj/src/main.rs\"}}', 2), \
                 ('p3', 'oss-1', 'm1', '{\"type\":\"tool\",\"tool\":\"edit\",\"args\":{\"filePath\":\"/proj/Cargo.toml\"}}', 3), \
                 ('p4', 'oss-1', 'm1', '{\"type\":\"tool\",\"tool\":\"grep\",\"args\":{\"pattern\":\"foo\"}}', 4)",
            [],
        )
        .unwrap();
        let parser = OpenCode.run_parser(home.to_str().unwrap());
        let run = parser.parse("oss-1").unwrap();
        assert_eq!(run.files_touched, 2, "dedupe + skip grep");
    }

    #[test]
    fn missing_db_yields_no_candidates_and_no_parse() {
        let home = temp_home("missing");
        assert!(OpenCode.discover_runs(home.to_str().unwrap()).is_empty());
        let parser = OpenCode.run_parser(home.to_str().unwrap());
        assert!(parser.parse("oss-1").is_none());
        assert!(OpenCode.read_run(home.to_str().unwrap(), "oss-1").is_err());
    }
}
