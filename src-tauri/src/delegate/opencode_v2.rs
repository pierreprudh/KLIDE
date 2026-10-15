//! OpenCode 2's native event contract and durable turn recovery.
//!
//! The CLI still prints V1-shaped compatibility parts, whose synthetic ids
//! differ from native events. We bind its session but consume answer/tool
//! content through one native reader, then reconcile the durable projection.
use super::{opencode_error, result_text, StreamItem};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

pub(super) struct Turn {
    session: Option<String>,
    text: HashMap<String, String>,
    reasoning: HashMap<String, String>,
    tool_names: HashMap<String, String>,
    calls: HashSet<String>,
    results: HashSet<String>,
    pub boundary: Option<String>,
    pub settled: bool,
    /// The feed already delivered the session's name; the record read after
    /// the turn has nothing to add.
    pub titled: bool,
}

impl Turn {
    pub fn new(session: Option<String>) -> Self {
        Self {
            session,
            text: HashMap::new(),
            reasoning: HashMap::new(),
            tool_names: HashMap::new(),
            calls: HashSet::new(),
            results: HashSet::new(),
            boundary: None,
            settled: false,
            titled: false,
        }
    }

    /// The session id as a path segment — only when it is one. Session IDs
    /// are opaque, never URLs supplied by a CLI.
    fn session_segment(&self) -> Option<&str> {
        let session = self.session.as_deref()?;
        session
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            .then_some(session)
    }

    pub fn history_path(&self) -> Option<String> {
        let session = self.session_segment()?;
        Some(format!(
            "/api/session/{session}/message?order=desc&limit=100"
        ))
    }

    /// `GET /api/session/:id` — the session's own record, its title included.
    /// Nothing once the feed has named the session.
    pub fn session_path(&self) -> Option<String> {
        if self.titled { return None; }
        let session = self.session_segment()?;
        Some(format!("/api/session/{session}"))
    }

    pub fn feed_stdout(&mut self, line: &str) -> Vec<StreamItem> {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        if value.get("type").and_then(Value::as_str) == Some("error") {
            return vec![StreamItem::Error(opencode_error(value.get("error")))];
        }
        if self.session.is_none() {
            if let Some(session) = value.get("sessionID").and_then(Value::as_str) {
                self.session = Some(session.into());
                return vec![StreamItem::Session(session.into())];
            }
        }
        Vec::new()
    }

    pub fn feed(&mut self, line: &str) -> Vec<StreamItem> {
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        let Some(data) = event.get("data") else {
            return Vec::new();
        };
        let Some(session) = data.get("sessionID").and_then(Value::as_str) else {
            return Vec::new();
        };
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if kind == "session.created" && self.session.is_none() && data.get("parentID").is_none() {
            self.session = Some(session.into());
            return vec![StreamItem::Session(session.into())];
        }
        if self.session.as_deref() != Some(session) {
            return Vec::new();
        }
        match kind {
            "session.text.delta" | "session.text.ended" | "session.reasoning.delta" | "session.reasoning.ended" => {
                let (Some(message), Some(ordinal)) = (
                    data.get("assistantMessageID").and_then(Value::as_str),
                    data.get("ordinal").and_then(Value::as_u64),
                ) else {
                    return Vec::new();
                };
                let id = format!("{message}:{ordinal}");
                let reasoning = kind.starts_with("session.reasoning.");
                let known = if reasoning { &mut self.reasoning } else { &mut self.text }.entry(id.clone()).or_default();
                if kind.ends_with(".delta") {
                    known.push_str(
                        data.get("delta")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                    );
                } else if let Some(text) = data.get("text").and_then(Value::as_str) {
                    *known = text.into();
                }
                vec![if reasoning { StreamItem::ThinkingPart {
                    id, text: known.clone(),
                } } else { StreamItem::TextPart {
                    id,
                    text: known.clone(),
                } }]
            }
            "session.tool.input.started" => {
                if let (Some(id), Some(name)) = (
                    data.get("id").and_then(Value::as_str),
                    data.get("name").and_then(Value::as_str),
                ) {
                    self.tool_names.insert(id.into(), name.into());
                }
                Vec::new()
            }
            "session.tool.called" => {
                let Some(id) = data.get("id").and_then(Value::as_str) else {
                    return Vec::new();
                };
                let Some(name) = self.tool_names.get(id).cloned() else {
                    return Vec::new();
                };
                self.call(id, &name, data.get("input").cloned().unwrap_or_default())
            }
            "session.tool.success" | "session.tool.failed" => {
                let Some(id) = data.get("id").and_then(Value::as_str) else {
                    return Vec::new();
                };
                let ok = kind == "session.tool.success";
                let content = if ok {
                    result_text(data.get("content"))
                } else {
                    opencode_error(data.get("error"))
                };
                self.result(id, ok, content)
            }
            // The small model named the session, beside the turn — the name
            // reaches the rail while the answer is still streaming.
            "session.renamed" => {
                let Some(title) = data.get("title").and_then(Value::as_str).and_then(crate::delegate::chat_server::named_title) else {
                    return Vec::new();
                };
                self.titled = true;
                vec![StreamItem::Title(title)]
            }
            "session.execution.succeeded" => {
                self.settled = true;
                Vec::new()
            }
            "session.step.ended" => {
                data.get("assistantMessageID").and_then(Value::as_str).and_then(|id| reported_usage(id, data, None)).into_iter().collect()
            }
            "session.execution.failed" => {
                self.settled = true;
                vec![StreamItem::Error(opencode_error(data.get("error")))]
            }
            "session.execution.interrupted" => {
                self.settled = true;
                vec![StreamItem::Error("OpenCode execution interrupted".into())]
            }
            _ => Vec::new(), // reasoning, retries and subagent events are not the answer
        }
    }

    fn call(&mut self, id: &str, name: &str, input: Value) -> Vec<StreamItem> {
        if !self.calls.insert(id.into()) {
            return Vec::new();
        }
        vec![StreamItem::ToolCall {
            id: id.into(),
            name: name.into(),
            input,
        }]
    }

    fn result(&mut self, id: &str, ok: bool, content: String) -> Vec<StreamItem> {
        if !self.results.insert(id.into()) {
            return Vec::new();
        }
        vec![StreamItem::ToolResult {
            id: id.into(),
            ok,
            content,
        }]
    }

    pub fn recover(&mut self, messages: &[Value]) -> Vec<StreamItem> {
        let mut out = Vec::new();
        for message in messages {
            match message.get("type").and_then(Value::as_str) {
                Some("assistant") => {
                    if let Some(error) = message.get("error") {
                        out.push(StreamItem::Error(opencode_error(Some(error))));
                    }
                    let Some(id) = message.get("id").and_then(Value::as_str) else {
                        continue;
                    };
                    let model = message.get("model").and_then(|model| Some(format!("{}/{}", model.get("providerID")?.as_str()?, model.get("id")?.as_str()?)));
                    if let Some(usage) = reported_usage(id, message, model.as_deref()) { out.push(usage); }
                    let Some(content) = message.get("content").and_then(Value::as_array) else {
                        continue;
                    };
                    // Native ordinals count blocks of each kind, not their
                    // position in the mixed reasoning/text/tool projection.
                    let mut text_ordinal = 0;
                    let mut reasoning_ordinal = 0;
                    for part in content {
                        match part.get("type").and_then(Value::as_str) {
                            Some("text") => {
                                let text = part
                                    .get("text")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_string();
                                let key = format!("{id}:{text_ordinal}");
                                text_ordinal += 1;
                                self.text.insert(key.clone(), text.clone());
                                out.push(StreamItem::TextPart { id: key, text });
                            }
                            Some("reasoning") => {
                                let text = part.get("text").and_then(Value::as_str).unwrap_or_default().to_string();
                                let key = format!("{id}:{reasoning_ordinal}");
                                reasoning_ordinal += 1;
                                self.reasoning.insert(key.clone(), text.clone());
                                out.push(StreamItem::ThinkingPart { id: key, text });
                            }
                            Some("tool") => {
                                let (Some(id), Some(name), Some(state)) = (
                                    part.get("id").and_then(Value::as_str),
                                    part.get("name").and_then(Value::as_str),
                                    part.get("state"),
                                ) else {
                                    continue;
                                };
                                let status = state
                                    .get("status")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default();
                                if status == "streaming" {
                                    continue;
                                }
                                out.extend(self.call(
                                    id,
                                    name,
                                    state.get("input").cloned().unwrap_or_default(),
                                ));
                                match status {
                                    "completed" => out.extend(self.result(
                                        id,
                                        true,
                                        result_text(state.get("content")),
                                    )),
                                    "error" => out.extend(self.result(
                                        id,
                                        false,
                                        opencode_error(state.get("error")),
                                    )),
                                    _ => {}
                                }
                            }
                            _ => {}
                        }
                    }
                }
                Some("idle") => {
                    self.settled = true;
                    match message.get("outcome").and_then(Value::as_str) {
                        Some("failed") => {
                            out.push(StreamItem::Error(opencode_error(message.get("error"))))
                        }
                        Some("interrupted") => {
                            out.push(StreamItem::Error("OpenCode execution interrupted".into()))
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        out
    }
}

fn reported_usage(id: &str, data: &Value, model: Option<&str>) -> Option<StreamItem> {
    let tokens = data.get("tokens")?;
    let input = tokens.get("input")?.as_u64()?;
    let cache = tokens.get("cache");
    let read = cache.and_then(|v| v.get("read")).and_then(Value::as_u64).unwrap_or(0);
    let write = cache.and_then(|v| v.get("write")).and_then(Value::as_u64).unwrap_or(0);
    let output = tokens.get("output")?.as_u64()?;
    let reasoning = tokens.get("reasoning").and_then(Value::as_u64).unwrap_or(0);
    let context_window = model.and_then(crate::models::cached_opencode_model_facts).and_then(|facts| facts.context_window).map(|v| v as u64);
    Some(StreamItem::Usage {
        id: id.into(), prompt: input.saturating_add(read).saturating_add(write),
        completion: output.saturating_add(reasoning),
        cost: data.get("cost").and_then(Value::as_f64), context_window,
    })
}

// V2's SQLite projections are deliberately separate from V1's tables. These
// read-only readers preserve Mission Control history without starting a model
// or depending on whether the user's background service is running.
use super::super::runs::{bounded_tool_input, bounded_tool_result};
use super::{
    cap_messages, clean_title, model_label, project_name, tool_file_path, transcript_status,
    AgentRun, RunCandidate, RunMessage, RunToolCall, TranscriptState,
};

pub(super) fn has_session(conn: &rusqlite::Connection, id: &str) -> bool {
    conn.query_row("SELECT 1 FROM session_v2 WHERE id = ?1", [id], |_| Ok(()))
        .is_ok()
}

pub(super) fn discover(conn: &rusqlite::Connection, directory: Option<&str>) -> Vec<RunCandidate> {
    let Ok(mut statement) = conn.prepare(
        "SELECT id, time_updated FROM session_v2 WHERE (?1 IS NULL OR rtrim(directory, '/') = ?1)",
    ) else {
        return Vec::new();
    };
    let Ok(rows) = statement.query_map([directory], |row| {
        Ok(RunCandidate {
            key: row.get(0)?,
            mtime_ms: row.get(1)?,
        })
    }) else {
        return Vec::new();
    };
    rows.filter_map(Result::ok).collect()
}

fn messages(conn: &rusqlite::Connection, session: &str) -> Result<Vec<Value>, String> {
    let mut statement = conn.prepare("SELECT id, type, data FROM session_message WHERE session_id = ?1 ORDER BY seq ASC, id ASC").map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([session], |row| {
            let id: String = row.get(0)?;
            let kind: String = row.get(1)?;
            let raw: String = row.get(2)?;
            let mut value: Value = serde_json::from_str(&raw).unwrap_or_default();
            if let Some(object) = value.as_object_mut() {
                object.insert("id".into(), id.into());
                object.insert("type".into(), kind.into());
            }
            Ok(value)
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub(super) fn read_run(
    conn: &rusqlite::Connection,
    session: &str,
) -> Result<Vec<RunMessage>, String> {
    let mut out = Vec::new();
    for message in messages(conn, session)? {
        let role = message
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if role != "user" && role != "assistant" {
            continue;
        }
        let mut text = message
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let mut tools = Vec::new();
        if let Some(content) = message.get("content").and_then(Value::as_array) {
            for part in content {
                match part.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(value) = part.get("text").and_then(Value::as_str) {
                            if !text.is_empty() {
                                text.push('\n');
                            }
                            text.push_str(value);
                        }
                    }
                    Some("tool") => {
                        let name = part.get("name").and_then(Value::as_str).unwrap_or("tool");
                        let state = part.get("state").unwrap_or(&Value::Null);
                        let status = state.get("status").and_then(Value::as_str);
                        let result = match status {
                            Some("completed") => Some(result_text(state.get("content"))),
                            Some("error") => Some(opencode_error(state.get("error"))),
                            _ => None,
                        };
                        tools.push(RunToolCall {
                            name: name.into(),
                            id: part.get("id").and_then(Value::as_str).map(str::to_string),
                            input: state.get("input").map(bounded_tool_input),
                            summary: None,
                            result: result.as_deref().map(bounded_tool_result),
                            ok: match status {
                                Some("completed") => Some(true),
                                Some("error") => Some(false),
                                _ => None,
                            },
                        });
                    }
                    _ => {}
                }
            }
        }
        if !text.trim().is_empty() || !tools.is_empty() {
            out.push(RunMessage {
                role: role.into(),
                text,
                tools,
                images: Vec::new(),
            });
        }
    }
    cap_messages(&mut out);
    Ok(out)
}

pub(super) fn parse_run(conn: &rusqlite::Connection, id: &str) -> Option<AgentRun> {
    let mut statement = conn.prepare("SELECT title, directory, model, time_created, time_updated, parent_id, tokens_input, tokens_output, cost, idle_outcome FROM session_v2 WHERE id = ?1").ok()?;
    let mut rows = statement.query([id]).ok()?;
    let row = rows.next().ok()??;
    let cwd: String = row.get(1).ok()?;
    let model: Option<String> = row.get(2).ok()?;
    let updated: i64 = row.get(4).ok()?;
    let outcome: Option<String> = row.get(9).ok()?;
    let messages = messages(conn, id).ok()?;
    let mut files = HashSet::new();
    let mut last = None;
    let mut count = 0;
    for message in &messages {
        if matches!(
            message.get("type").and_then(Value::as_str),
            Some("user" | "assistant")
        ) {
            count += 1;
        }
        if message.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        if let Some(content) = message.get("content").and_then(Value::as_array) {
            for part in content {
                if part.get("type").and_then(Value::as_str) == Some("text") {
                    if let Some(text) = part
                        .get("text")
                        .and_then(Value::as_str)
                        .filter(|t| !t.trim().is_empty())
                    {
                        last = Some(clean_title(text));
                    }
                }
                if part.get("type").and_then(Value::as_str) == Some("tool") {
                    let name = part.get("name").and_then(Value::as_str).unwrap_or_default();
                    if let Some(path) =
                        tool_file_path(name, part.pointer("/state/input").unwrap_or(&Value::Null))
                    {
                        files.insert(path);
                    }
                }
            }
        }
    }
    let status = match outcome.as_deref() {
        Some("failed") => "error".into(),
        Some("interrupted") => "aborted".into(),
        Some("succeeded") => "done".into(),
        _ if count == 0 => "done".into(),
        _ => transcript_status(updated, TranscriptState::Working),
    };
    let branch = std::process::Command::new("git")
        .args(["-C", &cwd, "branch", "--show-current"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|b| !b.is_empty());
    let title: Option<String> = row.get(0).ok()?;
    Some(AgentRun {
        id: id.into(),
        source: "opencode".into(),
        path: id.into(),
        title: title
            .filter(|t| !t.trim().is_empty())
            .map(|t| clean_title(&t))
            .unwrap_or_else(|| "Untitled session".into()),
        model: model.as_deref().and_then(model_label),
        project: project_name(&cwd),
        cwd: Some(cwd),
        git_branch: branch,
        worktree: None,
        created_ms: row.get(3).ok()?,
        updated_ms: updated,
        status,
        message_count: count,
        input_tokens: row.get(6).ok()?,
        output_tokens: row.get(7).ok()?,
        cost_usd: row.get(8).ok()?,
        files_touched: files.len() as u32,
        subagent_count: 0,
        last_event: last,
        parent_id: row.get(5).ok()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const EVENTS: &str = include_str!("fixtures/opencode-v2/events.jsonl");
    const MESSAGES: &str = include_str!("fixtures/opencode-v2/messages.json");

    fn fixture_messages() -> Vec<Value> {
        serde_json::from_str::<Value>(MESSAGES).unwrap()["data"]
            .as_array()
            .unwrap()
            .clone()
    }
    fn session() -> String {
        serde_json::from_str::<Value>(EVENTS.lines().next().unwrap()).unwrap()["data"]["sessionID"]
            .as_str()
            .unwrap()
            .into()
    }
    fn event(turn: &mut Turn, kind: &str, mut data: Value) -> Vec<StreamItem> {
        data["sessionID"] = session().into();
        turn.feed(&json!({"type":kind,"data":data}).to_string())
    }

    #[test]
    fn the_session_name_arrives_on_the_feed_and_the_record_read_stands_down() {
        let mut turn = Turn::new(Some(session()));
        assert!(turn.session_path().is_some());
        assert!(event(&mut turn, "session.renamed", json!({"title": "New session - 2026-10-15T14:05:23.616Z"})).is_empty());
        assert!(turn.session_path().is_some());
        assert_eq!(event(&mut turn, "session.renamed", json!({"title": " Understanding the stack "})), [StreamItem::Title("Understanding the stack".into())]);
        assert!(turn.session_path().is_none());
        // Another session's name is not this conversation's.
        let mut other = Turn::new(Some("ses_other".into()));
        assert!(event(&mut other, "session.renamed", json!({"title": "Theirs"})).is_empty());
    }

    #[test]
    fn captured_native_turn_streams_and_reconciles_with_one_answer() {
        let mut turn = Turn::new(None);
        let mut parts = HashMap::new();
        let mut suffixes = Vec::new();
        let mut consume = |items: Vec<StreamItem>| {
            for item in items {
                if let StreamItem::TextPart { id, text } = item {
                    let length = parts.entry(id).or_insert(0);
                    if text.len() > *length {
                        suffixes.push(text[*length..].to_string());
                    }
                    *length = text.len();
                }
            }
        };
        for line in EVENTS.lines() {
            consume(turn.feed(line));
        }
        consume(turn.recover(&fixture_messages()));
        assert_eq!(suffixes, ["Hello ", "from ", "V2."]);
        assert!(turn.settled);
    }

    #[test]
    fn a_disconnected_stream_recovers_the_missing_tail_and_tools() {
        let mut turn = Turn::new(Some(session()));
        // Only the first native delta arrived before disconnection.
        let first = event(
            &mut turn,
            "session.text.delta",
            json!({"assistantMessageID":"message","ordinal":0,"delta":"Hello "}),
        );
        assert!(matches!(&first[0], StreamItem::TextPart { text, .. } if text == "Hello "));
        let recovered = turn.recover(&[json!({"id":"message","type":"assistant","content":[
            {"type":"text","text":"Hello from V2."},
            {"type":"tool","id":"tool","name":"read","state":{"status":"completed","input":{"filePath":"README.md"},"content":[{"type":"text","text":"file contents"}]}}
        ]}),json!({"type":"idle","outcome":"succeeded"})]);
        assert!(
            matches!(&recovered[0], StreamItem::TextPart { id, text } if id == "message:0" && text == "Hello from V2.")
        );
        assert!(matches!(&recovered[1], StreamItem::ToolCall { name, .. } if name == "read"));
        assert!(
            matches!(&recovered[2], StreamItem::ToolResult { content, ok:true, .. } if content == "file contents")
        );
        assert!(turn.settled);
    }

    #[test]
    fn reasoning_and_peer_sessions_never_enter_the_answer() {
        let mut turn = Turn::new(Some(session()));
        assert_eq!(event(
            &mut turn,
            "session.reasoning.delta",
            json!({"assistantMessageID":"m","ordinal":0,"delta":"private reasoning"})
        ), [StreamItem::ThinkingPart { id: "m:0".into(), text: "private reasoning".into() }]);
        assert!(turn.feed(&json!({"type":"session.text.delta","data":{"sessionID":"child","assistantMessageID":"m","ordinal":0,"delta":"peer text"}}).to_string()).is_empty());
        assert!(turn
            .feed(
                &json!({"type":"session.execution.succeeded","data":{"sessionID":"child"}})
                    .to_string()
            )
            .is_empty());
        assert!(!turn.settled);
        let recovered = turn.recover(&[json!({"type":"assistant","id":"m","content":[{"type":"reasoning","text":"hidden"},{"type":"text","text":"answer"}]})]);
        assert_eq!(
            recovered,
            [StreamItem::ThinkingPart { id: "m:0".into(), text: "hidden".into() }, StreamItem::TextPart {
                id: "m:0".into(),
                text: "answer".into()
            }]
        );
    }

    #[test]
    fn native_tools_are_observed_once_across_stream_and_projection() {
        let mut turn = Turn::new(Some(session()));
        event(
            &mut turn,
            "session.tool.input.started",
            json!({"id":"tool","name":"shell"}),
        );
        assert_eq!(
            event(
                &mut turn,
                "session.tool.called",
                json!({"id":"tool","input":{"command":"false"}})
            )
            .len(),
            1
        );
        assert_eq!(
            event(
                &mut turn,
                "session.tool.failed",
                json!({"id":"tool","error":{"message":"exit 1"}})
            ),
            [StreamItem::ToolResult {
                id: "tool".into(),
                ok: false,
                content: "exit 1".into()
            }]
        );
        assert!(turn.recover(&[json!({"id":"m","type":"assistant","content":[{"type":"tool","id":"tool","name":"shell","state":{"status":"error","input":{"command":"false"},"error":{"message":"exit 1"}}}]})]).is_empty());
    }

    #[test]
    fn provider_failure_and_interrupt_are_not_successful_answers() {
        let mut turn = Turn::new(Some(session()));
        assert_eq!(
            event(
                &mut turn,
                "session.execution.failed",
                json!({"error":{"message":"quota exhausted"}})
            ),
            [StreamItem::Error("quota exhausted".into())]
        );
        assert!(turn.settled);
        let mut turn = Turn::new(Some(session()));
        assert!(matches!(
            &turn.recover(&[json!({"type":"idle","outcome":"interrupted"})])[0],
            StreamItem::Error(_)
        ));
    }

    #[test]
    fn stdout_compatibility_ids_do_not_duplicate_native_text() {
        let mut turn = Turn::new(None);
        assert_eq!(
            turn.feed_stdout(&json!({"type":"step_start","sessionID":"ses_test"}).to_string()),
            [StreamItem::Session("ses_test".into())]
        );
        assert!(turn.feed_stdout(&json!({"type":"text","sessionID":"ses_test","part":{"id":"synthetic","text":"answer"}}).to_string()).is_empty());
        assert_eq!(
            turn.history_path().as_deref(),
            Some("/api/session/ses_test/message?order=desc&limit=100")
        );
    }

    fn database() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, title TEXT, directory TEXT, model TEXT, time_created INTEGER, time_updated INTEGER, parent_id TEXT, tokens_input INTEGER, tokens_output INTEGER, cost REAL, idle_outcome TEXT);
          CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, data TEXT);
          INSERT INTO session_v2 VALUES ('ses_test','Review changes','/workspace','{\"id\":\"mock\",\"providerID\":\"mock\"}',10,20,'ses_parent',10,5,0.12,'succeeded');").unwrap();
        for (seq, message) in fixture_messages().iter().enumerate() {
            let mut data = message.clone();
            let id = data.as_object_mut().unwrap().remove("id").unwrap();
            let kind = data.as_object_mut().unwrap().remove("type").unwrap();
            conn.execute(
                "INSERT INTO session_message VALUES (?1,'ses_test',?2,?3,?4)",
                rusqlite::params![
                    id.as_str().unwrap(),
                    kind.as_str().unwrap(),
                    seq,
                    data.to_string()
                ],
            )
            .unwrap();
        }
        conn
    }

    #[test]
    fn v2_history_remains_visible_without_a_running_service() {
        let conn = database();
        assert_eq!(discover(&conn, Some("/workspace")).len(), 1);
        assert!(discover(&conn, Some("/other")).is_empty());
        let run = parse_run(&conn, "ses_test").unwrap();
        assert_eq!(run.status, "done");
        assert_eq!(run.parent_id.as_deref(), Some("ses_parent"));
        assert_eq!(run.model.as_deref(), Some("mock/mock"));
        assert_eq!(run.message_count, 2);
        assert_eq!(run.cost_usd, Some(0.12));
        assert_eq!(run.last_event.as_deref(), Some("Hello from V2."));
        let transcript = read_run(&conn, "ses_test").unwrap();
        assert_eq!(transcript.len(), 2);
        assert_eq!(transcript[0].role, "user");
        assert_eq!(transcript[1].text, "Hello from V2.");
        conn.execute("UPDATE session_v2 SET idle_outcome='failed'", [])
            .unwrap();
        assert_eq!(parse_run(&conn, "ses_test").unwrap().status, "error");
        conn.execute("UPDATE session_v2 SET idle_outcome='interrupted'", [])
            .unwrap();
        assert_eq!(parse_run(&conn, "ses_test").unwrap().status, "aborted");
    }
}

use super::super::chat_server::{recover_history, ChatServer, CommandTurn};
use std::time::Duration;

/// The V2 command path uses the same private server, native stream and
/// durable recovery as a prompt turn. Pending permissions are answered once,
/// matching run --auto; explicit deny rules never create a pending request.
pub(super) async fn run_command(
    server: &mut dyn ChatServer,
    turn: CommandTurn<'_>,
) -> Result<String, String> {
    let CommandTurn {
        url,
        password,
        args,
        name,
        prompt,
        cwd,
        mut emitter,
        events,
    } = turn;
    let client = reqwest::Client::new();
    let user = server.username();
    let request = |method, path: &str| {
        client
            .request(method, format!("{url}{path}"))
            .basic_auth(user, Some(password))
            .timeout(Duration::from_secs(10))
    };
    let arg = |name: &str| {
        args.windows(2)
            .find(|a| a[0] == name)
            .map(|a| a[1].as_str())
    };
    let model = arg("--model")
        .map(|model| {
            let (provider, model) = model
                .split_once('/')
                .ok_or("OpenCode model must be provider/model")?;
            let (id, variant) = model
                .split_once('#')
                .map(|(id, v)| (id, Some(v)))
                .unwrap_or((model, None));
            let mut value = serde_json::json!({"providerID": provider, "id": id});
            if let Some(variant) = variant {
                value["variant"] = variant.into();
            }
            Ok::<_, String>(value)
        })
        .transpose()?;
    let session = if let Some(id) = arg("-s") {
        if !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err("Invalid OpenCode session id".into());
        }
        id.to_string()
    } else {
        let mut body = serde_json::json!({"location": {"directory": cwd}});
        if let Some(model) = &model {
            body["model"] = model.clone();
        }
        let response = request(reqwest::Method::POST, "/api/session")
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        let body: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
        body.pointer("/data/id")
            .and_then(|v| v.as_str())
            .ok_or("OpenCode did not create a session")?
            .to_string()
    };
    emitter.handle(StreamItem::Session(session.clone()));
    server
        .feed_stdout(&serde_json::json!({"type": "step_start", "sessionID": session}).to_string());
    let path = server
        .history_path()
        .ok_or("OpenCode did not bind the command session")?;
    let baseline: serde_json::Value = request(reqwest::Method::GET, &path)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    server.set_history_boundary(
        baseline
            .pointer("/data/0/id")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    );
    if arg("-s").is_some() {
        if let Some(model) = model {
            request(
                reqwest::Method::POST,
                &format!("/api/session/{session}/model"),
            )
            .json(&serde_json::json!({"model": model}))
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        }
    }
    // Command admission can itself ask a permission. Keep reading and
    // answering pending requests while the admission HTTP request is alive.
    let admission = request(
        reqwest::Method::POST,
        &format!("/api/session/{session}/command"),
    )
    .timeout(super::super::chat::CHAT_TURN_CEILING)
    .json(&serde_json::json!({"name": name, "text": prompt}))
    .send();
    tokio::pin!(admission);
    let mut permissions = tokio::time::interval(Duration::from_millis(300));
    loop {
        tokio::select! {
            response = &mut admission => {
                response.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?;
                break;
            }
            Some(data) = events.recv() => { for item in server.feed(&data) { emitter.handle(item); } }
            _ = permissions.tick() => approve_v2_pending(&client, url, user, password, &session).await?,
        }
    }
    let wait = client
        .post(format!("{url}/api/experimental/session/{session}/wait"))
        .basic_auth(user, Some(password))
        .send();
    tokio::pin!(wait);
    loop {
        tokio::select! {
            response = &mut wait => { response.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?; break; }
            Some(data) = events.recv() => { for item in server.feed(&data) { emitter.handle(item); } }
            _ = permissions.tick() => approve_v2_pending(&client, url, user, password, &session).await?,
        }
    }
    let messages = recover_history(
        &client,
        url,
        &path,
        user,
        password,
        server.history_boundary(),
    )
    .await?;
    for item in server.recover_history(&messages) {
        emitter.handle(item);
    }
    emitter.finish()
}

async fn approve_v2_pending(
    client: &reqwest::Client,
    url: &str,
    user: &str,
    password: &str,
    session: &str,
) -> Result<(), String> {
    let body: serde_json::Value = client
        .get(format!("{url}/api/session/{session}/permission"))
        .basic_auth(user, Some(password))
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let pending = body
        .get("data")
        .and_then(|v| v.as_array())
        .ok_or("Invalid OpenCode permission list")?;
    for permission in pending {
        let Some(id) = permission.get("id").and_then(|v| v.as_str()).filter(|id| {
            id.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        }) else {
            continue;
        };
        let response = client
            .post(format!("{url}/api/session/{session}/permission/{id}/reply"))
            .basic_auth(user, Some(password))
            .timeout(Duration::from_secs(10))
            .json(&serde_json::json!({"decision": "once"}))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        // A concurrent CLI may have answered the same request first.
        if response.status() != reqwest::StatusCode::NOT_FOUND {
            response.error_for_status().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
