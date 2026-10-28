//! The vocabulary a delegate CLI's structured turn stream is parsed *into*.
//!
//! Every CLI that can report itself does so in its own dialect. Claude Code
//! emits Anthropic-shaped JSONL (`assistant` messages holding `tool_use`
//! blocks, results addressed to `user`, text arriving as `text_delta`s);
//! OpenCode emits its own event objects where a single `tool_use` carries the
//! call *and* its result, keyed by `callID`. Reading those is per-CLI
//! knowledge, so it lives in each adapter behind
//! [`Delegate::parse_stream_line`](super::Delegate::parse_stream_line).
//!
//! What they all produce is this module: one [`StreamItem`] vocabulary, plus
//! the JSON helpers the dialects share. Keeping the vocabulary here is what
//! lets `chat.rs` drive any of them with one loop.
//!
//! A dialect must ignore what it does not recognise rather than fail: these
//! shapes belong to somebody else's CLI and will grow new line types.

use serde_json::Value;

/// One meaningful thing found on one line of a delegate's stream.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum StreamItem {
    /// A terminal provider failure, even when the CLI exits successfully.
    Error(String),
    /// The session id this turn runs under — what `--resume` needs later.
    Session(String),
    /// The name the CLI gave its session. OpenCode titles a session with a
    /// small model after its first message; the conversation may adopt it.
    Title(String),
    /// The `/` commands this CLI answers itself (see `cli_commands.rs`).
    Commands(super::cli_commands::CliCommands),
    /// A whole assistant text block, delivered once the model finished it.
    ///
    /// With Claude Code's `--include-partial-messages` the same text has
    /// already arrived as [`StreamItem::TextDelta`]s, so a consumer that saw
    /// any delta must ignore these or the answer appears twice.
    Text(String),
    /// One fragment, as it was produced. What makes a turn type out.
    TextDelta(String),
    /// The CLI began a new assistant message. Two messages of prose in a row
    /// — a sentence, then another after a background sub-agent woke the CLI —
    /// are two paragraphs, not one run-on line.
    MessageStart,
    /// A named part's text *so far*. OpenCode reports text per part rather than
    /// as deltas, and a growing part may be re-sent whole; the consumer keeps
    /// what it has already emitted per `id` and streams only the new suffix, so
    /// the same handling is correct whether a part arrives once or repeatedly.
    TextPart { id: String, text: String },
    /// Provider reasoning, kept separate from the answer.
    ThinkingPart { id: String, text: String },
    /// Provider usage for a completed assistant step. Replayed by history
    /// recovery under the same id, so totals must be upserted, not added twice.
    Usage { id: String, prompt: u64, completion: u64, cost: Option<f64>, context_window: Option<u64> },
    /// A tool the CLI called on its own.
    ToolCall {
        id: String,
        name: String,
        input: Value,
    },
    /// The result it got back.
    ToolResult {
        id: String,
        ok: bool,
        content: String,
    },
    /// A tool call or result from inside a sub-agent the CLI started itself
    /// (Claude Code's `Agent` tool). `parent` is the id of that call, so the
    /// conversation can draw the sub-agent's steps under it instead of as the
    /// turn's own.
    Nested { parent: String, item: Box<StreamItem> },
    /// Where one of those sub-agents is, as the CLI reports it: started, its
    /// current step, settled. A background sub-agent's call returns the moment
    /// it launches, so its own result says nothing about when it finishes;
    /// this does.
    Subagent { id: String, status: SubagentStatus, activity: Option<String>, tokens: Option<u64>, steps: Option<u64> },
    /// The terminating line: what the CLI thinks the turn cost.
    Finished {
        cost_usd: Option<f64>,
        turns: Option<i64>,
    },
}

/// A delegate's own sub-agent, settled or not.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubagentStatus {
    Running,
    Completed,
    Failed,
    Stopped,
}

/// `message.content[]` from an Anthropic-shaped line.
pub(super) fn message_blocks(value: &Value) -> Vec<Value> {
    value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// A tool result's content is either a plain string or a block list. Both
/// flatten to text; anything else is rendered as its JSON so a reader sees
/// *something* rather than an empty row.
pub(super) fn result_text(content: Option<&Value>) -> String {
    match content {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        Some(other) => other.to_string(),
    }
}

/// A one-line label for a tool call: the argument that says *what* it acted on,
/// preferred over dumping the whole input object into the row. The key names
/// span dialects on purpose — `file_path` is Claude Code's, `filePath` is
/// OpenCode's, and a row should read the same either way.
pub(crate) fn summarize_call(name: &str, input: &Value) -> String {
    const SUBJECT_KEYS: [&str; 8] = [
        "file_path",
        "filePath",
        "path",
        "command",
        "pattern",
        "url",
        "prompt",
        "description",
    ];
    let subject = SUBJECT_KEYS
        .iter()
        .find_map(|key| input.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|s| !s.is_empty());
    match subject {
        Some(subject) => {
            // One line only — a multi-line Bash script would break the row.
            let first = subject.lines().next().unwrap_or(subject);
            let clipped: String = first.chars().take(120).collect();
            if clipped.len() < first.len() {
                format!("{name} {clipped}…")
            } else {
                format!("{name} {clipped}")
            }
        }
        None => name.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn call_summary_names_the_subject_and_stays_one_line() {
        assert_eq!(
            summarize_call("Read", &serde_json::json!({"file_path": "src/main.rs"})),
            "Read src/main.rs"
        );
        // OpenCode spells the same argument differently; the row must not.
        assert_eq!(
            summarize_call("read", &serde_json::json!({"filePath": "src/main.rs"})),
            "read src/main.rs"
        );
        assert_eq!(
            summarize_call(
                "Bash",
                &serde_json::json!({"command": "npm test\nnpm run build"})
            ),
            "Bash npm test"
        );
        // No recognised subject key → the tool name alone, never a JSON dump.
        assert_eq!(
            summarize_call("TodoWrite", &serde_json::json!({"todos": []})),
            "TodoWrite"
        );
    }

    #[test]
    fn tool_result_content_flattens_from_either_shape() {
        assert_eq!(result_text(None), "");
        assert_eq!(result_text(Some(&serde_json::json!("plain"))), "plain");
        assert_eq!(
            result_text(Some(&serde_json::json!([
                {"type": "text", "text": "line one"},
                {"type": "text", "text": "line two"}
            ]))),
            "line one\nline two"
        );
        // Neither shape — show the JSON rather than an empty row.
        assert_eq!(result_text(Some(&serde_json::json!({"n": 1}))), "{\"n\":1}");
    }
}
