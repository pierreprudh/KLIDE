use super::runs::{cap_messages, clean_title, project_name, tool_file_path};
use super::{shell_quote, AgentRun, Delegate, RunCandidate, RunMessage, RunParser};
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

    fn resume_arg(&self, session_id: &str) -> String {
        format!(" -s {}", shell_quote(session_id))
    }

    /// OpenCode only works as an interactive PTY delegate — there is no
    /// headless stdin mode worth driving. The error string is surfaced to
    /// the chat verbatim.
    fn chat_args(&self, _cwd: &str, _model: &str) -> Result<Vec<String>, String> {
        Err("OpenCode is available as an interactive PTY delegate.".to_string())
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
            if let Some(text) = message_text(parts.map(|v| v.as_slice()).unwrap_or(&[])) {
                if role == "user" && text.starts_with('<') {
                    continue;
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

    // Status is determined by the *role of the latest message*, not the
    // recency of the session row. The opencode TUI/server touches the
    // session row in the background (auto-save, etc.), so time_updated is
    // a heartbeat signal that says nothing about whether the user is
    // actively engaged. The latest message is what tells us:
    //   • role == "user"      → user is waiting on the agent → "running"
    //   • role == "assistant" → agent has finished its last turn → "done"
    //   • no messages at all   → fresh/unused session → "done"
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
            Some("user") => "running".to_string(),
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
        message_text(&parts).map(|t| clean_title(&t))
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

// Walk a message's parts into a single readable string: text parts
// concatenate, tool parts collapse to a one-line "[tool: <name>]".
// Step/reasoning/control parts are dropped — they're noise in a résumé view.
fn message_text(parts: &[serde_json::Value]) -> Option<String> {
    let mut buf = String::new();
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
                if !buf.is_empty() {
                    buf.push('\n');
                }
                buf.push_str(&format!("[tool: {name}]"));
            }
            _ => {}
        }
    }
    let t = buf.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn chat_is_pty_only() {
        let err = OpenCode.chat_args("/tmp/ws", "minimax-m3").unwrap_err();
        assert!(err.contains("interactive PTY delegate"));
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
        let parser = OpenCode.run_parser(home.to_str().unwrap());
        assert_eq!(parser.parse("oss-1").unwrap().status, "running");
    }

    #[test]
    fn read_run_assembles_parts_per_message() {
        let home = temp_home("read");
        seed_db(&home);
        let msgs = OpenCode.read_run(home.to_str().unwrap(), "oss-1").unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].text, "please fix");
        assert_eq!(msgs[1].text, "[tool: grep]\ndone");
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
