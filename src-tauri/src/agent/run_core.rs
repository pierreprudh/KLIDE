//! Pure-ish run-loop helpers.
//!
//! This module owns provider-turn preparation decisions that do not need a
//! Tauri app handle: provider capability quirks, provider-message assembly,
//! TODO context refresh, and token-budget compaction.

use super::todo;
use super::tools::{
    clean_context_ids, parse_tool_calls, recover_text_tool_calls, tool_allowed_in_mode,
    tool_kind_label, NormalizedToolCall, ToolKind,
};
use super::types::{AgentAttachment, AgentContentBlock, AgentMode, StartRunRequest, ToolResult};
use crate::AiChatResponse;

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

/// Fold text attachments into a message's text — the "[Files attached for
/// context]" suffix shared by the live initial turn and both replay shapes.
/// Image attachments (those carrying a `data_uri`) are skipped here: they ride
/// the message's neutral `images` array instead (see `user_provider_message`).
/// No-op when there are no text attachments.
pub(super) fn append_attachments(content: &mut String, attachments: &[AgentAttachment]) {
    let attached = attachments
        .iter()
        .filter(|a| a.data_uri.is_none())
        .map(|a| format!("File: {}\n```\n{}\n```", a.path, a.content))
        .collect::<Vec<_>>()
        .join("\n\n");
    if attached.is_empty() {
        return;
    }
    content.push_str("\n\n[Files attached for context]\n");
    content.push_str(&attached);
}

/// Assemble a provider user message from a turn's text + attachments. Text
/// attachments fold into the content string; image attachments become a
/// neutral message-level `images` array (data URIs) that each provider adapter
/// translates to its own wire shape. Shared by the live initial turn and both
/// replay shapes so images survive a reopened conversation.
pub(super) fn user_provider_message(
    text: &str,
    attachments: &[AgentAttachment],
) -> serde_json::Value {
    let mut content = text.to_string();
    append_attachments(&mut content, attachments);
    let mut message = serde_json::json!({ "role": "user", "content": content });
    let images: Vec<String> = attachments
        .iter()
        .filter_map(|a| a.data_uri.clone())
        .collect();
    if !images.is_empty() {
        message["images"] = serde_json::json!(images);
    }
    message
}

/// The system message that stands in for everything before a compaction
/// marker — identical in both replay shapes.
pub(super) fn compaction_system_message(summary: &str) -> serde_json::Value {
    serde_json::json!({
        "role": "system",
        "content": format!("[Earlier conversation compacted to save context]\n{summary}")
    })
}

pub(super) fn assistant_provider_message(
    content: &str,
    raw_tool_calls: &[serde_json::Value],
) -> serde_json::Value {
    let mut message = serde_json::json!({
        "role": "assistant",
        "content": content,
    });
    if !raw_tool_calls.is_empty() {
        message["tool_calls"] = serde_json::Value::Array(raw_tool_calls.to_vec());
    }
    message
}

pub(super) fn tool_provider_message(
    call: &NormalizedToolCall,
    result: &ToolResult,
) -> serde_json::Value {
    serde_json::json!({
        "role": "tool",
        "content": result.content,
        "name": call.name,
        "tool_call_id": call.id,
    })
}

pub(super) fn provider_messages(
    request: &StartRunRequest,
    system: String,
    run_id: &str,
) -> Vec<serde_json::Value> {
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
    messages.push(user_provider_message(
        &request.initial_text,
        &request.attachments,
    ));
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

/// The pure outcome of interpreting one assistant turn's provider response —
/// the heart of the run loop with every Tauri / channel / filesystem
/// dependency stripped out. `decide_turn` decides whether the model produced a
/// final answer or wants to call tools, and assembles the exact content blocks
/// the loop emits.
pub(super) enum TurnDecision {
    /// The model produced a tool-free answer — the run is complete. `content`
    /// is the finalized `AssistantMessage` body: thinking promoted to the
    /// answer when `content` was empty (otherwise preserved as its own block),
    /// with the truncation notice appended when the provider cut the reply off.
    Final { content: Vec<AgentContentBlock> },
    /// The model requested one or more tools. `content` is the assistant body
    /// (thinking + text + tool-call blocks); `tool_calls` are the normalized,
    /// id-stamped calls the loop executes in order.
    Continue {
        content: Vec<AgentContentBlock>,
        tool_calls: Vec<NormalizedToolCall>,
    },
}

/// One turn's decision plus the provider-wire assistant message the loop pushes
/// into `messages` (so the next turn replays this turn's reasoning + tool
/// calls). The loop pushes `assistant_message`, then acts on `decision`.
pub(super) struct TurnStep {
    pub(super) assistant_message: serde_json::Value,
    pub(super) decision: TurnDecision,
}

/// Interpret one assistant turn purely: normalize tool calls (including the
/// text-embedded recovery path for local models that narrate calls instead of
/// emitting the structured field), stamp fallback ids unique across the run,
/// and assemble the content blocks. `prior_turns` + `turn` only feed the id
/// stamping; everything else is derived from `response`.
pub(super) fn decide_turn(response: &AiChatResponse, prior_turns: usize, turn: usize) -> TurnStep {
    let mut tool_calls = parse_tool_calls(&response.tool_calls);
    let mut raw_tool_calls = response.tool_calls.clone();
    let mut content_text = response.content.clone();
    let mut thinking_text = response.thinking.clone();
    // Recovery path: some local models (LFM2/LFM2.5, and fine-tunes like
    // klide-8b) emit tool calls as `<|tool_call_start|>...<|tool_call_end|>`
    // text instead of the structured field — and route that text into either
    // the content or thinking channel.
    if tool_calls.is_empty() {
        // No native calls: run the full recovery (delimited form plus the
        // fuzzy JSON-action / "Applied:" fallbacks) over content, then thinking.
        let (mut recovered, mut cleaned_content) = recover_text_tool_calls(&content_text);
        if recovered.is_empty() {
            if let Some(th) = thinking_text.as_deref() {
                let (rt, cleaned_thinking) = recover_text_tool_calls(th);
                if !rt.is_empty() {
                    recovered = rt;
                    cleaned_content = content_text.clone();
                    thinking_text = if cleaned_thinking.is_empty() {
                        None
                    } else {
                        Some(cleaned_thinking)
                    };
                }
            }
        }
        if !recovered.is_empty() {
            raw_tool_calls = recovered
                .iter()
                .map(|c| {
                    serde_json::json!({
                        "function": { "name": c.name, "arguments": c.input }
                    })
                })
                .collect();
            tool_calls = recovered;
            content_text = cleaned_content;
        }
    } else if content_text.contains("<|tool_call_start|>") {
        // A native call is present but the model ALSO narrated a call in the
        // unambiguous delimited form in the same response (small models mix
        // formats). Merge the delimited call so it isn't rendered as raw tokens
        // to the user. Guarded on the marker so the fuzzy JSON-action fallback
        // never mistakes a strong model's JSON answer for a tool call.
        let (extra, cleaned) = recover_text_tool_calls(&content_text);
        if !extra.is_empty() {
            content_text = cleaned;
            for c in &extra {
                raw_tool_calls.push(serde_json::json!({
                    "function": { "name": c.name, "arguments": c.input }
                }));
            }
            tool_calls.extend(extra);
        }
    }

    // Fallback ids ("tool_<idx>") are only unique within one response — and a
    // text-recovered call merged in above can reuse an index a native call
    // already took. Stamp the turn AND the call's position in the merged list
    // so every fallback id stays unique across the whole run.
    let turn_label = prior_turns + turn;
    for (idx, call) in tool_calls.iter_mut().enumerate() {
        if call.id.starts_with("tool_") {
            call.id = format!("turn{turn_label}_tool_{idx}");
        }
    }
    let tool_calls = tool_calls;
    let assistant_message = assistant_provider_message(&content_text, &raw_tool_calls);

    if tool_calls.is_empty() {
        let mut content = Vec::new();
        let thinking = thinking_text.filter(|t| !t.trim().is_empty());
        let mut answer_text = if content_text.trim().is_empty() {
            thinking.clone().unwrap_or_default()
        } else {
            if let Some(t) = thinking.clone() {
                content.push(AgentContentBlock::Thinking { text: t });
            }
            content_text.clone()
        };
        if response.stop_reason.as_deref() == Some("length") {
            answer_text.push_str(
                "\n\n---\n_⚠ Response cut off — the model hit its context limit (num_ctx) \
mid-answer. Raise this model's context window in Settings → Harness, or start a fresh \
conversation, then ask again._",
            );
        }
        content.push(AgentContentBlock::Text { text: answer_text });
        TurnStep {
            assistant_message,
            decision: TurnDecision::Final { content },
        }
    } else {
        let mut content = Vec::new();
        if let Some(t) = thinking_text.as_deref() {
            if !t.trim().is_empty() {
                content.push(AgentContentBlock::Thinking {
                    text: t.to_string(),
                });
            }
        }
        if !content_text.trim().is_empty() {
            content.push(AgentContentBlock::Text {
                text: content_text.clone(),
            });
        }
        for call in &tool_calls {
            content.push(AgentContentBlock::ToolCall {
                tool_call_id: call.id.clone(),
                name: call.name.clone(),
                input: call.input.clone(),
            });
        }
        TurnStep {
            assistant_message,
            decision: TurnDecision::Continue {
                content,
                tool_calls,
            },
        }
    }
}

/// Pure plan for one tool call after the loop has resolved the call's kind.
/// Execution stays in `mod.rs`; this only answers whether the call should run
/// or be rejected because its capability is outside the current mode.
pub(super) enum ToolStepPlan {
    Execute { kind: Option<ToolKind> },
    Blocked { result: ToolResult },
}

pub(super) fn plan_tool_step(
    mode: &AgentMode,
    call: &NormalizedToolCall,
    kind: Option<ToolKind>,
) -> ToolStepPlan {
    // consult_advisor is a side-effect-free Pause tool allowed in Plan and Goal
    // (see tools::ADVISOR_TOOL) — bypass the generic Pause-is-Goal-only gate.
    if call.name == super::tools::ADVISOR_TOOL && !matches!(mode, AgentMode::Chat) {
        return ToolStepPlan::Execute { kind };
    }
    if let Some(kind) = kind {
        if !tool_allowed_in_mode(mode, kind) {
            // Chat is conversation-only — it offers no tools at all. When a
            // model (especially an agentic fine-tune) calls one anyway, give an
            // actionable nudge rather than a bare capability error, so the model
            // stops retrying and the user knows which mode to switch to.
            let content = match mode {
                AgentMode::Chat => format!(
                    "Chat is a conversation-only mode with no tools, so '{}' ({} capability) \
                     is not available in Chat mode. Switch to Goal mode to let me edit files and \
                     run commands, or Plan mode for read-only tools.",
                    call.name,
                    tool_kind_label(kind),
                ),
                _ => format!(
                    "Tool '{}' has {} capability and is not available in {:?} mode.",
                    call.name,
                    tool_kind_label(kind),
                    mode
                ),
            };
            return ToolStepPlan::Blocked {
                result: ToolResult {
                    ok: false,
                    content,
                    metadata: None,
                },
            };
        }
    }
    ToolStepPlan::Execute { kind }
}

/// Choose the read-only calls worth precomputing in parallel. This is pure over
/// the call list: no threads, no filesystem, and no event emission.
pub(super) fn parallel_read_calls<F>(
    calls: &[NormalizedToolCall],
    workspace_root: Option<&str>,
    max_parallel: usize,
    mut kind_for: F,
) -> Vec<NormalizedToolCall>
where
    F: FnMut(&NormalizedToolCall, Option<&str>) -> Option<ToolKind>,
{
    if max_parallel <= 1 || workspace_root.is_none() {
        return Vec::new();
    }
    let reads: Vec<NormalizedToolCall> = calls
        .iter()
        .filter(|call| matches!(kind_for(call, workspace_root), Some(ToolKind::ReadOnly)))
        .cloned()
        .collect();
    if reads.len() > 1 {
        reads
    } else {
        Vec::new()
    }
}

pub(super) fn clean_context_request(call: &NormalizedToolCall) -> Option<Vec<String>> {
    if call.name != "clean_context" {
        return None;
    }
    Some(
        call.input
            .get("ids")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
    )
}

pub(super) fn apply_clean_context_if_requested(
    call: &NormalizedToolCall,
    messages: &mut Vec<serde_json::Value>,
) {
    if let Some(ids) = clean_context_request(call) {
        clean_context_ids(&ids, messages);
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
    // Images cost tokens by resolution (~1–1.6K for a typical screenshot), not
    // by base64 length. Counting the data URI — hundreds of KB per image —
    // would wildly overcount and trigger needless tool-result compaction, so
    // exclude the `images` payload from the char count and add a flat estimate.
    let mut chars = 0usize;
    let mut images = 0usize;
    for m in messages {
        match m.get("images").and_then(|v| v.as_array()) {
            Some(arr) => {
                images += arr.len();
                let mut without = m.clone();
                if let Some(obj) = without.as_object_mut() {
                    obj.remove("images");
                }
                chars += without.to_string().len();
            }
            None => chars += m.to_string().len(),
        }
    }
    chars / 4 + images * 1200
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

    fn call(name: &str) -> NormalizedToolCall {
        NormalizedToolCall {
            id: format!("call_{name}"),
            name: name.to_string(),
            input: serde_json::json!({}),
        }
    }

    #[test]
    fn plan_tool_step_blocks_every_known_tool_in_chat_mode() {
        match plan_tool_step(
            &AgentMode::Chat,
            &call("read_file"),
            Some(ToolKind::ReadOnly),
        ) {
            ToolStepPlan::Blocked { result } => {
                assert!(!result.ok);
                assert!(result.content.contains("not available in Chat mode"));
                assert!(result.content.contains("read workspace"));
            }
            ToolStepPlan::Execute { .. } => panic!("chat mode must not execute tools"),
        }
    }

    #[test]
    fn plan_tool_step_allows_read_only_tools_in_plan_mode() {
        match plan_tool_step(
            &AgentMode::Plan,
            &call("read_file"),
            Some(ToolKind::ReadOnly),
        ) {
            ToolStepPlan::Execute { kind } => assert_eq!(kind, Some(ToolKind::ReadOnly)),
            ToolStepPlan::Blocked { result } => panic!("read-only tool was blocked: {result:?}"),
        }
    }

    #[test]
    fn plan_tool_step_blocks_commands_in_plan_mode() {
        match plan_tool_step(
            &AgentMode::Plan,
            &call("run_command"),
            Some(ToolKind::Command),
        ) {
            ToolStepPlan::Blocked { result } => {
                assert!(!result.ok);
                assert!(result.content.contains("run command"));
                assert!(result.content.contains("Plan mode"));
            }
            ToolStepPlan::Execute { .. } => panic!("plan mode must not execute commands"),
        }
    }

    #[test]
    fn plan_tool_step_allows_goal_capabilities() {
        for kind in [
            ToolKind::ReadOnly,
            ToolKind::Write,
            ToolKind::Command,
            ToolKind::Pause,
            ToolKind::Network,
        ] {
            match plan_tool_step(&AgentMode::Goal, &call("tool"), Some(kind)) {
                ToolStepPlan::Execute { kind: actual } => assert_eq!(actual, Some(kind)),
                ToolStepPlan::Blocked { result } => {
                    panic!("goal capability was blocked: {result:?}")
                }
            }
        }
    }

    #[test]
    fn plan_tool_step_preserves_unknown_tool_path() {
        match plan_tool_step(&AgentMode::Goal, &call("made_up"), None) {
            ToolStepPlan::Execute { kind } => assert_eq!(kind, None),
            ToolStepPlan::Blocked { .. } => panic!("unknown tools should reach normal execution"),
        }
    }

    #[test]
    fn parallel_read_calls_selects_only_read_batch_when_useful() {
        let calls = vec![call("read_a"), call("write_a"), call("read_b")];
        let selected = parallel_read_calls(&calls, Some("/workspace"), 3, |call, _root| {
            if call.name.starts_with("read") {
                Some(ToolKind::ReadOnly)
            } else {
                Some(ToolKind::Write)
            }
        });
        assert_eq!(selected.len(), 2);
        assert_eq!(selected[0].name, "read_a");
        assert_eq!(selected[1].name, "read_b");

        assert!(
            parallel_read_calls(&calls, Some("/workspace"), 1, |_call, _root| {
                Some(ToolKind::ReadOnly)
            })
            .is_empty()
        );
        assert!(
            parallel_read_calls(&calls, None, 3, |_call, _root| { Some(ToolKind::ReadOnly) })
                .is_empty()
        );
    }

    #[test]
    fn clean_context_request_extracts_ids_and_apply_cleans_messages() {
        let clean = NormalizedToolCall {
            id: "clean".to_string(),
            name: "clean_context".to_string(),
            input: serde_json::json!({ "ids": ["a", "missing"] }),
        };
        assert_eq!(
            clean_context_request(&clean).as_deref(),
            Some(&["a".to_string(), "missing".to_string()][..])
        );

        let mut messages = vec![
            serde_json::json!({ "role": "tool", "tool_call_id": "a", "name": "grep", "content": "noisy result" }),
            serde_json::json!({ "role": "tool", "tool_call_id": "b", "name": "read_file", "content": "keep me" }),
        ];
        apply_clean_context_if_requested(&clean, &mut messages);
        assert_eq!(messages[0]["content"], "[cleaned: grep]");
        assert!(messages[0].get("name").is_none());
        assert_eq!(messages[1]["content"], "keep me");
    }
}
