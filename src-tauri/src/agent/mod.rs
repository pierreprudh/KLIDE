pub mod tools;
pub mod transcripts;
pub mod types;

use self::tools::{execute_read_only_tool, parse_tool_calls, schemas_for_mode, NormalizedToolCall};
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
        "read_file" | "list_dir" => call
            .input
            .get("path")
            .and_then(|v| v.as_str())
            .map(|path| format!("{} {}", call.name, path))
            .unwrap_or_else(|| call.name.clone()),
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

    for _ in 0..MAX_TURNS {
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

        let tool_calls = parse_tool_calls(&response.tool_calls);
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
            // A long tool batch should also notice an abort promptly.
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
            let result = match request.workspace_root.as_deref() {
                Some(root) => execute_read_only_tool(root, &call),
                None => no_workspace_result(),
            };
            emit(AgentEvent::ToolCallFinished {
                run_id: id.clone(),
                tool_call_id: call.id.clone(),
                result: result.clone(),
                ts: now_ms(),
            })?;
            messages.push(tool_provider_message(&call, &result));
        }
    }

    if !completed {
        let error = AgentError {
            code: "max_turns".to_string(),
            message: "Agent reached the maximum read-only tool turns.".to_string(),
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
pub async fn agent_resolve_diff(_decision: DiffDecisionRequest) -> Result<(), String> {
    Err("The harness does not pause for diff review yet; nothing to resolve.".to_string())
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
