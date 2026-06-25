//! Pure-ish run-loop helpers.
//!
//! This module owns provider-turn preparation decisions that do not need a
//! Tauri app handle: provider capability quirks, provider-message assembly,
//! TODO context refresh, and token-budget compaction.

use super::todo;
use super::types::{AgentAttachment, AgentMode, StartRunRequest};

/// The handful of provider quirks the run loop's behavior depends on, gathered
/// in one place so the loop asks about a capability instead of comparing
/// provider names inline. Keyed on the provider id; add a quirk here rather
/// than threading another `provider == "..."` branch through the loop.
pub(super) struct ProviderCaps {
    /// Replay continuation history as structured tool messages (assistant
    /// `tool_calls` + `role:"tool"`). Ollama's native `/api/chat` is the lone
    /// exception: the structured shape makes those models imitate fake tool
    /// text, so it gets the text-fold workaround instead. Every OpenAI-wire
    /// provider (including Ollama over `/v1`) gets the faithful structured replay.
    pub(super) structured_replay: bool,
    /// Keep Chat-mode context minimal — skip injecting the project TODO list.
    /// Small local backends (MLX, Ollama) made a bare "hello" feel broken when
    /// handed project metadata, so their chat turns stay tiny.
    pub(super) minimal_chat_context: bool,
}

impl ProviderCaps {
    pub(super) fn for_provider(provider: &str) -> Self {
        Self {
            structured_replay: provider != "ollama",
            minimal_chat_context: matches!(provider, "mlx" | "ollama"),
        }
    }
}

/// Fold an attachment block into a message's text — the "[Files attached for
/// context]" suffix shared by the live initial turn and both replay shapes.
/// No-op when there are no attachments.
pub(super) fn append_attachments(content: &mut String, attachments: &[AgentAttachment]) {
    if attachments.is_empty() {
        return;
    }
    let attached = attachments
        .iter()
        .map(|a| format!("File: {}\n```\n{}\n```", a.path, a.content))
        .collect::<Vec<_>>()
        .join("\n\n");
    if attached.is_empty() {
        return;
    }
    content.push_str("\n\n[Files attached for context]\n");
    content.push_str(&attached);
}

/// The system message that stands in for everything before a compaction
/// marker — identical in both replay shapes.
pub(super) fn compaction_system_message(summary: &str) -> serde_json::Value {
    serde_json::json!({
        "role": "system",
        "content": format!("[Earlier conversation compacted to save context]\n{summary}")
    })
}

pub(super) fn provider_messages(
    request: &StartRunRequest,
    system: String,
    run_id: &str,
) -> Vec<serde_json::Value> {
    let mut user_text = request.initial_text.clone();
    append_attachments(&mut user_text, &request.attachments);
    let mut messages = vec![serde_json::json!({ "role": "system", "content": system })];
    // Inject initial todo list as context for tool-capable/project turns.
    // Local chat should stay tiny; sending project metadata to MLX/Ollama for
    // "hello" made prompt processing feel broken.
    let should_include_todos = !(ProviderCaps::for_provider(&request.provider)
        .minimal_chat_context
        && matches!(request.mode, AgentMode::Chat));
    if should_include_todos {
        if let Some(cwd) = &request.workspace_root {
            if let Some(todo_text) = todo::list_todos_text(cwd, run_id) {
                messages.push(todo_context_message(Some(&todo_text)));
            }
        }
    }
    messages.push(serde_json::json!({ "role": "user", "content": user_text }));
    messages
}

fn todo_context_message(todo_text: Option<&str>) -> serde_json::Value {
    serde_json::json!({
        "role": "system",
        "content": match todo_text {
            Some(t) => format!("[TODO list]\n{t}"),
            None => "[TODO list]\nNo todos.".to_string(),
        }
    })
}

/// Refresh the existing TODO context message in-place. The run loop computes
/// the latest TODO text with I/O; this helper is pure over the provider message
/// array so the update rules are testable.
pub(super) fn refresh_todo_context(messages: &mut [serde_json::Value], todo_text: Option<&str>) {
    for msg in messages.iter_mut() {
        if msg.get("role").and_then(|v| v.as_str()) == Some("system")
            && msg
                .get("content")
                .and_then(|v| v.as_str())
                .map(|c| c.starts_with("[TODO list]"))
                .unwrap_or(false)
        {
            msg["content"] = todo_context_message(todo_text)["content"].clone();
            break;
        }
    }
}

/// The most-recent tool results are never compacted — they are the model's
/// active working set. A task like "read these N files, then summarize each"
/// needs the reads it just made to stay verbatim through the synthesis turn;
/// gutting them out from under the model forces a re-read, whose fresh result
/// the next pass guts again — a compaction death-spiral. Protecting a recency
/// window stops that loop: recent reads survive, and any re-read lands inside
/// the protected zone instead of feeding the spiral.
pub(super) const KEEP_RECENT_TOOL_RESULTS: usize = 8;

/// Rough prompt-token footprint of the whole message array. Compaction is
/// triggered off this, not a message count, so a short conversation keeps full
/// fidelity and we only sacrifice old tool results when the prompt genuinely
/// approaches the model's context window. The ~4-chars-per-token heuristic is
/// the same one the frontend token meter uses; serializing each message also
/// counts `tool_calls` and JSON punctuation, which biases the estimate high —
/// the safe direction (compact a little early rather than overflow).
pub(super) fn estimate_prompt_tokens(messages: &[serde_json::Value]) -> usize {
    messages.iter().map(|m| m.to_string().len()).sum::<usize>() / 4
}

/// Prompt-token budget above which older tool results get compacted. Carves
/// headroom out of the context window for the model's reply (`reply_reserve`,
/// i.e. `num_predict`) and the tool schemas the loop also ships each turn, so
/// the prompt never crowds the response out of the window.
pub(super) fn compaction_threshold(context_window: usize, reply_reserve: usize) -> usize {
    let schema_reserve = context_window / 8;
    context_window
        .saturating_sub(reply_reserve)
        .saturating_sub(schema_reserve)
        .max(1)
}

/// Auto-compaction, expressed purely. Replaces the body of *older* verbose
/// `role: "tool"` messages with a short summary and excerpt so a long
/// conversation doesn't blow the model's context window while still preserving
/// the shape of what happened. The system prompt (`skip(1)`) and the most
/// recent [`KEEP_RECENT_TOOL_RESULTS`] results are kept verbatim. Compacts
/// oldest-first and stops after 5 rewrites per pass; the loop calls it each
/// turn, so it catches up gradually. No I/O: it just mutates `messages`, which
/// makes it unit-testable without a supervisor.
pub(super) fn compact_old_tool_results(messages: &mut [serde_json::Value]) {
    let long_tool_results: Vec<usize> = messages
        .iter()
        .enumerate()
        .skip(1)
        .filter(|(_, m)| {
            m.get("role").and_then(|v| v.as_str()) == Some("tool")
                && m.get("content")
                    .and_then(|v| v.as_str())
                    .map(|s| s.len())
                    .unwrap_or(0)
                    > MIN_COMPACTABLE_BYTES
        })
        .map(|(i, _)| i)
        .collect();

    let eligible = long_tool_results
        .len()
        .saturating_sub(KEEP_RECENT_TOOL_RESULTS);
    for &i in long_tool_results.iter().take(eligible).take(5) {
        let msg = &mut messages[i];
        let name = msg
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("tool")
            .to_string();
        let content = msg
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let summary = compacted_tool_summary(&name, &content);
        // Defensive: compaction must never *grow* a message. The eligibility
        // threshold already guarantees this for well-formed text, but a result
        // dominated by multi-byte characters could in theory summarize larger;
        // if so, leave it verbatim.
        if summary.len() >= content.len() {
            continue;
        }
        msg["content"] = serde_json::Value::String(summary);
        if let Some(obj) = msg.as_object_mut() {
            obj.remove("name");
        }
    }
}

/// A `role: "tool"` result must exceed this byte size before it is worth
/// compacting. The summary header plus the [`compacted_tool_summary`] excerpt
/// runs a few hundred bytes, so compacting anything smaller would *grow* the
/// prompt — exactly the opposite of the point. Keep this comfortably above the
/// excerpt budget so every eligible result genuinely shrinks.
const MIN_COMPACTABLE_BYTES: usize = 1_000;

fn compacted_tool_summary(name: &str, content: &str) -> String {
    const EXCERPT_CHARS: usize = 600;
    let line_count = content.lines().count().max(1);
    let char_count = content.chars().count();
    let mut excerpt = content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .take(8)
        .collect::<Vec<_>>()
        .join("\n");
    if excerpt.is_empty() {
        excerpt = content.chars().take(EXCERPT_CHARS).collect();
    }
    if excerpt.chars().count() > EXCERPT_CHARS {
        excerpt = excerpt.chars().take(EXCERPT_CHARS).collect::<String>();
        excerpt.push_str("\n[excerpt truncated]");
    }
    format!("[compacted: {name}; original {line_count} line(s), {char_count} char(s)]\n{excerpt}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refresh_todo_context_updates_existing_message() {
        let mut messages = vec![
            serde_json::json!({ "role": "system", "content": "base" }),
            serde_json::json!({ "role": "system", "content": "[TODO list]\nold" }),
            serde_json::json!({ "role": "user", "content": "go" }),
        ];
        refresh_todo_context(&mut messages, Some("- [ ] new"));
        assert_eq!(messages[1]["content"], "[TODO list]\n- [ ] new");
        refresh_todo_context(&mut messages, None);
        assert_eq!(messages[1]["content"], "[TODO list]\nNo todos.");
    }

    #[test]
    fn refresh_todo_context_is_noop_without_todo_message() {
        let mut messages = vec![serde_json::json!({ "role": "system", "content": "base" })];
        refresh_todo_context(&mut messages, Some("- [ ] ignored"));
        assert_eq!(messages[0]["content"], "base");
    }

    #[test]
    fn provider_caps_isolate_the_quirks() {
        let ollama = ProviderCaps::for_provider("ollama");
        assert!(!ollama.structured_replay);
        assert!(ollama.minimal_chat_context);

        let mlx = ProviderCaps::for_provider("mlx");
        assert!(mlx.structured_replay);
        assert!(mlx.minimal_chat_context);

        for id in ["anthropic", "openai", "my-self-hosted-endpoint"] {
            let caps = ProviderCaps::for_provider(id);
            assert!(caps.structured_replay, "{id}");
            assert!(!caps.minimal_chat_context, "{id}");
        }
    }
}
