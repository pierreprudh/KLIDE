pub mod tools;
pub mod transcripts;
pub mod types;

use self::tools::{
    execute_read_only_tool, execute_write_tool_preview, is_write_tool, parse_tool_calls,
    schemas_for_mode, NormalizedToolCall, apply_write, clean_context_ids,
};
use self::transcripts::{
    app_runs_dir, append_event, list_summaries, now_ms, read_events, run_id, transcript_path,
    write_summary,
};
use self::types::{
    AgentContentBlock, AgentContextSnapshot, AgentError, AgentEvent, AgentRunStatus,
    AgentRunSummary, DiffDecisionRequest, PermissionDecisionRequest, StartRunRequest,
    StartRunResponse, SubmitUserTurnRequest, ToolResult,
};
use crate::{ai_chat, StreamChunk};
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
    vec![
        serde_json::json!({ "role": "system", "content": system }),
        serde_json::json!({ "role": "user", "content": user_text }),
    ]
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

fn no_workspace_result() -> ToolResult {
    ToolResult {
        ok: false,
        content: "Error: no workspace folder is open. Ask the user to open one before using tools."
            .to_string(),
        metadata: None,
    }
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
    let id = run_id();
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
            },
        );

    // Detach the loop so this command returns the run id immediately; the UI
    // follows progress through the event channel and can abort via the token.
    let task_app = app.clone();
    let task_id = id.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) =
            run_agent_loop(task_app, runs_dir, task_id.clone(), request, on_event, cancel).await
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
    let created_ms = now_ms();
    let mut seq = 0_u64;
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
    };
    write_summary(&runs_dir, &summary)?;

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
    emit(AgentEvent::UserMessage {
        run_id: id.clone(),
        message_id: message_id("user"),
        text: request.initial_text.clone(),
        attachments: request.attachments.clone(),
        ts: now_ms(),
    })?;

    let system = base_system_prompt(&request);
    let mut messages = provider_messages(&request, system);
    let tools = schemas_for_mode(&request.mode);
    let mut message_count = 1_u32;
    let mut completed = false;
    const MAX_TURNS: usize = 8;
    const COMPACT_AFTER: usize = 14;

    for turn in 0..MAX_TURNS {
        // Auto-compaction: trim verbose tool results from older turns
        if messages.len() > COMPACT_AFTER {
            let mut compacted = 0;
            for msg in messages.iter_mut().skip(1) {
                if compacted >= 5 { break; }
                if msg.get("role").and_then(|v| v.as_str()) == Some("tool") {
                    let name = msg.get("name").and_then(|v| v.as_str()).unwrap_or("tool");
                    let content_len = msg.get("content").and_then(|v| v.as_str()).map(|s| s.len()).unwrap_or(0);
                    if content_len > 200 {
                        msg["content"] = serde_json::Value::String(
                            format!("[compacted: {name}]")
                        );
                        if let Some(obj) = msg.as_object_mut() { obj.remove("name"); }
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
        // Fallback ids ("tool_<idx>") are only unique within one response —
        // stamp the turn so ids stay unique across the whole run (checkpoints
        // and the frontend reducer key on them).
        for call in tool_calls.iter_mut() {
            if call.id.starts_with("tool_") {
                call.id = format!("turn{turn}_{}", call.id);
            }
        }
        let tool_calls = tool_calls;
        let raw_tool_calls = response.tool_calls.clone();
        messages.push(assistant_provider_message(
            &response.content,
            &raw_tool_calls,
        ));
        message_count += 1;

        if tool_calls.is_empty() {
            let mut content = Vec::new();
            if let Some(thinking) = response.thinking.filter(|t| !t.trim().is_empty()) {
                content.push(AgentContentBlock::Thinking { text: thinking });
            }
            content.push(AgentContentBlock::Text {
                text: response.content.clone(),
            });
            emit(AgentEvent::AssistantMessage {
                run_id: id.clone(),
                message_id: assistant_id,
                content,
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
        if !response.content.trim().is_empty() {
            content.push(AgentContentBlock::Text {
                text: response.content.clone(),
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
            ts: now_ms(),
        })?;

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

            if is_write_tool(&call.name) {
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
                    let mut runs = state.runs.lock().map_err(|_| "Agent state unavailable".to_string())?;
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
                            let checkpoint_file =
                                checkpoint_dir.join(format!("{}.json", sanitize_file_id(&proposal.tool_call_id)));
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
                            if proposal.is_create { "created" } else { "changed" }
                        ),
                        metadata: None,
                    };
                }
            } else {
                tool_result = match request.workspace_root.as_deref() {
                    Some(root) => execute_read_only_tool(root, &call),
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
                let ids: Vec<String> = call.input.get("ids")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                    .unwrap_or_default();
                clean_context_ids(&ids, &mut messages);
            }
        }
    }

    if !completed {
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
pub async fn agent_resolve_permission(
    _decision: PermissionDecisionRequest,
) -> Result<(), String> {
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

#[tauri::command]
pub async fn agent_list_runs(
    app: tauri::AppHandle,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<AgentRunSummary>, String> {
    let runs_dir = app_runs_dir(&app)?;
    list_summaries(&runs_dir, limit, offset)
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
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
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
    let entry: CheckpointEntry = serde_json::from_str(&content)
        .map_err(|e| format!("Invalid checkpoint: {e}"))?;

    // Resolve against the workspace the edit was applied in, with the same
    // containment guard as the write tools.
    let workspace_root = Path::new(&entry.workspace_root);
    let full = crate::agent::tools::resolve_new_path(workspace_root, &entry.path)?;

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

        let json = checkpoint_json(
            "edit_x",
            rel,
            "v1",
            "v2",
            false,
            ws.to_str().unwrap(),
            0,
        );
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
        assert!(result.is_err(), "revert must refuse a non-existent workspace root");
        // The checkpoint file should still be present — the revert never
        // got far enough to consume it, so the user can try again after
        // fixing the workspace path.
        assert!(checkpoint_file(&runs, run, "edit_evil").exists());
    }
}
