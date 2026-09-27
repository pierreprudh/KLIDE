//! Pure-ish run-loop helpers.
//!
//! This module owns provider-turn preparation decisions that do not need a
//! Tauri app handle: provider capability quirks, provider-message assembly,
//! TODO context refresh, and token-budget compaction.

use super::permission::{BlockReason, GateSubject};
use super::todo;
use super::tools::{
    clean_context_ids, parse_tool_calls, recover_text_tool_calls,
    tool_kind_label, NormalizedToolCall, ToolKind,
};
use super::types::{AgentAttachment, AgentContentBlock, AgentMode, StartRunRequest, ToolResult};
use crate::adapters::forwardable_image_media_type;
use crate::providers::AiChatResponse;
use crate::workspace;

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
    /// MLX prefix caches can reuse history only up to the first changed token.
    /// Keep old TODO snapshots stable and append changes for this provider.
    pub(super) append_todo_updates: bool,
}

impl ProviderCaps {
    pub(super) fn for_provider(provider: &str) -> Self {
        Self {
            structured_replay: provider != "ollama",
            minimal_chat_context: matches!(provider, "mlx" | "ollama"),
            append_todo_updates: provider == "mlx",
        }
    }
}


// ── Attachment clamp ──

/// The most attachments one turn may carry. Well above what a composer stages
/// (12) — this is a backstop against a producer with no UI, not a second
/// opinion about what a user may attach.
pub(super) const MAX_ATTACHMENTS: usize = 16;
/// The most one image may weigh, decoded.
pub(super) const MAX_IMAGE_BYTES: usize = 6_000_000;
/// The most every image on a turn may weigh together. The per-image cap alone
/// admits a 70 MB request body, which no provider accepts and which lands in
/// the transcript either way.
pub(super) const MAX_TOTAL_IMAGE_BYTES: usize = 12_000_000;

/// What survived the clamp, and a note for everything that didn't.
pub(super) struct ClampedAttachments {
    pub(super) kept: Vec<AgentAttachment>,
    /// `AgentContextSnapshot::omitted` rows — `{ reason, path?, count? }`, the
    /// vocabulary the panel already reads for "this didn't reach the model".
    pub(super) omitted: Vec<serde_json::Value>,
}

fn omission(reason: &str, path: &str) -> serde_json::Value {
    serde_json::json!({ "reason": reason, "path": path })
}

/// Hold a turn's attachments to what the wires and the transcript can actually
/// take, before either sees them.
///
/// The composers apply richer rules and say so in the UI (see
/// `src/components/ai/attachments.ts`); those are taste, and they only bind the
/// two surfaces that run them. This is the invariant, and it binds every
/// producer — a race, a Mission, a subagent, Mission Control's recovered
/// Claude Code images — because they all enter through `start_run`:
///
///  · an image must be a base64 data URI in a format the adapters forward,
///    or it is dropped here rather than dropped silently mid-translation;
///  · images are bounded per-image and per-turn, so no run can post a body a
///    provider refuses or append a transcript line nothing can reopen;
///  · a text attachment is truncated, not dropped — the same ceiling the read
///    tool applies to one file, since that is the same question.
///
/// Nothing is refused as an error: a run losing one attachment should still
/// run, and the drop is recorded where the UI can name it.
pub(super) fn clamp_attachments(attachments: Vec<AgentAttachment>) -> ClampedAttachments {
    let offered = attachments.len();
    let mut kept: Vec<AgentAttachment> = Vec::with_capacity(offered.min(MAX_ATTACHMENTS));
    let mut omitted: Vec<serde_json::Value> = Vec::new();
    let mut image_bytes: usize = 0;

    for attachment in attachments.into_iter().take(MAX_ATTACHMENTS) {
        let Some(uri) = attachment.data_uri.clone() else {
            kept.push(clamp_document(attachment, &mut omitted));
            continue;
        };
        let Some((media_type, data)) = uri
            .strip_prefix("data:")
            .and_then(|rest| rest.split_once(";base64,"))
        else {
            omitted.push(omission("not a base64 image data URI", &attachment.path));
            continue;
        };
        if data.is_empty() || !forwardable_image_media_type(media_type) {
            omitted.push(omission(
                "image format no provider wire accepts",
                &attachment.path,
            ));
            continue;
        }
        // Base64 carries three bytes in every four characters.
        let bytes = data.len() / 4 * 3;
        if bytes > MAX_IMAGE_BYTES {
            omitted.push(omission("image too large", &attachment.path));
            continue;
        }
        if image_bytes + bytes > MAX_TOTAL_IMAGE_BYTES {
            omitted.push(omission("turn already full of images", &attachment.path));
            continue;
        }
        image_bytes += bytes;
        kept.push(attachment);
    }

    if offered > MAX_ATTACHMENTS {
        omitted.push(serde_json::json!({
            "reason": "more attachments than one turn carries",
            "count": offered - MAX_ATTACHMENTS,
        }));
    }
    ClampedAttachments { kept, omitted }
}

fn clamp_document(
    mut attachment: AgentAttachment,
    omitted: &mut Vec<serde_json::Value>,
) -> AgentAttachment {
    let limit = workspace::AGENT_MAX_READ_BYTES as usize;
    if attachment.content.len() <= limit {
        return attachment;
    }
    let mut cut = limit;
    while cut > 0 && !attachment.content.is_char_boundary(cut) {
        cut -= 1;
    }
    attachment.content.truncate(cut);
    attachment.content.push_str("\n…(truncated)");
    omitted.push(omission("document truncated", &attachment.path));
    attachment
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

/// Refresh TODO state before a provider turn. MLX gets a new snapshot only
/// when state changes, after all completed tool results, so an update doesn't
/// invalidate the cached conversation prefix. Other providers keep their
/// existing single-message policy. The caller excludes minimal local Chat.
///
/// These snapshots are run-local, like the old TODO injection: transcript
/// replay rebuilds the initial state on resume. This preserves the prefix
/// between tool turns; it does not promise cache hits across resumed runs.
pub(super) fn refresh_todo_context(
    messages: &mut Vec<serde_json::Value>,
    todo_text: Option<&str>,
    append_updates: bool,
) {
    let is_todo = |msg: &serde_json::Value| {
        msg["role"] == "system"
            && msg["content"]
                .as_str()
                .is_some_and(|c| c.starts_with("[TODO list]"))
    };
    let next = todo_context_message(todo_text);
    if append_updates {
        let previous = messages.iter().rev().find(|msg| is_todo(msg));
        if previous == Some(&next) || (previous.is_none() && todo_text.is_none()) {
            return;
        }
        messages.push(next);
    } else if let Some(msg) = messages.iter_mut().find(|msg| is_todo(msg)) {
        msg["content"] = next["content"].clone();
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
    /// The model spent its whole output budget inside the private reasoning
    /// channel and returned no answer and no tool call. `content` is what to
    /// show if the loop chooses not to resample (its retries are spent).
    Runaway { content: Vec<AgentContentBlock> },
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

/// Did this tool-free turn burn its whole reply budget on private reasoning?
///
/// Hitting the reply cap has two opposite shapes and they need opposite
/// handling. *With* visible text the model was answering and got cut off, so
/// what it wrote is worth keeping. *Without* any, the budget went entirely into
/// the reasoning channel and the turn carries nothing — resampling at a smaller
/// cap usually recovers it, where keeping it ends the run on a notice and
/// nothing else. Reasoning models behind local servers do this routinely.
///
/// Deliberately keyed on `stop_reason` alone. FrontierAgent, where this came
/// from, also infers a runaway from a large completion when a gateway drops the
/// stop reason — but that heuristic is unsafe here: LFM2.5 and its fine-tunes
/// route a genuine, complete answer into the reasoning channel (see
/// `empty_content_promotes_thinking_to_the_answer`), and a long one would be
/// indistinguishable from a runaway by size. Discarding a real answer is far
/// worse than missing a runaway, so we only act on the provider saying outright
/// that it hit the cap.
///
/// The caller has already established there are no tool calls.
fn is_reasoning_runaway(response: &AiChatResponse, content_text: &str) -> bool {
    content_text.trim().is_empty() && response.stop_reason.as_deref() == Some("length")
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
        // The two shapes of a capped reply want different words. Cut off
        // mid-answer, the fix is room to finish. Cut off with nothing visible,
        // the reply never started — pointing the user at num_ctx there sends
        // them to tune the wrong number.
        let runaway = is_reasoning_runaway(response, &content_text);
        if runaway {
            answer_text.push_str(
                "\n\n---\n_⚠ The model spent its entire reply budget on internal reasoning \
and produced no answer. Lower this model's Effort in Settings → Harness so it reasons more \
briefly, or switch to a model that gets to the point sooner._",
            );
        } else if response.stop_reason.as_deref() == Some("length") {
            answer_text.push_str(
                "\n\n---\n_⚠ Response cut off — the model hit its context limit (num_ctx) \
mid-answer. Raise this model's context window in Settings → Harness, or start a fresh \
conversation, then ask again._",
            );
        }
        content.push(AgentContentBlock::Text { text: answer_text });
        TurnStep {
            assistant_message,
            decision: if runaway {
                TurnDecision::Runaway { content }
            } else {
                TurnDecision::Final { content }
            },
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
    subject: &GateSubject,
    call: &NormalizedToolCall,
    kind: Option<ToolKind>,
) -> ToolStepPlan {
    let content = match subject.permits(&call.name, kind) {
        Ok(()) => return ToolStepPlan::Execute { kind },
        Err(BlockReason::Disabled) => format!(
            "Tool '{}' is turned off for this run and was not called. Continue without it.",
            call.name
        ),
        // Chat is conversation-only — it offers no tools at all. When a
        // model (especially an agentic fine-tune) calls one anyway, give an
        // actionable nudge rather than a bare capability error, so the model
        // stops retrying and the user knows which mode to switch to.
        Err(BlockReason::Mode(kind)) => match subject.mode {
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
                subject.mode
            ),
        },
    };
    ToolStepPlan::Blocked {
        result: ToolResult {
            ok: false,
            content,
            metadata: None,
        },
    }
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
        .filter(|call| {
            matches!(
                kind_for(call, workspace_root),
                Some(ToolKind::ReadOnly | ToolKind::ProjectMemory)
            )
        })
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

    fn photo(path: &str, mime: &str, chars: usize) -> AgentAttachment {
        AgentAttachment {
            path: path.to_string(),
            content: String::new(),
            mime: Some(mime.to_string()),
            data_uri: Some(format!("data:{mime};base64,{}", "A".repeat(chars))),
        }
    }

    fn document(path: &str, content: &str) -> AgentAttachment {
        AgentAttachment {
            path: path.to_string(),
            content: content.to_string(),
            mime: None,
            data_uri: None,
        }
    }

    fn reasons(omitted: &[serde_json::Value]) -> Vec<String> {
        omitted
            .iter()
            .map(|o| o["reason"].as_str().unwrap_or_default().to_string())
            .collect()
    }

    #[test]
    fn clamp_keeps_a_forwardable_photo_and_a_document() {
        let clamped = clamp_attachments(vec![
            photo("shot.png", "image/png", 64),
            document("notes.md", "hi"),
        ]);
        assert_eq!(clamped.omitted.len(), 0);
        assert_eq!(
            clamped.kept.iter().map(|a| a.path.as_str()).collect::<Vec<_>>(),
            vec!["shot.png", "notes.md"]
        );
    }

    #[test]
    fn clamp_drops_an_image_format_no_wire_accepts() {
        // The adapters would drop this mid-translation and say nothing; the
        // clamp is where it becomes visible.
        let clamped = clamp_attachments(vec![photo("IMG_1.heic", "image/heic", 64)]);
        assert!(clamped.kept.is_empty());
        assert_eq!(reasons(&clamped.omitted), vec!["image format no provider wire accepts"]);
        assert_eq!(clamped.omitted[0]["path"], "IMG_1.heic");
    }

    #[test]
    fn clamp_drops_a_data_uri_that_is_not_base64() {
        let mut broken = photo("odd.png", "image/png", 8);
        broken.data_uri = Some("https://example.com/shot.png".to_string());
        let clamped = clamp_attachments(vec![broken]);
        assert!(clamped.kept.is_empty());
        assert_eq!(reasons(&clamped.omitted), vec!["not a base64 image data URI"]);
    }

    #[test]
    fn clamp_bounds_one_image_and_the_whole_turn() {
        let per_image_chars = (MAX_IMAGE_BYTES / 3 * 4) + 8;
        let clamped = clamp_attachments(vec![photo("huge.png", "image/png", per_image_chars)]);
        assert!(clamped.kept.is_empty());
        assert_eq!(reasons(&clamped.omitted), vec!["image too large"]);

        // Three images that each clear the per-image cap but together do not.
        let each = 5_000_000 / 3 * 4;
        let clamped = clamp_attachments(vec![
            photo("a.png", "image/png", each),
            photo("b.png", "image/png", each),
            photo("c.png", "image/png", each),
        ]);
        assert_eq!(
            clamped.kept.iter().map(|a| a.path.as_str()).collect::<Vec<_>>(),
            vec!["a.png", "b.png"]
        );
        assert_eq!(reasons(&clamped.omitted), vec!["turn already full of images"]);
    }

    #[test]
    fn clamp_truncates_a_document_rather_than_dropping_it() {
        let long = "x".repeat(workspace::AGENT_MAX_READ_BYTES as usize + 500);
        let clamped = clamp_attachments(vec![document("log.txt", &long)]);
        assert_eq!(clamped.kept.len(), 1);
        assert!(clamped.kept[0].content.len() < long.len());
        assert!(clamped.kept[0].content.ends_with("…(truncated)"));
        assert_eq!(reasons(&clamped.omitted), vec!["document truncated"]);
    }

    #[test]
    fn clamp_truncates_a_document_on_a_char_boundary() {
        // A multi-byte char straddling the ceiling must not be cut in half —
        // `String::truncate` panics on a non-boundary index.
        let long = "é".repeat(workspace::AGENT_MAX_READ_BYTES as usize);
        let clamped = clamp_attachments(vec![document("accents.txt", &long)]);
        assert_eq!(clamped.kept.len(), 1);
        assert!(clamped.kept[0].content.ends_with("…(truncated)"));
    }

    #[test]
    fn clamp_caps_how_many_attachments_a_turn_carries() {
        let offered: Vec<AgentAttachment> = (0..MAX_ATTACHMENTS + 3)
            .map(|i| document(&format!("f{i}.md"), "x"))
            .collect();
        let clamped = clamp_attachments(offered);
        assert_eq!(clamped.kept.len(), MAX_ATTACHMENTS);
        assert_eq!(clamped.omitted[0]["count"], 3);
    }

    #[test]
    fn refresh_todo_context_updates_existing_message() {
        let mut messages = vec![
            serde_json::json!({ "role": "system", "content": "base" }),
            serde_json::json!({ "role": "system", "content": "[TODO list]\nold" }),
            serde_json::json!({ "role": "user", "content": "go" }),
        ];
        refresh_todo_context(&mut messages, Some("- [ ] new"), false);
        assert_eq!(messages[1]["content"], "[TODO list]\n- [ ] new");
        refresh_todo_context(&mut messages, None, false);
        assert_eq!(messages[1]["content"], "[TODO list]\nNo todos.");
    }

    #[test]
    fn refresh_todo_context_is_noop_without_todo_message() {
        let mut messages = vec![serde_json::json!({ "role": "system", "content": "base" })];
        refresh_todo_context(&mut messages, Some("- [ ] ignored"), false);
        assert_eq!(messages[0]["content"], "base");
    }

    #[test]
    fn appended_todo_context_deduplicates_and_records_clearing() {
        let mut messages = vec![serde_json::json!({ "role": "system", "content": "base" })];
        refresh_todo_context(&mut messages, None, true);
        assert_eq!(messages.len(), 1, "an empty list needs no initial snapshot");
        refresh_todo_context(&mut messages, Some("[ ] T1: test"), true);
        let prefix = messages.clone();
        refresh_todo_context(&mut messages, Some("[ ] T1: test"), true);
        assert_eq!(messages, prefix, "unchanged snapshots must not accumulate");
        refresh_todo_context(&mut messages, None, true);
        assert_eq!(&messages[..prefix.len()], prefix.as_slice());
        assert_eq!(messages.last().unwrap()["content"], "[TODO list]\nNo todos.");
        refresh_todo_context(&mut messages, None, true);
        assert_eq!(messages.len(), prefix.len() + 1);
    }

    #[test]
    fn provider_caps_isolate_the_quirks() {
        let ollama = ProviderCaps::for_provider("ollama");
        assert!(!ollama.structured_replay);
        assert!(ollama.minimal_chat_context);

        let mlx = ProviderCaps::for_provider("mlx");
        assert!(mlx.structured_replay);
        assert!(mlx.minimal_chat_context);
        assert!(mlx.append_todo_updates);
        assert!(!ollama.append_todo_updates);

        for id in ["anthropic", "openai", "my-self-hosted-endpoint"] {
            let caps = ProviderCaps::for_provider(id);
            assert!(caps.structured_replay, "{id}");
            assert!(!caps.minimal_chat_context, "{id}");
            assert!(!caps.append_todo_updates, "{id}");
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
            &GateSubject::for_mode(AgentMode::Chat),
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
            &GateSubject::for_mode(AgentMode::Plan),
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
            &GateSubject::for_mode(AgentMode::Plan),
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
            ToolKind::ConversationHistory,
            ToolKind::ProjectMemory,
            ToolKind::Write,
            ToolKind::Command,
            ToolKind::Pause,
            ToolKind::Network,
        ] {
            match plan_tool_step(&GateSubject::for_mode(AgentMode::Goal), &call("tool"), Some(kind)) {
                ToolStepPlan::Execute { kind: actual } => assert_eq!(actual, Some(kind)),
                ToolStepPlan::Blocked { result } => {
                    panic!("goal capability was blocked: {result:?}")
                }
            }
        }
    }

    #[test]
    fn plan_tool_step_preserves_unknown_tool_path() {
        match plan_tool_step(&GateSubject::for_mode(AgentMode::Goal), &call("made_up"), None) {
            ToolStepPlan::Execute { kind } => assert_eq!(kind, None),
            ToolStepPlan::Blocked { .. } => panic!("unknown tools should reach normal execution"),
        }
    }

    #[test]
    fn plan_tool_step_blocks_a_disabled_tool_the_mode_allows() {
        let mut request = super::super::test_support::test_request("/workspace", &[]);
        request.disabled_tools = vec!["spawn_subagent".to_string()];
        let subject = GateSubject::from_request(&request);
        match plan_tool_step(&subject, &call("spawn_subagent"), Some(ToolKind::Pause)) {
            ToolStepPlan::Blocked { result } => {
                assert!(!result.ok);
                assert!(result.content.contains("turned off"), "{}", result.content);
            }
            ToolStepPlan::Execute { .. } => panic!("a disabled tool must not dispatch"),
        }
    }

    #[test]
    fn a_child_run_cannot_call_the_pause_tools_it_was_never_offered() {
        let mut request = super::super::test_support::test_request("/workspace", &[]);
        request.parent_id = Some("parent".to_string());
        request.disabled_tools = super::super::tools::interactive_tool_names();
        let subject = GateSubject::from_request(&request);
        match plan_tool_step(&subject, &call("userAnswerQuestion"), Some(ToolKind::Pause)) {
            ToolStepPlan::Blocked { result } => assert!(!result.ok),
            ToolStepPlan::Execute { .. } => panic!("a child has nothing to answer a question"),
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
