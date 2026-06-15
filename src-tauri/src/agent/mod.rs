pub mod todo;
pub mod tools;
pub mod transcripts;
pub mod types;

use self::tools::{
    apply_write, clean_context_ids, clear_run_snapshots, execute_read_only_tool,
    execute_write_tool_preview, is_user_question_tool, is_write_tool, parse_tool_calls,
    recover_text_tool_calls, schemas_for_mode, NormalizedToolCall,
};
use self::transcripts::{
    app_runs_dir, append_event, list_summaries, now_ms, read_events, run_id, transcript_path,
    write_summary,
};
use self::types::{
    AgentContentBlock, AgentContextSnapshot, AgentError, AgentEvent, AgentMode, AgentRunStatus,
    AgentRunSummary, AgentUsage, DiffDecisionRequest, PermissionDecisionRequest, StartRunRequest,
    StartRunResponse, SubmitUserTurnRequest, ToolResult,
};
use crate::{ai_chat, AiUsage, StreamChunk};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::Manager;
use tokio_util::sync::CancellationToken;

/// Live handle to a run: its current status plus a cancellation token the
/// loop polls. Aborting cancels the token; the loop observes it and settles
/// the run (event + summary + status) itself, so there is one writer.
pub struct AgentRunHandle {
    pub status: AgentRunStatus,
    pub cancel: CancellationToken,
    /// When the loop pauses for a diff review, it stores a oneshot sender
    /// here so agent_resolve_diff can unblock it.
    pub pending_diff: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<String>>>,
    /// Same pattern as `pending_diff`, but for the `userAnswerQuestion` tool.
    /// The agent_resolve_question command sends the user's typed answer
    /// through the channel, which the run loop awaits before continuing.
    pub pending_question: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<String>>>,
}

pub struct AgentSupervisorState {
    pub runs: Mutex<HashMap<String, AgentRunHandle>>,
}

impl Default for AgentSupervisorState {
    fn default() -> Self {
        Self {
            runs: Mutex::new(HashMap::new()),
        }
    }
}

fn set_run_status(app: &tauri::AppHandle, run_id: &str, status: AgentRunStatus) {
    let state = app.state::<AgentSupervisorState>();
    let Ok(mut runs) = state.runs.lock() else {
        return;
    };
    if let Some(handle) = runs.get_mut(run_id) {
        handle.status = status;
    }
}

fn message_id(prefix: &str) -> String {
    format!("{prefix}_{}", run_id())
}

fn project_name(cwd: &Option<String>) -> Option<String> {
    cwd.as_deref().and_then(|path| {
        std::path::Path::new(path)
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
    })
}

fn git_branch(cwd: &Option<String>) -> Option<String> {
    let cwd = cwd.as_ref()?;
    let output = std::process::Command::new("git")
        .args(["-C", cwd, "branch", "--show-current"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if branch.is_empty() {
        None
    } else {
        Some(branch)
    }
}

fn title_from_text(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return "Untitled Klide run".to_string();
    }
    trimmed.chars().take(120).collect()
}

fn base_system_prompt(request: &StartRunRequest) -> String {
    request.system_prompt.clone().unwrap_or_else(|| {
        format!(
            "You are Klide's coding agent, embedded in a local code editor.\n\nWorkspace root: {}\nMode: {:?}\n\nIn Chat mode, answer without tools. In Plan mode, inspect with read-only tools. In Goal mode, edits must be diff-reviewed before they are applied.",
            request.workspace_root.as_deref().unwrap_or("(none)"),
            request.mode
        )
    })
}

fn snapshot_for(request: &StartRunRequest) -> AgentContextSnapshot {
    request
        .context
        .clone()
        .unwrap_or_else(|| AgentContextSnapshot {
            workspace_root: request.workspace_root.clone(),
            attachments: request.attachments.clone(),
            lens_items: Vec::new(),
            estimated_tokens: 0,
            omitted: Vec::new(),
        })
}

fn provider_messages(request: &StartRunRequest, system: String) -> Vec<serde_json::Value> {
    let mut user_text = request.initial_text.clone();
    if !request.attachments.is_empty() {
        let attachments = request
            .attachments
            .iter()
            .map(|a| format!("File: {}\n```\n{}\n```", a.path, a.content))
            .collect::<Vec<_>>()
            .join("\n\n");
        user_text.push_str("\n\n[Files attached for context]\n");
        user_text.push_str(&attachments);
    }
    let mut messages = vec![serde_json::json!({ "role": "system", "content": system })];
    // Inject initial todo list as context for tool-capable/project turns.
    // Local chat should stay tiny; sending project metadata to MLX/Ollama for
    // "hello" made prompt processing feel broken.
    let should_include_todos = !(matches!(request.provider.as_str(), "mlx" | "ollama")
        && matches!(request.mode, AgentMode::Chat));
    if should_include_todos {
        if let Some(cwd) = &request.workspace_root {
            if let Some(todo_text) = todo::list_todos_text(cwd) {
                messages.push(serde_json::json!({
                    "role": "system",
                    "content": format!("[TODO list]\n{}", todo_text)
                }));
            }
        }
    }
    messages.push(serde_json::json!({ "role": "user", "content": user_text }));
    messages
}

fn assistant_provider_message(
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

fn tool_provider_message(call: &NormalizedToolCall, result: &ToolResult) -> serde_json::Value {
    serde_json::json!({
        "role": "tool",
        "content": result.content,
        "name": call.name,
        "tool_call_id": call.id,
    })
}

/// Replay a prior run's transcript back into provider-shaped messages so
/// the new run starts with the same context the user already saw on
/// screen.
///
/// Earlier versions of this function emitted the same wire shape the
/// loop uses at runtime — `assistant` with a `tool_calls` array plus
/// `role: "tool"` messages with `name` / `tool_call_id`. That worked
/// for OpenAI and Anthropic (which normalise / translate the shape)
/// but broke Ollama, whose chat API wants `tool_calls[*].function
/// .arguments` as a JSON object (not the OpenAI-encoded string) and
/// has no `tool_call_id` field on tool results. Once the replay started
/// feeding prior turns' tool flow back into Ollama, the local server
/// rejected the request with `Value looks like object, but can't find
/// closing '}' symbol`.
///
/// The simplest fix that's also the most portable: keep user and
/// assistant text, fold the tool flow into the next assistant
/// message's content. The model still sees the conversation, the wire
/// shape is just `{role, content}` for every provider, and the tool
/// results are marked inline so the assistant's answer stays
/// grounded in what the tool returned.
///
///   user  →  { role: "user", content: text [+ attached files] }
///   assistant_message
///         →  { role: "assistant", content: text [+ folded tool results] }
///   tool_call_finished
///         →  buffered; folded into the next assistant_message
///
/// Thinking blocks are dropped — the model already consumed them.
/// Compaction that already ran in the parent is preserved as-is.
fn reconstruct_prior_messages(prior_events: &[AgentEvent]) -> Vec<serde_json::Value> {
    let mut out: Vec<serde_json::Value> = Vec::new();
    // Tool results waiting to be folded into the next assistant turn.
    // They don't carry across a user message — a tool result from a
    // finished turn is meaningless once the user has moved on.
    let mut pending_tool_results: Vec<String> = Vec::new();

    let flush_tool_results = |pending: &mut Vec<String>, text: &mut String, prefix: &str| {
        if pending.is_empty() {
            return;
        }
        let folded = pending
            .iter()
            .map(|r| format!("\n{prefix}{r}\n{prefix}:end"))
            .collect::<String>();
        pending.clear();
        if !text.is_empty() {
            text.push_str("\n\n");
        }
        text.push_str(&folded);
    };

    for event in prior_events {
        match event {
            AgentEvent::UserMessage {
                text, attachments, ..
            } => {
                let mut content = text.clone();
                if !attachments.is_empty() {
                    let attached = attachments
                        .iter()
                        .map(|a| format!("File: {}\n```\n{}\n```", a.path, a.content))
                        .collect::<Vec<_>>()
                        .join("\n\n");
                    if !attached.is_empty() {
                        content.push_str("\n\n[Files attached for context]\n");
                        content.push_str(&attached);
                    }
                }
                out.push(serde_json::json!({ "role": "user", "content": content }));
                // A new user turn invalidates any straggler tool
                // results from the previous turn — the model shouldn't
                // see them on the wrong side of the turn boundary.
                pending_tool_results.clear();
            }
            AgentEvent::AssistantMessage { content, .. } => {
                let mut text: String = content
                    .iter()
                    .filter_map(|b| match b {
                        AgentContentBlock::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("");
                // Fold the buffered tool results inline so the model
                // sees what the tools returned, attached to the same
                // assistant turn that called them.
                flush_tool_results(&mut pending_tool_results, &mut text, "[tool_result]\n");
                out.push(serde_json::json!({ "role": "assistant", "content": text }));
            }
            AgentEvent::ToolCallFinished { result, .. } => {
                pending_tool_results.push(result.content.clone());
            }
            AgentEvent::ContextCompacted { summary, .. } => {
                // Collapse everything before the marker into one system
                // message. Turns recorded after it replay verbatim, so the
                // model keeps the gist of old context plus the recent
                // exchanges in full — at a fraction of the tokens.
                out.clear();
                pending_tool_results.clear();
                out.push(serde_json::json!({
                    "role": "system",
                    "content": format!(
                        "[Earlier conversation compacted to save context]\n{summary}"
                    )
                }));
            }
            _ => {}
        }
    }

    // Any tool results that never got folded (turn ended with a tool
    // call and no closing assistant turn) are dropped. Re-emitting
    // them as a bare `role: "tool"` message would re-introduce the
    // Ollama parse error, and the next assistant turn never saw them
    // anyway in the live run.
    let _ = pending_tool_results;

    out
}

/// Map the private provider-side `AiUsage` into the wire-format
/// `AgentUsage` so the frontend can decode it without depending on a
/// private type. Cheap (four `Option<u64>`s); done on every turn.
fn agent_usage_from(usage: Option<AiUsage>) -> Option<AgentUsage> {
    let u = usage?;
    let is_empty = u.prompt_tokens.is_none()
        && u.completion_tokens.is_none()
        && u.eval_duration_ms.is_none()
        && u.prompt_eval_duration_ms.is_none();
    if is_empty {
        return None;
    }
    Some(AgentUsage {
        prompt_tokens: u.prompt_tokens,
        completion_tokens: u.completion_tokens,
        eval_duration_ms: u.eval_duration_ms,
        prompt_eval_duration_ms: u.prompt_eval_duration_ms,
    })
}

fn no_workspace_result() -> ToolResult {
    ToolResult {
        ok: false,
        content: "Error: no workspace folder is open. Ask the user to open one before using tools."
            .to_string(),
        metadata: None,
    }
}

/// Run read-only tool calls concurrently, capped at `max_parallel` at a time,
/// and return their results keyed by call id. Each call runs on a blocking
/// thread (the tools are synchronous filesystem/network ops). A task that
/// panics is simply absent from the map; the caller falls back to inline
/// execution for any missing id, so a dropped result never silently vanishes.
async fn run_read_tools_parallel(
    root: &str,
    calls: Vec<NormalizedToolCall>,
    max_parallel: usize,
    run_id: &str,
) -> std::collections::HashMap<String, ToolResult> {
    let mut results = std::collections::HashMap::new();
    for chunk in calls.chunks(max_parallel.max(1)) {
        let handles: Vec<_> = chunk
            .iter()
            .map(|call| {
                let root = root.to_string();
                let call = call.clone();
                let run_id = run_id.to_string();
                tokio::task::spawn_blocking(move || {
                    let result = execute_read_only_tool(&root, &call, &run_id);
                    (call.id, result)
                })
            })
            .collect();
        for handle in handles {
            if let Ok((id, result)) = handle.await {
                results.insert(id, result);
            }
        }
    }
    results
}

fn tool_summary(call: &NormalizedToolCall) -> String {
    match call.name.as_str() {
        "read_file" | "list_dir" | "write_file" => call
            .input
            .get("path")
            .and_then(|v| v.as_str())
            .map(|path| format!("{} {}", call.name, path))
            .unwrap_or_else(|| call.name.clone()),
        "create_file" => call
            .input
            .get("path")
            .and_then(|v| v.as_str())
            .map(|path| format!("create_file {}", path))
            .unwrap_or_else(|| "create_file".to_string()),
        "glob" | "grep" => call
            .input
            .get("pattern")
            .and_then(|v| v.as_str())
            .map(|pattern| format!("{} {}", call.name, pattern))
            .unwrap_or_else(|| call.name.clone()),
        _ => call.name.clone(),
    }
}

/// Settle a cancelled run: aborted event, summary on disk, handle status.
fn finish_cancelled<E: FnMut(AgentEvent) -> Result<(), String>>(
    emit: &mut E,
    app: &tauri::AppHandle,
    runs_dir: &Path,
    id: &str,
    summary: &AgentRunSummary,
    message_count: u32,
) -> Result<(), String> {
    emit(AgentEvent::RunError {
        run_id: id.to_string(),
        error: AgentError {
            code: "aborted".to_string(),
            message: "Run stopped by user.".to_string(),
            detail: None,
            retryable: false,
        },
        ts: now_ms(),
    })?;
    set_run_status(app, id, AgentRunStatus::Cancelled);
    write_summary(
        runs_dir,
        &AgentRunSummary {
            status: "cancelled".to_string(),
            updated_ms: now_ms(),
            message_count,
            ..summary.clone()
        },
    )
}

#[tauri::command]
pub async fn agent_start_run(
    app: tauri::AppHandle,
    state: tauri::State<'_, AgentSupervisorState>,
    request: StartRunRequest,
    on_event: Channel<AgentEvent>,
) -> Result<StartRunResponse, String> {
    let runs_dir = app_runs_dir(&app)?;
    // Reuse the client's conversation id when supplied so the transcript on
    // disk shares the AI panel's id (deduped against the in-memory convo in
    // Mission Control); otherwise mint a fresh one.
    let id = request
        .run_id
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(run_id);
    let cancel = CancellationToken::new();

    state
        .runs
        .lock()
        .map_err(|_| "Agent state is unavailable".to_string())?
        .insert(
            id.clone(),
            AgentRunHandle {
                status: AgentRunStatus::Running,
                cancel: cancel.clone(),
                pending_diff: std::sync::Mutex::new(None),
                pending_question: std::sync::Mutex::new(None),
            },
        );

    // Detach the loop so this command returns the run id immediately; the UI
    // follows progress through the event channel and can abort via the token.
    let task_app = app.clone();
    let task_id = id.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = run_agent_loop(
            task_app,
            runs_dir,
            task_id.clone(),
            request,
            on_event,
            cancel,
        )
        .await
        {
            eprintln!("agent run {task_id} failed: {err}");
        }
    });

    Ok(StartRunResponse { run_id: id })
}

async fn run_agent_loop(
    app: tauri::AppHandle,
    runs_dir: PathBuf,
    id: String,
    request: StartRunRequest,
    on_event: Channel<AgentEvent>,
    cancel: CancellationToken,
) -> Result<(), String> {
    let cwd = request.workspace_root.clone();
    // A reused id means this is a follow-up turn in an existing conversation
    // (the AI panel keys runs by its convo id). Continue the transcript instead
    // of restarting it: pick up `seq` where we left off, skip the one-time
    // RunStarted/ContextSnapshot preamble, and offset tool-call ids past the
    // turns already on disk so checkpoint files never collide across turns.
    let prior_events = read_events(&runs_dir, &id).unwrap_or_default();
    let resuming = !prior_events.is_empty();
    // Start this run's file-snapshot slate clean so a reused id never inherits
    // stale read/write hashes from a previous run (see tools::clear_run_snapshots).
    clear_run_snapshots(&id);
    let prior_turns = prior_events
        .iter()
        .filter(|e| matches!(e, AgentEvent::AssistantMessage { .. }))
        .count();
    let created_ms = now_ms();
    let mut seq = prior_events.len() as u64;
    let event_channel = on_event.clone();

    let mut emit = |event: AgentEvent| -> Result<(), String> {
        append_event(&runs_dir, &id, seq, &event)?;
        seq += 1;
        let _ = on_event.send(event);
        Ok(())
    };

    let summary = AgentRunSummary {
        id: id.clone(),
        path: transcript_path(&runs_dir, &id)
            .to_string_lossy()
            .to_string(),
        source: "klide".to_string(),
        title: title_from_text(&request.initial_text),
        status: "running".to_string(),
        provider: request.provider.clone(),
        model: request.model.clone(),
        cwd: cwd.clone(),
        project: project_name(&cwd),
        git_branch: git_branch(&cwd),
        created_ms,
        updated_ms: created_ms,
        message_count: 1,
        input_tokens: 0,
        output_tokens: 0,
        files_touched: 0,
        cost_usd: None,
        parent_id: request.parent_id.clone(),
    };
    write_summary(&runs_dir, &summary)?;

    if !resuming {
        emit(AgentEvent::RunStarted {
            run_id: id.clone(),
            cwd: cwd.clone(),
            mode: request.mode.clone(),
            provider: request.provider.clone(),
            model: request.model.clone(),
            ts: now_ms(),
        })?;
        emit(AgentEvent::ContextSnapshot {
            run_id: id.clone(),
            snapshot: snapshot_for(&request),
            ts: now_ms(),
        })?;
    }
    emit(AgentEvent::UserMessage {
        run_id: id.clone(),
        message_id: message_id("user"),
        text: request.initial_text.clone(),
        attachments: request.attachments.clone(),
        ts: now_ms(),
    })?;

    let system = base_system_prompt(&request);
    let mut messages = provider_messages(&request, system);
    // When this run id was used before, the on-disk transcript holds the
    // whole prior conversation. Replay it into `messages` between the
    // system prompt and the new user turn, so the model sees the same
    // context the user does on screen. Without this, every follow-up
    // turn would arrive as a fresh chat — the "agent has no memory"
    // bug the user kept hitting.
    if resuming {
        let prior = reconstruct_prior_messages(&prior_events);
        // `provider_messages` always returns `[..., user]` with the new
        // turn at the tail. Pop it, splice the history in, push it back.
        if let Some(new_user) = messages.pop() {
            messages.extend(prior);
            messages.push(new_user);
        }
    }
    let tools = schemas_for_mode(&request.mode, &request.disabled_tools);
    // Count this turn's user message on top of the turns already on disk so
    // the Mission Control "Messages" tally reflects the whole conversation.
    let mut message_count = prior_turns as u32 + 1;
    let mut completed = false;
    // omp budgets a run by output tokens, not a tiny turn cap; 8 turns was
    // genuinely limiting for real multi-file work. 16 gives the agent room to
    // read → plan → edit → verify across several files before it has to hand
    // back to the user (who can always continue the conversation).
    const MAX_TURNS: usize = 16;
    const COMPACT_AFTER: usize = 14;

    for turn in 0..MAX_TURNS {
        // Auto-compaction: trim verbose tool results from older turns
        if messages.len() > COMPACT_AFTER {
            let mut compacted = 0;
            for msg in messages.iter_mut().skip(1) {
                if compacted >= 5 {
                    break;
                }
                if msg.get("role").and_then(|v| v.as_str()) == Some("tool") {
                    let name = msg.get("name").and_then(|v| v.as_str()).unwrap_or("tool");
                    let content_len = msg
                        .get("content")
                        .and_then(|v| v.as_str())
                        .map(|s| s.len())
                        .unwrap_or(0);
                    if content_len > 200 {
                        msg["content"] = serde_json::Value::String(format!("[compacted: {name}]"));
                        if let Some(obj) = msg.as_object_mut() {
                            obj.remove("name");
                        }
                        compacted += 1;
                    }
                }
            }
        }
        let assistant_id = message_id("assistant");
        let stream_run_id = id.clone();
        let stream_assistant_id = assistant_id.clone();
        let stream_channel = event_channel.clone();
        let stream = Channel::<StreamChunk>::new(move |body| {
            if let Ok(chunk) = body.deserialize::<StreamChunk>() {
                let _ = stream_channel.send(AgentEvent::AssistantDelta {
                    run_id: stream_run_id.clone(),
                    message_id: stream_assistant_id.clone(),
                    text: chunk.content,
                    thinking: if chunk.thinking.is_empty() {
                        None
                    } else {
                        Some(chunk.thinking)
                    },
                    ts: now_ms(),
                });
            }
            Ok(())
        });

        // Refresh the TODO list context before every turn so the model always
        // sees the latest task state (tools may have modified it).
        if let Some(cwd) = &request.workspace_root {
            let todo_text = todo::list_todos_text(cwd);
            for msg in messages.iter_mut() {
                if msg.get("role").and_then(|v| v.as_str()) == Some("system")
                    && msg
                        .get("content")
                        .and_then(|v| v.as_str())
                        .map(|c| c.starts_with("[TODO list]"))
                        .unwrap_or(false)
                {
                    msg["content"] = serde_json::Value::String(match &todo_text {
                        Some(t) => format!("[TODO list]\n{t}"),
                        None => "[TODO list]\nNo todos.".to_string(),
                    });
                    break;
                }
            }
        }

        // Race the provider stream against user cancellation so abort takes
        // effect mid-request, not only between turns.
        let provider_result = tokio::select! {
            _ = cancel.cancelled() => {
                finish_cancelled(&mut emit, &app, &runs_dir, &id, &summary, message_count)?;
                return Ok(());
            }
            result = ai_chat(
                request.provider.clone(),
                request.model.clone(),
                messages.clone(),
                tools.clone(),
                request.workspace_root.clone(),
                request.num_ctx,
                request.num_predict,
                request.reflection_level.clone(),
                stream,
            ) => result,
        };
        let response = match provider_result {
            Ok(response) => response,
            Err(err) => {
                let error = AgentError {
                    code: "provider_unavailable".to_string(),
                    message: err,
                    detail: None,
                    retryable: true,
                };
                emit(AgentEvent::RunError {
                    run_id: id.clone(),
                    error,
                    ts: now_ms(),
                })?;
                set_run_status(&app, &id, AgentRunStatus::Error);
                write_summary(
                    &runs_dir,
                    &AgentRunSummary {
                        status: "error".to_string(),
                        updated_ms: now_ms(),
                        message_count,
                        ..summary.clone()
                    },
                )?;
                completed = true;
                break;
            }
        };

        let mut tool_calls = parse_tool_calls(&response.tool_calls);
        let mut raw_tool_calls = response.tool_calls.clone();
        let mut content_text = response.content.clone();
        let mut thinking_text = response.thinking.clone();
        // Recovery path: some local models (LFM2/LFM2.5) emit tool calls as
        // `<|tool_call_start|>…<|tool_call_end|>` text instead of the structured
        // field — and route that text into *either* the content or the
        // reasoning/thinking channel (LFM2.5 emits into thinking). Scan the
        // content first, then the thinking, so the call is recovered wherever
        // it lands. Only attempt it when the structured field came back empty
        // so we never second-guess a well-behaved provider.
        if tool_calls.is_empty() {
            // Try content; if nothing there, try thinking and clean *it*
            // instead so the recovered tokens don't surface as raw reasoning.
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
                // Synthesize a structured tool_calls payload so the assistant
                // turn we replay back to the model is coherent (tool call →
                // tool result), and strip the raw tokens from the content.
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
        }
        // Fallback ids ("tool_<idx>") are only unique within one response —
        // stamp the turn so ids stay unique across the whole run (checkpoints
        // and the frontend reducer key on them). Offset by the turns already on
        // disk so follow-up turns in a reused conversation don't reuse an id
        // from an earlier turn and clobber its checkpoint file.
        let turn_label = prior_turns + turn;
        for call in tool_calls.iter_mut() {
            if call.id.starts_with("tool_") {
                call.id = format!("turn{turn_label}_{}", call.id);
            }
        }
        let tool_calls = tool_calls;
        messages.push(assistant_provider_message(&content_text, &raw_tool_calls));
        message_count += 1;

        if tool_calls.is_empty() {
            let mut content = Vec::new();
            // Thinking models (LFM2.5) can route the entire final answer into
            // the reasoning channel and leave `content` empty. An empty answer
            // helps no one and renders as an open "thought process" with no
            // body — so when content is empty, promote the thinking to the
            // answer. Models that separate reasoning from answer (non-empty
            // content) keep thinking as its own disclosure, unchanged.
            let thinking = thinking_text.filter(|t| !t.trim().is_empty());
            let mut answer_text = if content_text.trim().is_empty() {
                thinking.clone().unwrap_or_default()
            } else {
                if let Some(t) = thinking.clone() {
                    content.push(AgentContentBlock::Thinking { text: t });
                }
                content_text.clone()
            };
            // Ollama reports `done_reason: "length"` when the reply was cut off
            // because the KV cache (num_ctx) filled mid-generation — the model
            // didn't "decide" to stop, it ran out of room. Without this the
            // answer just ends mid-sentence and looks complete. Flag it inline
            // and point at the fix (raise the context window for this model).
            if response.stop_reason.as_deref() == Some("length") {
                answer_text.push_str(
                    "\n\n---\n_⚠ Response cut off — the model hit its context limit (num_ctx) \
mid-answer. Raise this model's context window in Settings → Harness, or start a fresh \
conversation, then ask again._",
                );
            }
            content.push(AgentContentBlock::Text { text: answer_text });
            emit(AgentEvent::AssistantMessage {
                run_id: id.clone(),
                message_id: assistant_id,
                content,
                usage: agent_usage_from(response.usage.clone()),
                ts: now_ms(),
            })?;
            emit(AgentEvent::RunResult {
                run_id: id.clone(),
                result: serde_json::json!({ "status": "done" }),
                ts: now_ms(),
            })?;
            set_run_status(&app, &id, AgentRunStatus::Done);
            write_summary(
                &runs_dir,
                &AgentRunSummary {
                    status: "done".to_string(),
                    updated_ms: now_ms(),
                    message_count,
                    ..summary.clone()
                },
            )?;
            completed = true;
            break;
        }

        let mut content = Vec::new();
        // Preserve the reasoning channel on tool-calling turns too. The frontend
        // keys its "thought process" disclosure off a Thinking block, so without
        // this the reasoning streamed live is wiped at finalization — a turn that
        // reasons and then calls a tool (LFM2.5 routes both through the thinking
        // channel) renders as a vanished thought process with no body. The
        // no-tool branch above already does this; keep the two consistent.
        if let Some(t) = thinking_text.as_deref() {
            if !t.trim().is_empty() {
                content.push(AgentContentBlock::Thinking { text: t.to_string() });
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
        emit(AgentEvent::AssistantMessage {
            run_id: id.clone(),
            message_id: assistant_id,
            content,
            usage: agent_usage_from(response.usage.clone()),
            ts: now_ms(),
        })?;

        // Parallel read-only tools: when the user opts in (cap > 1) and a turn
        // requests several read-only calls, run them concurrently up front and
        // serve the results into the sequential loop below. The loop's
        // structure — emit order, message append order, the diff-review pause
        // for writes, clean_context handling — is untouched; only the read-only
        // result *source* changes. With cap 1 (the default) this is skipped and
        // every call executes inline exactly as before.
        let max_parallel = request.max_parallel_tools.unwrap_or(1).max(1);
        let mut precomputed: std::collections::HashMap<String, ToolResult> =
            std::collections::HashMap::new();
        if max_parallel > 1 {
            if let Some(root) = request.workspace_root.as_deref() {
                let read_calls: Vec<NormalizedToolCall> = tool_calls
                    .iter()
                    .filter(|c| !is_write_tool(&c.name))
                    .cloned()
                    .collect();
                if read_calls.len() > 1 {
                    precomputed =
                        run_read_tools_parallel(root, read_calls, max_parallel, &id).await;
                }
            }
        }

        for call in tool_calls {
            if cancel.is_cancelled() {
                finish_cancelled(&mut emit, &app, &runs_dir, &id, &summary, message_count)?;
                return Ok(());
            }
            emit(AgentEvent::ToolCallStarted {
                run_id: id.clone(),
                tool_call_id: call.id.clone(),
                name: call.name.clone(),
                input: call.input.clone(),
                summary: tool_summary(&call),
                ts: now_ms(),
            })?;

            let tool_result: ToolResult;

            if is_user_question_tool(&call.name) {
                // Pause for a typed Q&A. The question is read from the tool
                // input; the answer comes back through `agent_resolve_question`,
                // which sends via the oneshot we stash in `pending_question`.
                // Skip = a special sentinel the model can use to bail out
                // gracefully when the user has nothing to say. We keep the
                // raw answer text in the result so the model sees verbatim
                // what the user wrote, including blank lines.
                let question = call
                    .input
                    .get("question")
                    .and_then(|v| v.as_str())
                    .unwrap_or("(empty question)")
                    .to_string();
                let request_id = format!("q_{}_{}", id, call.id);

                set_run_status(&app, &id, AgentRunStatus::WaitingForPermission);
                let (tx, rx) = tokio::sync::oneshot::channel::<String>();
                {
                    let state = app.state::<AgentSupervisorState>();
                    let mut runs = state
                        .runs
                        .lock()
                        .map_err(|_| "Agent state unavailable".to_string())?;
                    if let Some(handle) = runs.get_mut(&id) {
                        *handle.pending_question.lock().unwrap() = Some(tx);
                    }
                }

                emit(AgentEvent::UserQuestionRequested {
                    run_id: id.clone(),
                    request_id: request_id.clone(),
                    question: question.clone(),
                    ts: now_ms(),
                })?;

                let answer = tokio::select! {
                    _ = cancel.cancelled() => {
                        set_run_status(&app, &id, AgentRunStatus::Running);
                        finish_cancelled(&mut emit, &app, &runs_dir, &id, &summary, message_count)?;
                        return Ok(());
                    }
                    result = rx => result.unwrap_or_else(|_| "(skipped)".to_string()),
                };

                set_run_status(&app, &id, AgentRunStatus::Running);

                emit(AgentEvent::UserQuestionResolved {
                    run_id: id.clone(),
                    request_id: request_id.clone(),
                    answer: answer.clone(),
                    ts: now_ms(),
                })?;

                tool_result = ToolResult {
                    ok: true,
                    content: if answer == "(skipped)" {
                        "[user skipped this question]".to_string()
                    } else {
                        answer
                    },
                    metadata: None,
                };
            } else if is_write_tool(&call.name) {
                let root = match request.workspace_root.as_deref() {
                    Some(root) => root,
                    None => {
                        tool_result = no_workspace_result();
                        emit(AgentEvent::ToolCallFinished {
                            run_id: id.clone(),
                            tool_call_id: call.id.clone(),
                            result: tool_result.clone(),
                            ts: now_ms(),
                        })?;
                        messages.push(tool_provider_message(&call, &tool_result));
                        continue;
                    }
                };

                let proposal = match execute_write_tool_preview(root, &call, &id) {
                    Ok(p) => p,
                    Err(error_result) => {
                        tool_result = error_result;
                        emit(AgentEvent::ToolCallFinished {
                            run_id: id.clone(),
                            tool_call_id: call.id.clone(),
                            result: tool_result.clone(),
                            ts: now_ms(),
                        })?;
                        messages.push(tool_provider_message(&call, &tool_result));
                        continue;
                    }
                };

                // Pause for diff review
                set_run_status(&app, &id, AgentRunStatus::WaitingForDiff);
                let (tx, rx) = tokio::sync::oneshot::channel::<String>();
                {
                    let state = app.state::<AgentSupervisorState>();
                    let mut runs = state
                        .runs
                        .lock()
                        .map_err(|_| "Agent state unavailable".to_string())?;
                    if let Some(handle) = runs.get_mut(&id) {
                        *handle.pending_diff.lock().unwrap() = Some(tx);
                    }
                }

                emit(AgentEvent::DiffProposed {
                    run_id: id.clone(),
                    proposal: proposal.clone(),
                    ts: now_ms(),
                })?;

                // Wait for diff resolution, cancellation, or channel close
                let decision = tokio::select! {
                    _ = cancel.cancelled() => {
                        set_run_status(&app, &id, AgentRunStatus::Running);
                        finish_cancelled(&mut emit, &app, &runs_dir, &id, &summary, message_count)?;
                        return Ok(());
                    }
                    result = rx => result.unwrap_or_else(|_| "reject".to_string()),
                };

                set_run_status(&app, &id, AgentRunStatus::Running);

                let decision_obj = serde_json::json!({ "behavior": decision });
                emit(AgentEvent::DiffResolved {
                    run_id: id.clone(),
                    proposal_id: proposal.id.clone(),
                    decision: decision_obj.clone(),
                    ts: now_ms(),
                })?;

                if decision == "apply" {
                    match apply_write(root, &proposal) {
                        Ok(result) => {
                            // Save checkpoint for rollback. Serialize through
                            // CheckpointEntry so the saved shape always matches
                            // what agent_list_checkpoints deserializes.
                            let checkpoint_dir = runs_dir.join(&id).join("checkpoints");
                            let _ = std::fs::create_dir_all(&checkpoint_dir);
                            let checkpoint_file = checkpoint_dir
                                .join(format!("{}.json", sanitize_file_id(&proposal.tool_call_id)));
                            let entry = CheckpointEntry {
                                tool_call_id: proposal.tool_call_id.clone(),
                                path: proposal.path.clone(),
                                old_content: proposal.old_content.clone(),
                                new_content: proposal.new_content.clone(),
                                is_create: proposal.is_create,
                                workspace_root: root.to_string(),
                                ts: now_ms(),
                            };
                            if let Ok(json) = serde_json::to_string(&entry) {
                                let _ = std::fs::write(&checkpoint_file, json);
                            }
                            tool_result = result;
                            emit(AgentEvent::FileChanged {
                                run_id: id.clone(),
                                path: proposal.path.clone(),
                                old_hash: proposal.old_hash.clone(),
                                new_hash: proposal.new_hash.clone(),
                                ts: now_ms(),
                            })?;
                        }
                        Err(result) => {
                            tool_result = result;
                        }
                    }
                } else {
                    tool_result = ToolResult {
                        ok: false,
                        content: format!(
                            "Rejected by user: {} was not {}.",
                            proposal.path,
                            if proposal.is_create {
                                "created"
                            } else {
                                "changed"
                            }
                        ),
                        metadata: None,
                    };
                }
            } else {
                tool_result = match request.workspace_root.as_deref() {
                    // Use the concurrently-computed result when present (cap > 1);
                    // otherwise execute inline (sequential default, or a write
                    // tool that slipped the filter — it can't, but be safe).
                    Some(root) => precomputed
                        .remove(&call.id)
                        .unwrap_or_else(|| execute_read_only_tool(root, &call, &id)),
                    None => no_workspace_result(),
                };
            }

            emit(AgentEvent::ToolCallFinished {
                run_id: id.clone(),
                tool_call_id: call.id.clone(),
                result: tool_result.clone(),
                ts: now_ms(),
            })?;
            messages.push(tool_provider_message(&call, &tool_result));

            if call.name == "clean_context" {
                let ids: Vec<String> = call
                    .input
                    .get("ids")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                clean_context_ids(&ids, &mut messages);
            }
        }
    }

    if !completed {
        // The last turn already emitted its reasoning + tool calls, but the run
        // never produced a tool-free answer — so without this the conversation
        // just ends on a tool result with no closing words, then a silent error.
        // Emit a readable final message so the user always sees *something* and
        // knows they can continue, before marking the run retryable.
        emit(AgentEvent::AssistantMessage {
            run_id: id.clone(),
            message_id: message_id("assistant"),
            content: vec![AgentContentBlock::Text {
                text: format!(
                    "I reached the maximum number of tool turns ({MAX_TURNS}) before finishing this request. \
                     The work above is where I got to — send another message to have me continue from here."
                ),
            }],
            usage: None,
            ts: now_ms(),
        })?;
        message_count += 1;
        let error = AgentError {
            code: "max_turns".to_string(),
            message: "Agent reached the maximum tool turns.".to_string(),
            detail: None,
            retryable: true,
        };
        emit(AgentEvent::RunError {
            run_id: id.clone(),
            error,
            ts: now_ms(),
        })?;
        set_run_status(&app, &id, AgentRunStatus::Error);
        write_summary(
            &runs_dir,
            &AgentRunSummary {
                status: "error".to_string(),
                updated_ms: now_ms(),
                message_count,
                ..summary
            },
        )?;
    }

    Ok(())
}

#[tauri::command]
pub async fn agent_submit_user_turn(
    _state: tauri::State<'_, AgentSupervisorState>,
    _request: SubmitUserTurnRequest,
) -> Result<(), String> {
    Err("Continuing an existing harness run is not wired in this milestone".to_string())
}

// NOTE: deliberately hard errors, not silent no-ops. The harness does not
// pause for permissions/diffs yet; writing fake "resolved" events here would
// corrupt transcript ordering and let a UI believe approval was enforced.
#[tauri::command]
pub async fn agent_resolve_permission(_decision: PermissionDecisionRequest) -> Result<(), String> {
    Err("The harness does not pause for permissions yet; nothing to resolve.".to_string())
}

#[tauri::command]
pub async fn agent_resolve_diff(
    state: tauri::State<'_, AgentSupervisorState>,
    decision: DiffDecisionRequest,
) -> Result<(), String> {
    let runs = state
        .runs
        .lock()
        .map_err(|_| "Agent state is unavailable".to_string())?;
    match runs.get(&decision.run_id) {
        Some(handle) => {
            let sender = handle.pending_diff.lock().unwrap().take();
            if let Some(tx) = sender {
                let behavior = decision
                    .decision
                    .get("behavior")
                    .and_then(|v| v.as_str())
                    .unwrap_or("reject");
                let _ = tx.send(behavior.to_string());
                Ok(())
            } else {
                Err("No pending diff review for this run.".to_string())
            }
        }
        None => Err(format!("No known run with id {}", decision.run_id)),
    }
}

/// Wire shape for `agent_resolve_question`. The answer is whatever the user
/// typed (or the literal "(skipped)" sentinel that the UI sends when they
/// bail). Empty strings are passed through unchanged so the model can
/// distinguish "I have nothing to say" from "I chose to skip the question".
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserQuestionDecisionRequest {
    pub run_id: String,
    /// Echoed by the frontend so future validation (e.g. reject if a
    /// different question is now pending) has something to key on. Not
    /// read today — the run is single-question-at-a-time by construction.
    #[allow(dead_code)]
    pub request_id: String,
    pub answer: String,
}

#[tauri::command]
pub async fn agent_resolve_question(
    state: tauri::State<'_, AgentSupervisorState>,
    decision: UserQuestionDecisionRequest,
) -> Result<(), String> {
    let runs = state
        .runs
        .lock()
        .map_err(|_| "Agent state is unavailable".to_string())?;
    match runs.get(&decision.run_id) {
        Some(handle) => {
            let sender = handle.pending_question.lock().unwrap().take();
            if let Some(tx) = sender {
                let _ = tx.send(decision.answer);
                Ok(())
            } else {
                Err("No pending question for this run.".to_string())
            }
        }
        None => Err(format!("No known run with id {}", decision.run_id)),
    }
}

#[tauri::command]
pub async fn agent_abort_run(
    state: tauri::State<'_, AgentSupervisorState>,
    run_id: String,
) -> Result<(), String> {
    let runs = state
        .runs
        .lock()
        .map_err(|_| "Agent state is unavailable".to_string())?;
    match runs.get(&run_id) {
        // Just cancel the token: the run loop observes it and settles the
        // run (aborted event, summary, status) so there is a single writer.
        Some(handle) => {
            handle.cancel.cancel();
            Ok(())
        }
        None => Err(format!("No known run with id {run_id}")),
    }
}

/// Write a compaction marker into a run's transcript. The frontend generates
/// `summary` (one model call over the older turns) and calls this; on the next
/// turn, `reconstruct_prior_messages` collapses everything before the marker
/// into that summary while replaying recent turns verbatim — freeing context
/// without losing the thread.
#[tauri::command]
pub async fn agent_compact_context(
    app: tauri::AppHandle,
    run_id: String,
    summary: String,
) -> Result<(), String> {
    let summary = summary.trim();
    if summary.is_empty() {
        return Err("Refusing to compact with an empty summary".to_string());
    }
    let runs_dir = app_runs_dir(&app)?;
    let prior = read_events(&runs_dir, &run_id).unwrap_or_default();
    if prior.is_empty() {
        return Err("No conversation to compact yet".to_string());
    }
    let seq = prior.len() as u64;
    append_event(
        &runs_dir,
        &run_id,
        seq,
        &AgentEvent::ContextCompacted {
            run_id: run_id.clone(),
            summary: summary.to_string(),
            ts: now_ms(),
        },
    )?;
    Ok(())
}

#[tauri::command]
pub async fn agent_list_runs(
    app: tauri::AppHandle,
    state: tauri::State<'_, AgentSupervisorState>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<AgentRunSummary>, String> {
    let runs_dir = app_runs_dir(&app)?;
    let live_run_ids = state
        .runs
        .lock()
        .map_err(|_| "Agent state is unavailable".to_string())?
        .iter()
        .filter(|(_, handle)| {
            matches!(
                handle.status,
                AgentRunStatus::Queued
                    | AgentRunStatus::Running
                    | AgentRunStatus::WaitingForPermission
                    | AgentRunStatus::WaitingForDiff
                    | AgentRunStatus::Paused
            )
        })
        .map(|(id, _)| id.clone())
        .collect::<std::collections::HashSet<_>>();
    let mut summaries = list_summaries(&runs_dir, limit, offset)?;
    for summary in &mut summaries {
        if matches!(summary.status.as_str(), "running" | "queued" | "waiting")
            && !live_run_ids.contains(&summary.id)
        {
            summary.status = "cancelled".to_string();
        }
    }
    Ok(summaries)
}

#[tauri::command]
pub async fn agent_read_run(
    app: tauri::AppHandle,
    run_id: String,
) -> Result<Vec<AgentEvent>, String> {
    let runs_dir = app_runs_dir(&app)?;
    read_events(&runs_dir, &run_id)
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheckpointEntry {
    tool_call_id: String,
    path: String,
    old_content: String,
    new_content: String,
    is_create: bool,
    /// The workspace the edit was applied in — revert must resolve against
    /// this, never the process cwd.
    workspace_root: String,
    ts: i64,
}

/// Tool-call ids come from providers (or fallbacks) and may contain path
/// separators — flatten them so they are safe as checkpoint file names.
fn sanitize_file_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn checkpoint_file(runs_dir: &Path, run_id: &str, tool_call_id: &str) -> PathBuf {
    runs_dir
        .join(run_id)
        .join("checkpoints")
        .join(format!("{}.json", sanitize_file_id(tool_call_id)))
}

fn checkpoint_dir(runs_dir: &Path, run_id: &str) -> PathBuf {
    runs_dir.join(run_id).join("checkpoints")
}

/// Read all checkpoints for `run_id`, newest first. Pure function over the
/// runs directory — the Tauri command is a thin wrapper.
pub(crate) fn list_checkpoints_at(
    runs_dir: &Path,
    run_id: &str,
) -> Result<Vec<CheckpointEntry>, String> {
    let dir = checkpoint_dir(runs_dir, run_id);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut entries: Vec<CheckpointEntry> = Vec::new();
    if let Ok(read_dir) = std::fs::read_dir(&dir) {
        for file in read_dir.flatten() {
            if let Ok(content) = std::fs::read_to_string(file.path()) {
                if let Ok(entry) = serde_json::from_str::<CheckpointEntry>(&content) {
                    entries.push(entry);
                }
            }
        }
    }
    entries.sort_by(|a, b| b.ts.cmp(&a.ts));
    Ok(entries)
}

/// Revert one checkpoint: restore `old_content` for an edit, or remove the
/// file for a create. Consumes the checkpoint file so it cannot be reverted
/// twice. Pure function — the Tauri command is a thin wrapper.
pub(crate) fn revert_checkpoint_at(
    runs_dir: &Path,
    run_id: &str,
    tool_call_id: &str,
) -> Result<(), String> {
    let file = checkpoint_file(runs_dir, run_id, tool_call_id);
    let content = std::fs::read_to_string(&file)
        .map_err(|_| format!("Checkpoint {tool_call_id} not found"))?;
    let entry: CheckpointEntry =
        serde_json::from_str(&content).map_err(|e| format!("Invalid checkpoint: {e}"))?;

    // Resolve against the workspace the edit was applied in, with the same
    // containment guard as the write tools.
    let ws = crate::workspace::Workspace::new(&entry.workspace_root)?;
    let full = ws.resolve_new(&entry.path)?;

    if entry.is_create {
        std::fs::remove_file(&full).map_err(|e| format!("Cannot remove {}: {e}", entry.path))?;
    } else {
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&full, &entry.old_content)
            .map_err(|e| format!("Cannot write {}: {e}", entry.path))?;
    }

    // Remove the checkpoint file so it can't be reverted twice
    let _ = std::fs::remove_file(&file);
    Ok(())
}

#[tauri::command]
pub async fn agent_list_checkpoints(
    app: tauri::AppHandle,
    run_id: String,
) -> Result<Vec<CheckpointEntry>, String> {
    let runs_dir = app_runs_dir(&app)?;
    list_checkpoints_at(&runs_dir, &run_id)
}

#[tauri::command]
pub async fn agent_revert_checkpoint(
    app: tauri::AppHandle,
    run_id: String,
    tool_call_id: String,
) -> Result<(), String> {
    let runs_dir = app_runs_dir(&app)?;
    revert_checkpoint_at(&runs_dir, &run_id, &tool_call_id)
}

#[cfg(test)]
mod replay_tests {
    //! The "agent has memory" fix lives in `reconstruct_prior_messages`:
    //! given a transcript, it has to produce provider-shaped messages that
    //! replay the user / assistant / tool turns in order. These tests
    //! pin the wire format and the edge cases (no events, no content
    //! blocks, malformed tool calls).

    use super::*;
    use crate::agent::types::AgentContentBlock;

    fn user_msg(text: &str) -> AgentEvent {
        AgentEvent::UserMessage {
            run_id: "r".into(),
            message_id: "u".into(),
            text: text.into(),
            attachments: Vec::new(),
            ts: 1,
        }
    }

    fn assistant_text(text: &str) -> AgentEvent {
        AgentEvent::AssistantMessage {
            run_id: "r".into(),
            message_id: "a".into(),
            content: vec![AgentContentBlock::Text { text: text.into() }],
            usage: None,
            ts: 2,
        }
    }

    fn assistant_with_tool_call() -> AgentEvent {
        AgentEvent::AssistantMessage {
            run_id: "r".into(),
            message_id: "a".into(),
            content: vec![
                AgentContentBlock::Text {
                    text: "let me read that".into(),
                },
                AgentContentBlock::ToolCall {
                    tool_call_id: "tc1".into(),
                    name: "read_file".into(),
                    input: serde_json::json!({ "path": "README.md" }),
                },
            ],
            usage: None,
            ts: 2,
        }
    }

    fn tool_result(id: &str, content: &str) -> AgentEvent {
        AgentEvent::ToolCallFinished {
            run_id: "r".into(),
            tool_call_id: id.into(),
            result: ToolResult {
                ok: true,
                content: content.into(),
                metadata: None,
            },
            ts: 3,
        }
    }

    #[test]
    fn empty_events_produces_empty_messages() {
        assert!(reconstruct_prior_messages(&[]).is_empty());
    }

    #[test]
    fn user_message_becomes_user_role() {
        let out = reconstruct_prior_messages(&[user_msg("hello")]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["role"], "user");
        assert_eq!(out[0]["content"], "hello");
    }

    #[test]
    fn context_compacted_collapses_prior_and_keeps_recent_verbatim() {
        let compacted = AgentEvent::ContextCompacted {
            run_id: "r".into(),
            summary: "we set up auth and fixed the parser".into(),
            ts: 9,
        };
        let out = reconstruct_prior_messages(&[
            user_msg("old turn 1"),
            assistant_text("old reply 1"),
            compacted,
            user_msg("recent question"),
            assistant_text("recent answer"),
        ]);
        // Everything before the marker collapses into one system summary;
        // the two recent turns replay verbatim after it.
        assert_eq!(out.len(), 3, "got: {out:?}");
        assert_eq!(out[0]["role"], "system");
        assert!(out[0]["content"]
            .as_str()
            .expect("summary is string")
            .contains("we set up auth"));
        assert_eq!(out[1]["role"], "user");
        assert_eq!(out[1]["content"], "recent question");
        assert_eq!(out[2]["role"], "assistant");
        assert_eq!(out[2]["content"], "recent answer");
    }

    #[test]
    fn assistant_text_becomes_assistant_role_with_content() {
        let out = reconstruct_prior_messages(&[assistant_text("hi back")]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["role"], "assistant");
        assert_eq!(out[0]["content"], "hi back");
        // No `tool_calls` array — the replay never emits the OpenAI
        // shape that Ollama's chat API rejects.
        assert!(out[0].get("tool_calls").is_none());
    }

    #[test]
    fn assistant_with_tool_call_drops_call_keeps_text() {
        // Tool calls are folded into the next assistant turn as
        // inline tool results, not surfaced as a structured array.
        let out = reconstruct_prior_messages(&[assistant_with_tool_call()]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["role"], "assistant");
        assert!(out[0]["content"]
            .as_str()
            .expect("content is string")
            .contains("let me read that"));
        assert!(out[0].get("tool_calls").is_none());
    }

    #[test]
    fn tool_result_folds_into_next_assistant_message() {
        // The orphan tool_call_finished event from a prior turn is
        // not emitted as its own message; it waits for the closing
        // assistant turn and gets appended to that text.
        let out = reconstruct_prior_messages(&[
            assistant_text("let me check"),
            tool_result("tc1", "file contents"),
            assistant_text("done"),
        ]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["role"], "assistant");
        assert_eq!(out[0]["content"], "let me check");
        // The closing assistant turn carries the folded tool result.
        assert_eq!(out[1]["role"], "assistant");
        let content = out[1]["content"].as_str().expect("content is string");
        assert!(content.contains("done"), "got: {content}");
        assert!(
            content.contains("file contents"),
            "tool result content was dropped: {content}"
        );
        assert!(content.contains("[tool_result]"), "result marker missing");
    }

    #[test]
    fn full_conversation_replays_in_order() {
        let events = vec![
            user_msg("read the readme"),
            assistant_with_tool_call(),
            tool_result("tc1", "hello world"),
            assistant_text("the readme says hi"),
        ];
        let out = reconstruct_prior_messages(&events);
        // 1 user + 1 pre-tool assistant + 1 closing assistant with the
        // tool result folded in = 3 messages. The tool_call_finished
        // was folded into the closing turn, the ToolCall block on
        // `assistant_with_tool_call` was dropped.
        assert_eq!(out.len(), 3);
        assert_eq!(out[0]["role"], "user");
        assert_eq!(out[0]["content"], "read the readme");
        assert_eq!(out[1]["role"], "assistant");
        assert_eq!(out[1]["content"], "let me read that");
        assert_eq!(out[2]["role"], "assistant");
        let closing = out[2]["content"].as_str().expect("content is string");
        assert!(closing.contains("the readme says hi"), "got: {closing}");
        assert!(
            closing.contains("hello world"),
            "tool result dropped: {closing}"
        );
    }

    #[test]
    fn tool_results_at_turn_end_are_dropped() {
        // A turn that ends with a tool call (no closing assistant
        // message) has its orphan tool result dropped. Re-emitting it
        // as `role: "tool"` is exactly the Ollama parse-error case
        // we just fixed.
        let out = reconstruct_prior_messages(&[user_msg("ping"), tool_result("tc1", "pong")]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["role"], "user");
    }

    #[test]
    fn tool_results_do_not_carry_across_user_turns() {
        // A buffered tool result from a previous turn must not leak
        // into the next user turn — the model shouldn't see a
        // tool result on the wrong side of a user message.
        let out = reconstruct_prior_messages(&[
            user_msg("first turn"),
            tool_result("tc1", "stale result"),
            user_msg("second turn"),
            assistant_text("second answer"),
        ]);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0]["role"], "user");
        assert_eq!(out[0]["content"], "first turn");
        assert_eq!(out[1]["role"], "user");
        assert_eq!(out[1]["content"], "second turn");
        assert_eq!(out[2]["role"], "assistant");
        assert_eq!(out[2]["content"], "second answer");
    }

    #[test]
    fn preamble_events_are_skipped() {
        // RunStarted / ContextSnapshot / the other framing events
        // must not become messages — they're not provider-shaped.
        let events = vec![
            AgentEvent::RunStarted {
                run_id: "r".into(),
                cwd: None,
                mode: AgentMode::Chat,
                provider: "ollama".into(),
                model: "x".into(),
                ts: 0,
            },
            user_msg("hi"),
        ];
        let out = reconstruct_prior_messages(&events);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["role"], "user");
    }
}

#[cfg(test)]
mod checkpoint_tests {
    //! Round-trip + revert tests for the checkpoint store.
    //!
    //! These exercise the pure helpers (`list_checkpoints_at` and
    //! `revert_checkpoint_at`) against a real temp directory so we can
    //! catch regressions in the on-disk format without spinning up Tauri.
    use super::*;
    use std::path::PathBuf;

    /// Build a fresh sandbox: a real workspace root + a `runs` dir underneath.
    /// Returns `(runs_dir, workspace_root)`.
    fn make_sandbox(label: &str) -> (PathBuf, PathBuf) {
        let stamp = format!(
            "klide-checkpoint-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let root = std::env::temp_dir().join(stamp);
        let workspace = root.join("workspace");
        std::fs::create_dir_all(&workspace).expect("create workspace");
        let runs = root.join("runs");
        std::fs::create_dir_all(&runs).expect("create runs");
        (runs, workspace)
    }

    fn write_checkpoint(runs_dir: &Path, run_id: &str, tool_call_id: &str, json: &str) -> PathBuf {
        let dir = checkpoint_dir(runs_dir, run_id);
        std::fs::create_dir_all(&dir).expect("create checkpoint dir");
        let file = checkpoint_file(runs_dir, run_id, tool_call_id);
        std::fs::write(&file, json).expect("write checkpoint json");
        file
    }

    fn checkpoint_json(
        tool_call_id: &str,
        path: &str,
        old_content: &str,
        new_content: &str,
        is_create: bool,
        workspace_root: &str,
        ts: i64,
    ) -> String {
        serde_json::json!({
            "toolCallId": tool_call_id,
            "path": path,
            "oldContent": old_content,
            "newContent": new_content,
            "isCreate": is_create,
            "workspaceRoot": workspace_root,
            "ts": ts,
        })
        .to_string()
    }

    #[test]
    fn sanitize_file_id_flattens_path_separators() {
        assert_eq!(sanitize_file_id("turn1/file1"), "turn1_file1");
        assert_eq!(sanitize_file_id("a\\b:c"), "a_b_c");
        assert_eq!(sanitize_file_id("call_42"), "call_42");
    }

    #[test]
    fn list_empty_run_returns_empty_vec() {
        let (runs, _ws) = make_sandbox("list-empty");
        let entries = list_checkpoints_at(&runs, "no-such-run").expect("list");
        assert!(entries.is_empty());
    }

    #[test]
    fn list_sorts_newest_first() {
        let (runs, _ws) = make_sandbox("list-sort");
        let run = "run_42";
        for (id, ts) in [("call_a", 100_i64), ("call_b", 300), ("call_c", 200)] {
            let json = checkpoint_json(id, "x.rs", "", "", false, "/tmp", ts);
            write_checkpoint(&runs, run, id, &json);
        }
        let entries = list_checkpoints_at(&runs, run).expect("list");
        let ids: Vec<&str> = entries.iter().map(|e| e.tool_call_id.as_str()).collect();
        assert_eq!(ids, ["call_b", "call_c", "call_a"]);
    }

    #[test]
    fn revert_restores_old_content_for_edit() {
        let (runs, ws) = make_sandbox("revert-edit");
        let run = "run_edit";
        let rel = "src/example.txt";
        let abs = ws.join(rel);
        std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
        std::fs::write(&abs, "original content").unwrap();

        // Snapshot what the file looked like before the proposed edit.
        let json = checkpoint_json(
            "edit_1",
            rel,
            "original content",
            "new content",
            false,
            ws.to_str().unwrap(),
            1_000,
        );
        let cp = write_checkpoint(&runs, run, "edit_1", &json);

        // Simulate the harness applying the edit.
        std::fs::write(&abs, "new content").unwrap();
        assert_eq!(std::fs::read_to_string(&abs).unwrap(), "new content");

        // Revert and confirm the file is back to the snapshot.
        revert_checkpoint_at(&runs, run, "edit_1").expect("revert");
        assert_eq!(std::fs::read_to_string(&abs).unwrap(), "original content");
        assert!(!cp.exists(), "checkpoint file should be consumed");
    }

    #[test]
    fn revert_removes_file_for_create() {
        let (runs, ws) = make_sandbox("revert-create");
        let run = "run_create";
        let rel = "src/created.txt";
        let abs = ws.join(rel);
        std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
        std::fs::write(&abs, "freshly created body").unwrap();

        let json = checkpoint_json(
            "create_1",
            rel,
            "",
            "freshly created body",
            true,
            ws.to_str().unwrap(),
            2_000,
        );
        let cp = write_checkpoint(&runs, run, "create_1", &json);

        revert_checkpoint_at(&runs, run, "create_1").expect("revert");
        assert!(!abs.exists(), "create revert should delete the file");
        assert!(!cp.exists(), "checkpoint file should be consumed");
    }

    #[test]
    fn revert_cannot_be_replayed() {
        let (runs, ws) = make_sandbox("revert-twice");
        let run = "run_x";
        let rel = "note.md";
        let abs = ws.join(rel);
        std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
        std::fs::write(&abs, "v1").unwrap();

        let json = checkpoint_json("edit_x", rel, "v1", "v2", false, ws.to_str().unwrap(), 0);
        write_checkpoint(&runs, run, "edit_x", &json);
        std::fs::write(&abs, "v2").unwrap();

        revert_checkpoint_at(&runs, run, "edit_x").expect("first revert");
        // The file is back at v1, but the checkpoint file is gone.
        let second = revert_checkpoint_at(&runs, run, "edit_x");
        assert!(second.is_err(), "second revert should fail: {second:?}");
        assert!(second.unwrap_err().contains("not found"));
    }

    #[test]
    fn revert_unknown_checkpoint_returns_error() {
        let (runs, _ws) = make_sandbox("revert-missing");
        let err = revert_checkpoint_at(&runs, "any_run", "ghost_id").unwrap_err();
        assert!(err.contains("ghost_id"), "got: {err}");
        assert!(err.contains("not found"), "got: {err}");
    }

    #[test]
    fn revert_rejects_path_outside_workspace() {
        // The checkpoint's `workspaceRoot` points outside the actual
        // workspace; resolve_new_path must refuse to write there. The
        // containment guard is exercised separately in `tools::tests`, so
        // here we just confirm revert can't be tricked by a bogus root —
        // whatever the specific error, the file must not be written.
        let (runs, _ws) = make_sandbox("revert-traversal");
        let run = "run_evil";
        let json = checkpoint_json(
            "edit_evil",
            "evil.rs",
            "old",
            "new",
            false,
            "/this/does/not/exist/anywhere",
            0,
        );
        write_checkpoint(&runs, run, "edit_evil", &json);
        let result = revert_checkpoint_at(&runs, run, "edit_evil");
        assert!(
            result.is_err(),
            "revert must refuse a non-existent workspace root"
        );
        // The checkpoint file should still be present — the revert never
        // got far enough to consume it, so the user can try again after
        // fixing the workspace path.
        assert!(checkpoint_file(&runs, run, "edit_evil").exists());
    }
}
