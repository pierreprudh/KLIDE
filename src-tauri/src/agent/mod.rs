mod command_allowlist;
#[cfg(test)]
mod eval;
pub mod evidence;
pub mod failure_budget;
mod network_allowlist;
mod permission;
mod run_core;
pub mod todo;
pub mod tools;
pub mod transcripts;
pub mod types;

#[cfg(test)]
use self::run_core::KEEP_RECENT_TOOL_RESULTS;
use self::run_core::{
    append_attachments, apply_clean_context_if_requested, assistant_provider_message,
    compact_old_tool_results, compaction_system_message, compaction_threshold, decide_turn,
    estimate_prompt_tokens, parallel_read_calls, plan_tool_step, provider_messages,
    refresh_todo_context, tool_provider_message, ProviderCaps, ToolStepPlan, TurnDecision,
    TurnStep,
};
use self::tools::{
    apply_write, clear_run_snapshots, dynamic_tool_command, execute_read_only_tool,
    execute_write_tool_preview, find_tool_kind_for_workspace, preflight_command,
    run_command_capture, run_command_capture_in, schemas_for_mode, tool_summary_for_workspace,
    NormalizedToolCall, ToolKind,
};
use self::transcripts::{
    app_runs_dir, append_event, list_summaries, now_ms, read_events, run_id, transcript_path,
    validate_run_id, write_summary,
};
use self::types::{
    AgentContentBlock, AgentContextSnapshot, AgentError, AgentEvent, AgentRunStatus,
    AgentRunSummary, AgentUsage, DiffDecisionRequest, PermissionDecisionRequest, StartRunRequest,
    StartRunResponse, SubmitUserTurnRequest, ToolResult,
};
use crate::{ai_chat, AiChatResponse, AiUsage, StreamChunk};
use serde::Deserialize;
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::Emitter;
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
    /// Same pattern as `pending_diff`, but for `run_command` approval. The
    /// agent_resolve_permission command sends the decision JSON through the
    /// channel, which the run loop awaits before running (or skipping) the
    /// command.
    pub pending_permission: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<String>>>,
    /// Commands the user approved with scope "run"/"project" earlier in this
    /// run — re-running an identical command skips the prompt, so the agent
    /// can `cargo check` repeatedly without re-asking each time.
    pub approved_commands: std::sync::Mutex<std::collections::HashSet<String>>,
    /// Edit proposals the user already rejected this run, keyed by
    /// `<path>::<new_hash>`. If the model proposes the byte-identical change
    /// again, the loop auto-declines it instead of re-prompting — so a single
    /// "Reject" sticks and the agent is told to try something different rather
    /// than re-surfacing the same diff.
    pub rejected_edits: std::sync::Mutex<std::collections::HashSet<String>>,
    /// Shell commands the user rejected this run. Same idea as `rejected_edits`:
    /// proposing the exact same command again is auto-declined, not re-asked.
    pub rejected_commands: std::sync::Mutex<std::collections::HashSet<String>>,
    /// Network targets approved for this run, such as `web_search` or
    /// `host:docs.rs`. Kept separate from command approvals so trust scopes
    /// don't bleed across capability kinds.
    pub approved_network: std::sync::Mutex<std::collections::HashSet<String>>,
    /// Network targets rejected this run. Re-proposing the same target is
    /// auto-declined instead of re-prompting.
    pub rejected_network: std::sync::Mutex<std::collections::HashSet<String>>,
}

pub struct AgentSupervisorState {
    pub runs: Mutex<HashMap<String, AgentRunHandle>>,
    /// Crash-loop quarantine: refuses re-dispatch of a conversation whose
    /// recent runs all errored (see failure_budget.rs for the block rule).
    pub failure_budget: failure_budget::FailureBudget,
}

impl Default for AgentSupervisorState {
    fn default() -> Self {
        Self {
            runs: Mutex::new(HashMap::new()),
            failure_budget: failure_budget::FailureBudget::default(),
        }
    }
}

struct ProviderTurnRequest {
    provider: String,
    model: String,
    messages: Vec<serde_json::Value>,
    tools: Option<Vec<serde_json::Value>>,
    workspace_root: Option<String>,
    num_ctx: Option<usize>,
    num_predict: Option<usize>,
    reflection_level: Option<String>,
    stream: Channel<StreamChunk>,
}

trait AgentProviderCaller: Clone + Send + Sync + 'static {
    fn call<'a>(
        &'a self,
        request: ProviderTurnRequest,
    ) -> Pin<Box<dyn Future<Output = Result<AiChatResponse, String>> + Send + 'a>>;
}

#[derive(Clone, Copy)]
struct RealProviderCaller;

impl AgentProviderCaller for RealProviderCaller {
    fn call<'a>(
        &'a self,
        request: ProviderTurnRequest,
    ) -> Pin<Box<dyn Future<Output = Result<AiChatResponse, String>> + Send + 'a>> {
        Box::pin(async move {
            ai_chat(
                request.provider,
                request.model,
                request.messages,
                request.tools,
                request.workspace_root,
                request.num_ctx,
                request.num_predict,
                request.reflection_level,
                request.stream,
            )
            .await
        })
    }
}

/// The run-scoped capabilities the loop needs from its supervisor: set a run's
/// status, and run a closure against a run's handle (its trust sets + the pause
/// channels). This is the seam that used to be a raw `tauri::AppHandle` reach
/// into `AgentSupervisorState`. `TauriSupervisor` implements it over the live
/// state in production; `FakeSupervisor` (tests) implements it over a plain map
/// — so the whole run loop can be driven headlessly, off the Tauri app.
trait RunSupervisor: Send + Sync {
    /// Best-effort: set a run's status. No-op if the lock/run is unavailable.
    fn set_status(&self, run_id: &str, status: AgentRunStatus);
    /// Run `f` against a run's handle under the supervisor lock. Returns false
    /// when the lock is poisoned or the run handle is gone — both best-effort
    /// (the sets `f` touches are re-ask-avoidance conveniences).
    fn with_handle(&self, run_id: &str, f: &mut dyn FnMut(&AgentRunHandle)) -> bool;
    /// Broadcast a persisted event on the per-run *global* channel
    /// (`agent-run:{id}`), carrying its transcript `seq`. This is the reattach
    /// stream: the request-scoped `Channel` in `agent_start_run` dies when the
    /// webview reloads or the panel unmounts, but the run keeps going in Rust —
    /// so a remounted panel snapshots the transcript then follows this event to
    /// stay live. Best-effort; a no-op off-Tauri (tests). Only events that go
    /// through the `emit` closure (structural events, persisted with a `seq`)
    /// are broadcast — token deltas stream separately and are not replayed.
    fn broadcast(&self, run_id: &str, seq: u64, event: &AgentEvent);
    /// Feed the failure budget: a run settled in error (`failed`) or done.
    /// Default no-op keeps FakeSupervisor tests headless; the budget itself
    /// is unit-tested in failure_budget.rs.
    fn note_terminal(&self, _run_id: &str, _provider: &str, _model: &str, _failed: bool) {}
}

/// Payload for the `agent-run:{id}` reattach stream. `seq` is the event's
/// transcript index, so the frontend drops any live event already covered by
/// its snapshot (`seq < snapshot.len()`).
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RunEventEnvelope {
    seq: u64,
    event: AgentEvent,
}

/// Production adapter: the supervisor backed by Tauri's managed
/// `AgentSupervisorState`. Owns a cheap `AppHandle` clone.
struct TauriSupervisor {
    app: tauri::AppHandle,
}

impl TauriSupervisor {
    fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl RunSupervisor for TauriSupervisor {
    fn set_status(&self, run_id: &str, status: AgentRunStatus) {
        let state = self.app.state::<AgentSupervisorState>();
        let Ok(mut runs) = state.runs.lock() else {
            return;
        };
        if let Some(handle) = runs.get_mut(run_id) {
            handle.status = status;
        }
    }

    fn with_handle(&self, run_id: &str, f: &mut dyn FnMut(&AgentRunHandle)) -> bool {
        let state = self.app.state::<AgentSupervisorState>();
        let Ok(runs) = state.runs.lock() else {
            return false;
        };
        match runs.get(run_id) {
            Some(handle) => {
                f(handle);
                true
            }
            None => false,
        }
    }

    fn broadcast(&self, run_id: &str, seq: u64, event: &AgentEvent) {
        let _ = self.app.emit(
            &format!("agent-run:{run_id}"),
            RunEventEnvelope {
                seq,
                event: event.clone(),
            },
        );
    }

    fn note_terminal(&self, run_id: &str, provider: &str, model: &str, failed: bool) {
        let budget = &self.app.state::<AgentSupervisorState>().failure_budget;
        if failed {
            budget.record_failure(run_id, provider, model, now_ms());
        } else {
            budget.record_success(run_id);
        }
    }
}

fn set_run_status(sup: &dyn RunSupervisor, run_id: &str, status: AgentRunStatus) {
    sup.set_status(run_id, status);
}

/// Settle a run that ended without cancellation (done / error / max-turns):
/// broadcast the terminal status and write the terminal summary to disk. The one
/// place the "status + summary" terminal sequence lives — callers only choose
/// the status. (Cancellation adds a RunError(aborted) emit on top; see
/// `finish_cancelled`.)
fn settle_run(
    sup: &dyn RunSupervisor,
    runs_dir: &Path,
    id: &str,
    summary: &AgentRunSummary,
    message_count: u32,
    status: AgentRunStatus,
) -> Result<(), String> {
    set_run_status(sup, id, status);
    // Only real outcomes move the failure budget: error counts against it,
    // done clears it, cancellation is the user's call and says nothing.
    match status {
        AgentRunStatus::Error => sup.note_terminal(id, &summary.provider, &summary.model, true),
        AgentRunStatus::Done => {
            sup.note_terminal(id, &summary.provider, &summary.model, false);
            // Persist the run's edits onto its branch. Headless worktree runs
            // (races, fleets) auto-apply edits into the working tree but never
            // commit, so without this the branch stays empty and merging a
            // winner would carry nothing. Guarded to linked worktrees only, so
            // this can never commit on the user's main checkout.
            commit_worktree_on_done(summary);
        }
        _ => {}
    }
    write_summary(
        runs_dir,
        &AgentRunSummary {
            status: run_status_wire(&status).to_string(),
            updated_ms: now_ms(),
            message_count,
            ..summary.clone()
        },
    )
}

/// Commit a finished run's working-tree edits onto its branch.
///
/// Only ever touches a **linked worktree**: `worktree_label` returns `Some`
/// exactly when the checkout's `.git` is a gitdir-pointer file, which is never
/// the case for the repo's main working copy — so a normal Klide run in the
/// user's checkout is left untouched and only isolated race/fleet worktrees get
/// an auto-commit. A no-op when the tree is clean. Best-effort: a git failure
/// here must not turn a successful run into an error, so results are ignored
/// and the worst case is the pre-existing "branch has no commit" state.
fn commit_worktree_on_done(summary: &AgentRunSummary) {
    let Some(cwd) = summary.cwd.as_deref() else {
        return;
    };
    if crate::delegate::worktree_label(cwd).is_none() {
        return;
    }
    let dirty = std::process::Command::new("git")
        .args(["-C", cwd, "status", "--porcelain"])
        .output()
        .ok()
        .map(|o| !String::from_utf8_lossy(&o.stdout).trim().is_empty())
        .unwrap_or(false);
    if !dirty {
        return;
    }
    let subject = format!("klide: {}", title_from_text(&summary.title));
    let message = format!(
        "{subject}\n\nKlide agent run {}\nCo-Authored-By: {} <noreply@klide.local>",
        summary.id, summary.model
    );
    if std::process::Command::new("git")
        .args(["-C", cwd, "add", "-A"])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
    {
        let _ = std::process::Command::new("git")
            .args(["-C", cwd, "commit", "-m", &message])
            .status();
    }
}

fn run_status_wire(status: &AgentRunStatus) -> &'static str {
    match status {
        AgentRunStatus::Queued => "queued",
        AgentRunStatus::Running => "running",
        AgentRunStatus::WaitingForPermission => "waiting_for_permission",
        AgentRunStatus::WaitingForDiff => "waiting_for_diff",
        AgentRunStatus::Paused => "paused",
        AgentRunStatus::Done => "done",
        AgentRunStatus::Error => "error",
        AgentRunStatus::Cancelled => "cancelled",
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

/// Replay a prior run's transcript back into provider-shaped messages so
/// the new run starts with the same context the user already saw on
/// screen.
///
/// There are two wire shapes, picked by `structured`:
///
/// 1. **Structured** (`structured == true`) — the OpenAI-compatible shape
///    the live loop already uses: `assistant` with a `tool_calls` array
///    plus `role: "tool"` messages keyed by `tool_call_id`. Every
///    OpenAI-wire provider speaks this (OpenAI, Anthropic, Mistral, xAI,
///    LM Studio, custom self-hosted endpoints, *and* Ollama reached over
///    its `/v1` compat path). This is the faithful replay: the model sees
///    its own prior tool calls exactly as it made them.
///
/// 2. **Text-fold** (`structured == false`) — for Ollama's *native*
///    `/api/chat` endpoint only. That API wants `tool_calls[*].function
///    .arguments` as a JSON object (not the OpenAI-encoded string) and has
///    no `tool_call_id` field on tool results, so replaying the structured
///    shape into it made the local server reject the request with `Value
///    looks like object, but can't find closing '}' symbol`. The portable
///    workaround folds the tool flow into the next assistant message's
///    text:
///
///   user  →  { role: "user", content: text [+ attached files] }
///   assistant_message
///         →  { role: "assistant", content: text [+ folded tool results] }
///   tool_call_finished
///         →  buffered; folded into the next assistant_message
///
///    NOTE: do NOT use the text-fold for OpenAI-wire providers. Folding
///    tool results into assistant text as `[tool_result]…:end` teaches
///    smaller models (e.g. devstral) to *imitate* that format — after a
///    couple of turns they stop emitting structured `tool_calls` and start
///    narrating fabricated tool transcripts as plain text instead.
///
/// Thinking blocks are dropped in both shapes — the model already consumed
/// them. Compaction that already ran in the parent is preserved as-is.
fn reconstruct_prior_messages(
    prior_events: &[AgentEvent],
    structured: bool,
) -> Vec<serde_json::Value> {
    if structured {
        return reconstruct_structured_messages(prior_events);
    }
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
                append_attachments(&mut content, attachments);
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
                out.push(compaction_system_message(summary));
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

/// Faithful OpenAI-wire replay (see `reconstruct_prior_messages` docs).
/// Rebuilds the exact `assistant.tool_calls` + `role: "tool"` shape the
/// live loop produces, so a continuation turn sees its own prior tool
/// calls structurally — never as imitated text.
///
/// A tool_call is only replayed if it has a matching `ToolCallFinished`
/// later in the stream. OpenAI-compatible APIs reject an assistant
/// `tool_calls` entry with no following `role: "tool"` reply, so a turn
/// that was cancelled mid-call (started, never finished) would otherwise
/// poison the whole request. We pre-scan for finished ids and drop the
/// orphans — matching the text-fold path, which also drops them.
fn reconstruct_structured_messages(prior_events: &[AgentEvent]) -> Vec<serde_json::Value> {
    use std::collections::{HashMap, HashSet};

    // Tool calls that actually returned a result. Calls without one are
    // dropped so we never emit an unanswered `assistant.tool_calls`.
    let finished: HashSet<&str> = prior_events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::ToolCallFinished { tool_call_id, .. } => Some(tool_call_id.as_str()),
            _ => None,
        })
        .collect();

    let mut out: Vec<serde_json::Value> = Vec::new();
    // tool_call_id -> tool name, so a later `ToolCallFinished` can label
    // its `role: "tool"` message the way `tool_provider_message` does.
    let mut call_names: HashMap<String, String> = HashMap::new();

    for event in prior_events {
        match event {
            AgentEvent::UserMessage {
                text, attachments, ..
            } => {
                let mut content = text.clone();
                append_attachments(&mut content, attachments);
                out.push(serde_json::json!({ "role": "user", "content": content }));
            }
            AgentEvent::AssistantMessage { content, .. } => {
                let mut text = String::new();
                let mut raw_tool_calls: Vec<serde_json::Value> = Vec::new();
                for block in content {
                    match block {
                        AgentContentBlock::Text { text: t } => text.push_str(t),
                        AgentContentBlock::ToolCall {
                            tool_call_id,
                            name,
                            input,
                        } => {
                            // Skip calls that never returned — see fn docs.
                            if !finished.contains(tool_call_id.as_str()) {
                                continue;
                            }
                            call_names.insert(tool_call_id.clone(), name.clone());
                            // OpenAI wire wants `arguments` as a JSON-encoded
                            // string, matching the live loop's raw tool_calls.
                            raw_tool_calls.push(serde_json::json!({
                                "id": tool_call_id,
                                "type": "function",
                                "function": {
                                    "name": name,
                                    "arguments": input.to_string(),
                                },
                            }));
                        }
                        _ => {}
                    }
                }
                out.push(assistant_provider_message(&text, &raw_tool_calls));
            }
            AgentEvent::ToolCallFinished {
                tool_call_id,
                result,
                ..
            } => {
                // Pair with the assistant turn's tool_call. If we never saw
                // the originating call (shouldn't happen — finished implies
                // started), fall back to an empty name.
                let name = call_names.get(tool_call_id).cloned().unwrap_or_default();
                out.push(serde_json::json!({
                    "role": "tool",
                    "content": result.content,
                    "name": name,
                    "tool_call_id": tool_call_id,
                }));
            }
            AgentEvent::ContextCompacted { summary, .. } => {
                out.clear();
                call_names.clear();
                out.push(compaction_system_message(summary));
            }
            _ => {}
        }
    }

    out
}

/// Map the private provider-side `AiUsage` into the wire-format
/// `AgentUsage` so the frontend can decode it without depending on a
/// private type. Cheap (four `Option<u64>`s); done on every turn.
fn agent_usage_from(usage: Option<AiUsage>, model: &str) -> Option<AgentUsage> {
    let u = usage?;
    let is_empty = u.prompt_tokens.is_none()
        && u.completion_tokens.is_none()
        && u.eval_duration_ms.is_none()
        && u.prompt_eval_duration_ms.is_none()
        && u.cost_usd.is_none();
    if is_empty {
        return None;
    }
    // Cost, in priority order: the provider's real charged amount
    // (OpenRouter) wins; otherwise estimate from the local pricing table ×
    // token counts (Anthropic/OpenAI direct). `None` for local /
    // subscription / unknown-price models.
    let cost_usd = u
        .cost_usd
        .or_else(|| match (u.prompt_tokens, u.completion_tokens) {
            (Some(p), Some(c)) => crate::pricing::cost_for_run(model, p as i64, c as i64),
            _ => None,
        });
    Some(AgentUsage {
        prompt_tokens: u.prompt_tokens,
        completion_tokens: u.completion_tokens,
        eval_duration_ms: u.eval_duration_ms,
        prompt_eval_duration_ms: u.prompt_eval_duration_ms,
        cost_usd,
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

async fn run_test_after_edit(
    root: &str,
    command: Option<&str>,
    timeout_secs: u64,
    result: &mut ToolResult,
) {
    let Some(command) = command.map(str::trim).filter(|c| !c.is_empty()) else {
        return;
    };
    let check = run_command_capture(root, command, timeout_secs).await;
    let status = if check.ok { "passed" } else { "failed" };
    result.content.push_str(&format!(
        "\nPost-edit check `{command}` {status}.\n{}",
        check.content
    ));
    result.metadata = Some(serde_json::json!({
        "testAfterEdit": {
            "command": command,
            "ok": check.ok,
        }
    }));
    if !check.ok {
        result.ok = false;
        result
            .content
            .push_str("\nThe edit was applied; inspect the failing check and fix forward.");
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

/// Settle a cancelled run: aborted event, summary on disk, handle status.
fn finish_cancelled<E: FnMut(AgentEvent) -> Result<(), String>>(
    emit: &mut E,
    sup: &dyn RunSupervisor,
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
    settle_run(
        sup,
        runs_dir,
        id,
        summary,
        message_count,
        AgentRunStatus::Cancelled,
    )
}

/// What a pause settled to: the user's reply, or cancellation while waiting.
/// On `Cancelled` the caller settles the run via `finish_cancelled` and returns
/// — only it can return out of the run loop, so the pause can't do it here.
enum PauseOutcome {
    Resolved(String),
    Cancelled,
}

/// Every run pause is the same shape: flip the run to a waiting status, stash a
/// oneshot the matching `agent_resolve_*` command unblocks, emit the request
/// event (*after* the sender is in place, so a fast reply can't race past it),
/// then await the reply or cancellation and restore `Running`. Only four things
/// vary — which `pending_*` slot to fill, the waiting status, the request event,
/// and the default used if the channel closes — so those are the parameters.
/// This is the one place the question / permission / diff pauses share.
async fn pause_for_user<E, S>(
    sup: &dyn RunSupervisor,
    id: &str,
    waiting: AgentRunStatus,
    request_event: AgentEvent,
    default_on_close: &str,
    cancel: &CancellationToken,
    emit: &mut E,
    stash: S,
) -> Result<PauseOutcome, String>
where
    E: FnMut(AgentEvent) -> Result<(), String>,
    S: FnOnce(&AgentRunHandle, tokio::sync::oneshot::Sender<String>),
{
    set_run_status(sup, id, waiting);
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    {
        // Stash the reply sender into the run's handle. If the handle is gone,
        // `tx` drops here and `rx` resolves to `default_on_close` below — the
        // same degrade-to-default the old lock-miss path produced.
        let mut stash = Some(stash);
        let mut tx = Some(tx);
        sup.with_handle(id, &mut |handle| {
            if let (Some(stash), Some(tx)) = (stash.take(), tx.take()) {
                stash(handle, tx);
            }
        });
    }

    emit(request_event)?;

    let reply = tokio::select! {
        _ = cancel.cancelled() => {
            set_run_status(sup, id, AgentRunStatus::Running);
            return Ok(PauseOutcome::Cancelled);
        }
        result = rx => result.unwrap_or_else(|_| default_on_close.to_string()),
    };
    set_run_status(sup, id, AgentRunStatus::Running);
    Ok(PauseOutcome::Resolved(reply))
}

/// Run a closure against one run's handle, holding the supervisor lock only for
/// the closure body. The one place the "lock the supervisor map, find this run"
/// ceremony lives — every per-run set the loop touches (approved / rejected
/// commands and edits) goes through here.
///
/// Returns `None` when the supervisor lock is unavailable or the run handle is
/// already gone. Both are best-effort cases: the sets it guards are
/// re-ask-avoidance conveniences, so degrading to `None` (and thus re-prompting
/// the user) is a safer failure mode than erroring the whole run.
fn with_run_handle<R>(
    sup: &dyn RunSupervisor,
    id: &str,
    f: impl FnOnce(&AgentRunHandle) -> R,
) -> Option<R> {
    let mut out: Option<R> = None;
    let mut f = Some(f);
    sup.with_handle(id, &mut |handle| {
        if let Some(f) = f.take() {
            out = Some(f(handle));
        }
    });
    out
}

/// The slice of run-loop state a per-tool handler needs to execute one tool
/// call: the supervisor (run state + pause channels), the run id, the start
/// request (workspace root, allowlists, timeouts, review mode), the cancel
/// token, and the runs dir (write checkpoints). Bundled so each handler takes
/// one context rather than six positional args. All borrows — cheap to build
/// once per call.
struct ToolCtx<'a> {
    sup: &'a dyn RunSupervisor,
    id: &'a str,
    request: &'a StartRunRequest,
    cancel: &'a CancellationToken,
    runs_dir: &'a std::path::Path,
}

/// What a per-tool handler hands back to the loop. `Produced` carries the
/// result the loop will emit + append uniformly; `Cancelled` means the user
/// cancelled during a pause, so the loop settles the run and returns — the
/// same two-arm shape as `PauseOutcome`, lifted to the whole tool step so the
/// `finish_cancelled` + early-return stays in the loop, not the handlers.
enum ToolOutcome {
    Produced(ToolResult),
    Cancelled,
}

/// Pause tool (`userAnswerQuestion`): ask the user a typed question and feed
/// their verbatim answer back to the model. "(skipped)" is the sentinel the
/// user can send to decline. Cancelling during the wait bubbles up as
/// `Cancelled`.
async fn process_pause_tool<E>(
    ctx: &ToolCtx<'_>,
    call: &NormalizedToolCall,
    emit: &mut E,
) -> Result<ToolOutcome, String>
where
    E: FnMut(AgentEvent) -> Result<(), String>,
{
    let question = call
        .input
        .get("question")
        .and_then(|v| v.as_str())
        .unwrap_or("(empty question)")
        .to_string();
    let request_id = format!("q_{}_{}", ctx.id, call.id);

    let answer = match pause_for_user(
        ctx.sup,
        ctx.id,
        AgentRunStatus::WaitingForPermission,
        AgentEvent::UserQuestionRequested {
            run_id: ctx.id.to_string(),
            request_id: request_id.clone(),
            question: question.clone(),
            ts: now_ms(),
        },
        "(skipped)",
        ctx.cancel,
        emit,
        |handle, tx| {
            *handle.pending_question.lock().unwrap() = Some(tx);
        },
    )
    .await?
    {
        PauseOutcome::Cancelled => return Ok(ToolOutcome::Cancelled),
        PauseOutcome::Resolved(answer) => answer,
    };

    emit(AgentEvent::UserQuestionResolved {
        run_id: ctx.id.to_string(),
        request_id,
        answer: answer.clone(),
        ts: now_ms(),
    })?;

    Ok(ToolOutcome::Produced(ToolResult {
        ok: true,
        content: if answer == "(skipped)" {
            "[user skipped this question]".to_string()
        } else {
            answer
        },
        metadata: None,
    }))
}

/// Subagent spawn tool (`spawn_subagent`): a Pause tool that delegates a
/// focused, read-only investigation to a named subagent. The loop emits
/// `SubagentRequested` and parks on the same oneshot the question pause uses;
/// the frontend runs the child subagent (nested under this run via `parentId`)
/// and resolves through `agent_resolve_question` with the subagent's report,
/// which becomes this tool's result. Cancelling during the wait bubbles up as
/// `Cancelled`.
async fn process_subagent_tool<E>(
    ctx: &ToolCtx<'_>,
    call: &NormalizedToolCall,
    emit: &mut E,
) -> Result<ToolOutcome, String>
where
    E: FnMut(AgentEvent) -> Result<(), String>,
{
    let subagent = call
        .input
        .get("subagent")
        .and_then(|v| v.as_str())
        .unwrap_or("explorer")
        .to_string();
    let task = call
        .input
        .get("task")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let request_id = format!("sub_{}_{}", ctx.id, call.id);

    let report = match pause_for_user(
        ctx.sup,
        ctx.id,
        AgentRunStatus::WaitingForPermission,
        AgentEvent::SubagentRequested {
            run_id: ctx.id.to_string(),
            request_id: request_id.clone(),
            subagent: subagent.clone(),
            task: task.clone(),
            ts: now_ms(),
        },
        "(subagent produced no output)",
        ctx.cancel,
        emit,
        |handle, tx| {
            *handle.pending_question.lock().unwrap() = Some(tx);
        },
    )
    .await?
    {
        PauseOutcome::Cancelled => return Ok(ToolOutcome::Cancelled),
        PauseOutcome::Resolved(report) => report,
    };

    emit(AgentEvent::SubagentResolved {
        run_id: ctx.id.to_string(),
        request_id,
        result: report.clone(),
        ts: now_ms(),
    })?;

    Ok(ToolOutcome::Produced(ToolResult {
        ok: true,
        content: report,
        metadata: Some(serde_json::json!({ "subagent": subagent })),
    }))
}

/// Advisor consult tool (`consult_advisor`): a Pause tool that escalates one
/// hard decision to a stronger advisor model. The loop emits `AdvisorRequested`
/// and parks on the shared question oneshot; the frontend asks a bigger model
/// (or a Claude Code session) the executor's question and resolves through
/// `agent_resolve_question` with the advice, which becomes this tool's result.
/// Distinct from `spawn_subagent`: the advisor gives *guidance*, not a nested
/// agentic run — the executor stays in control and applies the advice itself.
/// Cancelling during the wait bubbles up as `Cancelled`.
/// Sentinel the frontend prepends when an advisor consult fails (no key,
/// provider unreachable, empty reply). The shared question oneshot only carries
/// a string, so this marker is how a failure crosses back — process_advisor_tool
/// strips it and returns a NOT-ok tool result. Keep in sync with the same
/// constant in AiPanel's runAdvisorConsult.
const ADVISOR_ERROR_PREFIX: &str = "[advisor:error] ";

async fn process_advisor_tool<E>(
    ctx: &ToolCtx<'_>,
    call: &NormalizedToolCall,
    emit: &mut E,
) -> Result<ToolOutcome, String>
where
    E: FnMut(AgentEvent) -> Result<(), String>,
{
    let question = call
        .input
        .get("question")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    // Fold optional `context` into the question so the advisor sees one
    // self-contained prompt — the frontend forwards this verbatim.
    let question = match call.input.get("context").and_then(|v| v.as_str()) {
        Some(c) if !c.trim().is_empty() => format!("{question}\n\nContext:\n{}", c.trim()),
        _ => question,
    };
    let request_id = format!("adv_{}_{}", ctx.id, call.id);

    let advice = match pause_for_user(
        ctx.sup,
        ctx.id,
        AgentRunStatus::WaitingForPermission,
        AgentEvent::AdvisorRequested {
            run_id: ctx.id.to_string(),
            request_id: request_id.clone(),
            question: question.clone(),
            ts: now_ms(),
        },
        // A closed channel is a failure, not advice — mark it so below.
        ADVISOR_ERROR_PREFIX,
        ctx.cancel,
        emit,
        |handle, tx| {
            *handle.pending_question.lock().unwrap() = Some(tx);
        },
    )
    .await?
    {
        PauseOutcome::Cancelled => return Ok(ToolOutcome::Cancelled),
        PauseOutcome::Resolved(advice) => advice,
    };

    emit(AgentEvent::AdvisorResolved {
        run_id: ctx.id.to_string(),
        request_id,
        advice: advice.clone(),
        ts: now_ms(),
    })?;

    // A failed consult (no key, provider down, empty reply) is prefixed with
    // ADVISOR_ERROR_PREFIX by the frontend. Surface it as a NOT-ok tool result
    // so the executor treats it as a failure, not as guidance it should follow.
    if let Some(msg) = advice.strip_prefix(ADVISOR_ERROR_PREFIX) {
        return Ok(ToolOutcome::Produced(ToolResult {
            ok: false,
            content: format!("Advisor consult failed: {}", msg.trim()),
            metadata: Some(serde_json::json!({ "advisor": true })),
        }));
    }

    Ok(ToolOutcome::Produced(ToolResult {
        ok: true,
        content: format!("Advisor guidance:\n{advice}"),
        metadata: Some(serde_json::json!({ "advisor": true })),
    }))
}

/// Command tool (`run_command` and dynamic command-capability tools): run a
/// shell command, but only after the user approves it through the permission
/// gate. Approvals/rejections are remembered per-run (and project-scoped ones
/// persist to the on-disk allowlist) so an identical command doesn't re-prompt.
/// Cancelling during the approval wait bubbles up as `Cancelled`.
/// The four options every command/network gate offers, declared once so the
/// optionId / behavior / scope wire contract can't drift between capabilities.
/// Only the run/project labels differ ("Approve for this run" vs "Approve
/// target for this run").
fn standard_gate_options(run_label: &str, project_label: &str) -> serde_json::Value {
    serde_json::json!([
        { "optionId": "allow_once", "label": "Approve", "behavior": "allow", "scope": "once" },
        { "optionId": "allow_run", "label": run_label, "behavior": "allow", "scope": "run" },
        { "optionId": "allow_project", "label": project_label, "behavior": "allow", "scope": "project" },
        { "optionId": "deny", "label": "Reject", "behavior": "deny" }
    ])
}

async fn process_command_tool<E>(
    ctx: &ToolCtx<'_>,
    call: &NormalizedToolCall,
    emit: &mut E,
) -> Result<ToolOutcome, String>
where
    E: FnMut(AgentEvent) -> Result<(), String>,
{
    let root_value = match ctx.request.workspace_root.as_deref() {
        Some(root) => root,
        None => return Ok(ToolOutcome::Produced(no_workspace_result())),
    };

    let invocation = if call.name == "run_command" {
        let command = call
            .input
            .get("command")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if command.is_empty() {
            Err(ToolResult {
                ok: false,
                content: "run_command requires a non-empty command.".to_string(),
                metadata: None,
            })
        } else {
            // Default 180s; configurable for long builds. Clamped so a bad
            // setting can't disable the runaway guard.
            let timeout_secs = ctx
                .request
                .command_timeout_secs
                .unwrap_or(180)
                .clamp(1, 1800);
            Ok((
                "run_command".to_string(),
                command.clone(),
                root_value.to_string(),
                timeout_secs,
                format!("$ {command}"),
                "The agent wants to run a shell command in the workspace.".to_string(),
            ))
        }
    } else {
        match dynamic_tool_command(&call.name, &call.input, root_value) {
            Some(Ok(invocation)) => Ok((
                invocation.tool_name,
                invocation.command,
                invocation.cwd,
                invocation.timeout_secs,
                invocation.summary,
                invocation.reason,
            )),
            Some(Err(result)) => Err(result),
            None => Err(ToolResult {
                ok: false,
                content: format!("Unknown command-capability tool: {}", call.name),
                metadata: None,
            }),
        }
    };

    let (permission_tool_name, command, cwd, timeout_secs, permission_summary, reason) =
        match invocation {
            Err(result) => return Ok(ToolOutcome::Produced(result)),
            Ok(inv) => inv,
        };

    let approval_key = if cwd == root_value {
        command.clone()
    } else {
        format!("{cwd} :: {command}")
    };
    let preflight = preflight_command(root_value, &cwd, &command);
    // Wildcard allowlist rules are intentionally narrower than exact approvals:
    // if a wildcard command references outside-workspace paths, ask again so the
    // path is visible to the user instead of hidden behind a broad pattern. That
    // nuance is command-specific, so the project verdict is computed here and
    // handed to the engine as a plain bool.
    let matched_rule =
        command_allowlist::match_rule(&ctx.request.command_allowlist, &command, &approval_key);
    let project_ok = matched_rule
        .as_ref()
        .map(|rule| rule.exact || preflight.external_paths.is_empty())
        .unwrap_or(false);

    match permission::precheck(
        ctx,
        permission::Capability::Command,
        &approval_key,
        project_ok,
    ) {
        permission::Precheck::Execute => {
            return Ok(ToolOutcome::Produced(
                run_command_capture_in(root_value, &cwd, &command, timeout_secs).await,
            ));
        }
        permission::Precheck::AutoReject(msg) => {
            return Ok(ToolOutcome::Produced(ToolResult {
                ok: false,
                content: msg.to_string(),
                metadata: None,
            }));
        }
        permission::Precheck::Ask => {}
    }

    let external_paths = preflight.external_paths.clone();
    let mut permission_reason = reason;
    if !external_paths.is_empty() {
        permission_reason.push_str(" It references paths outside the workspace: ");
        permission_reason.push_str(&external_paths.join(", "));
        permission_reason.push('.');
    }
    if let Some(rule) = matched_rule.as_ref() {
        permission_reason.push_str(&format!(
            " Project rule `{}` matched, but this command still needs approval.",
            rule.pattern
        ));
    }

    let perm = serde_json::json!({
        "id": permission::request_id(ctx, call),
        "runId": ctx.id,
        "toolCallId": call.id,
        "toolName": permission_tool_name,
        "input": {
            "command": command,
            "cwd": cwd,
            "externalPaths": external_paths,
            "matchedAllowRule": matched_rule.as_ref().map(|rule| rule.pattern.clone())
        },
        "summary": permission_summary,
        "reason": permission_reason,
        "options": standard_gate_options("Approve for this run", "Approve for this project")
    });

    let decision = match permission::run_gate(ctx, call, perm, emit).await? {
        permission::GateDecision::Cancelled => return Ok(ToolOutcome::Cancelled),
        decision => decision,
    };
    permission::record(
        ctx,
        permission::Capability::Command,
        &approval_key,
        &command,
        &decision,
    );

    let result = match decision {
        permission::GateDecision::Approved { .. } => {
            run_command_capture_in(root_value, &cwd, &command, timeout_secs).await
        }
        _ => ToolResult {
            ok: false,
            content: permission::Capability::Command
                .rejected_message()
                .to_string(),
            metadata: None,
        },
    };
    Ok(ToolOutcome::Produced(result))
}

struct NetworkInvocation {
    target: String,
    summary: String,
    reason: String,
    input: serde_json::Value,
}

fn network_invocation(call: &NormalizedToolCall) -> Result<NetworkInvocation, ToolResult> {
    match call.name.as_str() {
        "web_search" => {
            let query = call
                .input
                .get("query")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| ToolResult {
                    ok: false,
                    content: "web_search requires a query.".to_string(),
                    metadata: None,
                })?;
            Ok(NetworkInvocation {
                target: "web_search".to_string(),
                summary: format!("web_search {query}"),
                reason: "The agent wants to search the web.".to_string(),
                input: serde_json::json!({
                    "query": query,
                    "target": "web_search"
                }),
            })
        }
        "web_fetch" => {
            let url = call
                .input
                .get("url")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| ToolResult {
                    ok: false,
                    content: "web_fetch requires a url.".to_string(),
                    metadata: None,
                })?;
            let parsed = reqwest::Url::parse(url).map_err(|e| ToolResult {
                ok: false,
                content: format!("web_fetch requires a valid URL: {e}"),
                metadata: None,
            })?;
            let host = parsed.host_str().ok_or_else(|| ToolResult {
                ok: false,
                content: "web_fetch URL must include a host.".to_string(),
                metadata: None,
            })?;
            let host = host.to_ascii_lowercase();
            Ok(NetworkInvocation {
                target: format!("host:{host}"),
                summary: format!("web_fetch {host}"),
                reason: format!("The agent wants to fetch content from {host}."),
                input: serde_json::json!({
                    "url": url,
                    "host": host,
                    "target": format!("host:{host}")
                }),
            })
        }
        _ => Ok(NetworkInvocation {
            target: format!("tool:{}", call.name),
            summary: call.name.clone(),
            reason: "The agent wants to use a network-capability tool.".to_string(),
            input: serde_json::json!({
                "target": format!("tool:{}", call.name)
            }),
        }),
    }
}

async fn process_network_tool<E>(
    ctx: &ToolCtx<'_>,
    call: &NormalizedToolCall,
    emit: &mut E,
) -> Result<ToolOutcome, String>
where
    E: FnMut(AgentEvent) -> Result<(), String>,
{
    let root_value = match ctx.request.workspace_root.as_deref() {
        Some(root) => root,
        None => return Ok(ToolOutcome::Produced(no_workspace_result())),
    };
    let invocation = match network_invocation(call) {
        Ok(invocation) => invocation,
        Err(result) => return Ok(ToolOutcome::Produced(result)),
    };
    let target = invocation.target.clone();
    let project_ok = network_allowlist::is_allowed(root_value, &target).unwrap_or(false);

    match permission::precheck(ctx, permission::Capability::Network, &target, project_ok) {
        permission::Precheck::Execute => {
            return Ok(ToolOutcome::Produced(execute_read_only_tool(
                root_value, call, ctx.id,
            )));
        }
        permission::Precheck::AutoReject(msg) => {
            return Ok(ToolOutcome::Produced(ToolResult {
                ok: false,
                content: msg.to_string(),
                metadata: None,
            }));
        }
        permission::Precheck::Ask => {}
    }

    let perm = serde_json::json!({
        "id": permission::request_id(ctx, call),
        "runId": ctx.id,
        "toolCallId": call.id,
        "toolName": call.name,
        "input": invocation.input,
        "summary": invocation.summary,
        "reason": invocation.reason,
        "options": standard_gate_options("Approve target for this run", "Approve target for this project")
    });

    let decision = match permission::run_gate(ctx, call, perm, emit).await? {
        permission::GateDecision::Cancelled => return Ok(ToolOutcome::Cancelled),
        decision => decision,
    };
    permission::record(
        ctx,
        permission::Capability::Network,
        &target,
        &target,
        &decision,
    );

    let result = match decision {
        permission::GateDecision::Approved { .. } => {
            execute_read_only_tool(root_value, call, ctx.id)
        }
        _ => ToolResult {
            ok: false,
            content: permission::Capability::Network
                .rejected_message()
                .to_string(),
            metadata: None,
        },
    };
    Ok(ToolOutcome::Produced(result))
}

/// Write tool (`write_file`, `create_file`): preview the edit as a diff, pass it
/// through the diff-review gate (or auto-apply when review is off), and on
/// "apply" write the file, save a checkpoint for rollback, and run the
/// optional test-after-edit command. A byte-identical re-proposal of an
/// already-rejected change is auto-declined. Cancelling during review bubbles
/// up as `Cancelled`.
/// Parse a resolved diff decision. The channel carries either a bare behavior
/// string ("apply" / "reject" — also the pause's cancellation default) or the
/// frontend's full decision JSON `{"behavior": "...", "note": "..."}` where
/// `note` is the user's review feedback. Tolerates both; unknown shapes read
/// as a plain rejection.
fn parse_diff_decision(raw: &str) -> (String, Option<String>) {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) {
        if let Some(obj) = value.as_object() {
            let behavior = obj
                .get("behavior")
                .and_then(|b| b.as_str())
                .unwrap_or("reject")
                .to_string();
            let note = obj
                .get("note")
                .and_then(|n| n.as_str())
                .map(str::trim)
                .filter(|n| !n.is_empty())
                .map(str::to_string);
            return (behavior, note);
        }
        if let Some(s) = value.as_str() {
            return (s.to_string(), None);
        }
    }
    (raw.to_string(), None)
}

async fn process_write_tool<E>(
    ctx: &ToolCtx<'_>,
    call: &NormalizedToolCall,
    emit: &mut E,
) -> Result<ToolOutcome, String>
where
    E: FnMut(AgentEvent) -> Result<(), String>,
{
    let root = match ctx.request.workspace_root.as_deref() {
        Some(root) => root,
        None => return Ok(ToolOutcome::Produced(no_workspace_result())),
    };

    let proposal = match execute_write_tool_preview(root, call, ctx.id) {
        Ok(p) => p,
        Err(error_result) => return Ok(ToolOutcome::Produced(error_result)),
    };

    // Identical to a change the user already rejected this run? (Same path +
    // same resulting content.) Auto-decline without a second diff prompt so one
    // "Reject" sticks; tell the model to change course rather than re-surfacing
    // the same diff.
    let edit_key = format!("{}::{}", proposal.path, proposal.new_hash);
    let already_rejected = with_run_handle(ctx.sup, ctx.id, |h| {
        h.rejected_edits.lock().unwrap().contains(&edit_key)
    })
    .unwrap_or(false);
    if already_rejected {
        return Ok(ToolOutcome::Produced(ToolResult {
            ok: false,
            content: format!(
                "You already proposed this exact change to {} and the user rejected it. \
Do not propose it again — take a different approach or ask the user what they'd prefer.",
                proposal.path
            ),
            metadata: None,
        }));
    }

    // Auto-accept mode (require_diff_review == Some(false)): apply without
    // pausing. Still emit the proposed diff so the edit stays visible in the
    // conversation, and the checkpoint written below keeps it revertable —
    // which is what makes auto-accept safe. Otherwise pause for diff review.
    let decision = if ctx.request.require_diff_review == Some(false) {
        emit(AgentEvent::DiffProposed {
            run_id: ctx.id.to_string(),
            proposal: proposal.clone(),
            ts: now_ms(),
        })?;
        "apply".to_string()
    } else {
        match pause_for_user(
            ctx.sup,
            ctx.id,
            AgentRunStatus::WaitingForDiff,
            AgentEvent::DiffProposed {
                run_id: ctx.id.to_string(),
                proposal: proposal.clone(),
                ts: now_ms(),
            },
            "reject",
            ctx.cancel,
            emit,
            |handle, tx| {
                *handle.pending_diff.lock().unwrap() = Some(tx);
            },
        )
        .await?
        {
            PauseOutcome::Cancelled => return Ok(ToolOutcome::Cancelled),
            PauseOutcome::Resolved(decision) => decision,
        }
    };

    let (behavior, note) = parse_diff_decision(&decision);
    let mut decision_obj = serde_json::json!({ "behavior": behavior });
    if let Some(n) = &note {
        decision_obj["note"] = serde_json::json!(n);
    }
    emit(AgentEvent::DiffResolved {
        run_id: ctx.id.to_string(),
        proposal_id: proposal.id.clone(),
        decision: decision_obj.clone(),
        ts: now_ms(),
    })?;

    if behavior == "apply" {
        match apply_write(root, &proposal) {
            Ok(result) => {
                let mut tool_result = result;
                // Save checkpoint for rollback. Serialize through
                // CheckpointEntry so the saved shape always matches what
                // agent_list_checkpoints deserializes.
                let checkpoint_dir = ctx.runs_dir.join(ctx.id).join("checkpoints");
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
                let timeout_secs = ctx
                    .request
                    .command_timeout_secs
                    .unwrap_or(180)
                    .clamp(1, 1800);
                run_test_after_edit(
                    root,
                    ctx.request.test_after_edit_command.as_deref(),
                    timeout_secs,
                    &mut tool_result,
                )
                .await;
                emit(AgentEvent::FileChanged {
                    run_id: ctx.id.to_string(),
                    path: proposal.path.clone(),
                    old_hash: proposal.old_hash.clone(),
                    new_hash: proposal.new_hash.clone(),
                    ts: now_ms(),
                })?;
                Ok(ToolOutcome::Produced(tool_result))
            }
            Err(result) => Ok(ToolOutcome::Produced(result)),
        }
    } else {
        // Remember this rejection so a byte-identical re-proposal is
        // auto-declined above instead of prompting again. (A revised edit
        // addressing the feedback hashes differently, so it prompts normally.)
        with_run_handle(ctx.sup, ctx.id, |h| {
            h.rejected_edits.lock().unwrap().insert(edit_key.clone());
        });
        let verb = if proposal.is_create { "created" } else { "changed" };
        let content = match note {
            // Review feedback turns the rejection into steering: tell the
            // model to revise toward the note instead of abandoning course.
            Some(note) => format!(
                "The user reviewed this change to {} and rejected it with feedback:\n\
{note}\n\n\
The file was not {verb}. Revise the change to address the feedback (or ask \
the user if it's unclear) — do not re-propose the same edit unchanged.",
                proposal.path
            ),
            None => format!(
                "Rejected by user: {} was not {verb}. Do not propose this exact change again — \
take a different approach or ask the user what they'd prefer.",
                proposal.path
            ),
        };
        Ok(ToolOutcome::Produced(ToolResult {
            ok: false,
            content,
            metadata: None,
        }))
    }
}

#[tauri::command]
pub async fn agent_start_run(
    app: tauri::AppHandle,
    state: tauri::State<'_, AgentSupervisorState>,
    mut request: StartRunRequest,
    on_event: Channel<AgentEvent>,
) -> Result<StartRunResponse, String> {
    if let Some(root) = request.workspace_root.as_deref() {
        for command in command_allowlist::list(root)? {
            if !request.command_allowlist.iter().any(|c| c == &command) {
                request.command_allowlist.push(command);
            }
        }
    }

    let runs_dir = app_runs_dir(&app)?;
    // Reuse the client's conversation id when supplied so the transcript on
    // disk shares the AI panel's id (deduped against the in-memory convo in
    // Mission Control); otherwise mint a fresh one.
    let id = request
        .run_id
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(run_id);
    // The id names the transcript file — refuse anything path-shaped.
    validate_run_id(&id)?;
    let cancel = CancellationToken::new();

    // Crash-loop quarantine: a conversation whose recent runs all errored on
    // this provider/model is refused re-dispatch while the cooldown holds, so
    // a broken setup can't be hammered in a tight loop (human or orchestrated).
    if let Some(reason) =
        state
            .failure_budget
            .check(&id, &request.provider, &request.model, now_ms())
    {
        return Err(reason);
    }

    // One live run per conversation id. The handle stays in the map with a
    // terminal status after a run finishes, so reusing the id for a NEW run is
    // fine — but starting one while the previous is still active would spawn a
    // second loop appending to the same transcript (interleaved/duplicated seq
    // numbers, the "dropped after compacting" corruption). Check + insert under
    // one lock so the guard is atomic.
    {
        let mut runs = state
            .runs
            .lock()
            .map_err(|_| "Agent state is unavailable".to_string())?;
        if let Some(existing) = runs.get(&id) {
            if matches!(
                existing.status,
                AgentRunStatus::Queued
                    | AgentRunStatus::Running
                    | AgentRunStatus::WaitingForPermission
                    | AgentRunStatus::WaitingForDiff
                    | AgentRunStatus::Paused
            ) {
                return Err(format!(
                    "A run is already active for this conversation ({id}). Wait for it to finish or stop it first."
                ));
            }
        }
        runs.insert(
            id.clone(),
            AgentRunHandle {
                status: AgentRunStatus::Running,
                cancel: cancel.clone(),
                pending_diff: std::sync::Mutex::new(None),
                pending_question: std::sync::Mutex::new(None),
                pending_permission: std::sync::Mutex::new(None),
                approved_commands: std::sync::Mutex::new(std::collections::HashSet::new()),
                rejected_edits: std::sync::Mutex::new(std::collections::HashSet::new()),
                rejected_commands: std::sync::Mutex::new(std::collections::HashSet::new()),
                approved_network: std::sync::Mutex::new(std::collections::HashSet::new()),
                rejected_network: std::sync::Mutex::new(std::collections::HashSet::new()),
            },
        );
    }

    // Detach the loop so this command returns the run id immediately; the UI
    // follows progress through the event channel and can abort via the token.
    let supervisor: Arc<dyn RunSupervisor> = Arc::new(TauriSupervisor::new(app.clone()));
    let task_id = id.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = run_agent_loop(
            supervisor,
            runs_dir,
            task_id.clone(),
            request,
            on_event,
            cancel,
            RealProviderCaller,
        )
        .await
        {
            eprintln!("agent run {task_id} failed: {err}");
        }
    });

    Ok(StartRunResponse { run_id: id })
}

async fn run_agent_loop(
    supervisor: Arc<dyn RunSupervisor>,
    runs_dir: PathBuf,
    id: String,
    request: StartRunRequest,
    on_event: Channel<AgentEvent>,
    cancel: CancellationToken,
    provider_caller: impl AgentProviderCaller,
) -> Result<(), String> {
    // The loop touches run-scoped state only through this seam — no direct
    // AppHandle reach. Production passes a TauriSupervisor; tests pass a fake.
    let sup: &dyn RunSupervisor = supervisor.as_ref();
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
        // Broadcast before advancing seq so the global reattach stream carries
        // the same index the transcript just wrote. append-then-broadcast means
        // any seq a listener sees is already durable on disk.
        sup.broadcast(&id, seq, &event);
        seq += 1;
        let _ = on_event.send(event);
        Ok(())
    };

    let mut summary = AgentRunSummary {
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
        last_event: None,
        worktree: None,
        validation: None,
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
    let mut messages = provider_messages(&request, system, &id);
    // When this run id was used before, the on-disk transcript holds the
    // whole prior conversation. Replay it into `messages` between the
    // system prompt and the new user turn, so the model sees the same
    // context the user does on screen. Without this, every follow-up
    // turn would arrive as a fresh chat — the "agent has no memory"
    // bug the user kept hitting.
    if resuming {
        // See ProviderCaps::structured_replay: Ollama's native `/api/chat` is
        // the lone provider that needs the text-fold workaround; every
        // OpenAI-wire provider gets the faithful structured replay.
        let structured_replay = ProviderCaps::for_provider(&request.provider).structured_replay;
        let prior = reconstruct_prior_messages(&prior_events, structured_replay);
        // `provider_messages` always returns `[..., user]` with the new
        // turn at the tail. Pop it, splice the history in, push it back.
        if let Some(new_user) = messages.pop() {
            messages.extend(prior);
            messages.push(new_user);
        }
    }
    let tools = schemas_for_mode(
        &request.mode,
        &request.disabled_tools,
        request.workspace_root.as_deref(),
    );
    // Count this turn's user message on top of the turns already on disk so
    // the Mission Control "Messages" tally reflects the whole conversation.
    let mut message_count = prior_turns as u32 + 1;
    let mut completed = false;
    // omp budgets a run by output tokens, not a tiny turn cap; 8 turns was
    // genuinely limiting for real multi-file work. 16 gives the agent room to
    // read → plan → edit → verify across several files before it has to hand
    // back to the user (who can always continue the conversation).
    // Turn cap is a runaway-loop guard, not a task-size limit. Default is
    // generous; the user can raise it (Settings → Harness) for big multi-file
    // or multi-agent work. Clamped to a hard ceiling so a stuck loop can't burn
    // tokens forever. The conversation can always be continued past the cap.
    const DEFAULT_MAX_TURNS: usize = 50;
    let max_turns = request
        .max_turns
        .unwrap_or(DEFAULT_MAX_TURNS)
        .clamp(1, 1000);
    // Compaction is token-budget driven, not message-count driven: resolve the
    // model's context window once (explicit `num_ctx` override, else the
    // provider's advertised per-model window — OpenRouter — else a per-family
    // fallback) and only trim once the prompt actually crowds it.
    let context_window = match request.num_ctx {
        Some(n) => n,
        None => crate::models::resolve_context_window(&request.provider, &request.model).await,
    };
    let compact_threshold =
        compaction_threshold(context_window, request.num_predict.unwrap_or(4096));

    for turn in 0..max_turns {
        // Auto-compaction: trim verbose tool results from older turns once the
        // prompt approaches the context window. The recency window inside
        // `compact_old_tool_results` keeps the active working set verbatim.
        if estimate_prompt_tokens(&messages) > compact_threshold {
            compact_old_tool_results(&mut messages);
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
            let todo_text = todo::list_todos_text(cwd, &id);
            refresh_todo_context(&mut messages, todo_text.as_deref());
        }

        // Race the provider stream against user cancellation so abort takes
        // effect mid-request, not only between turns.
        let provider_result = tokio::select! {
            _ = cancel.cancelled() => {
                finish_cancelled(&mut emit, sup, &runs_dir, &id, &summary, message_count)?;
                return Ok(());
            }
            result = provider_caller.call(ProviderTurnRequest {
                provider: request.provider.clone(),
                model: request.model.clone(),
                messages: messages.clone(),
                tools: tools.clone(),
                workspace_root: request.workspace_root.clone(),
                num_ctx: request.num_ctx,
                num_predict: request.num_predict,
                reflection_level: request.reflection_level.clone(),
                stream,
            }) => result,
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
                settle_run(
                    sup,
                    &runs_dir,
                    &id,
                    &summary,
                    message_count,
                    AgentRunStatus::Error,
                )?;
                completed = true;
                break;
            }
        };

        // Interpret the turn purely: normalize/recover tool calls, stamp ids,
        // and assemble the content blocks. The loop stays responsible for the
        // side effects (push to `messages`, emit events, settle the run).
        let TurnStep {
            assistant_message,
            decision,
        } = decide_turn(&response, prior_turns, turn);
        messages.push(assistant_message);
        message_count += 1;

        // Resolve this turn's usage once, then fold it into the run totals so
        // Mission Control can show a running token + cost tally. The same
        // value is attached to the assistant_message event below.
        let turn_usage = agent_usage_from(response.usage.clone(), &summary.model);
        if let Some(u) = &turn_usage {
            summary.input_tokens = summary
                .input_tokens
                .saturating_add(u.prompt_tokens.unwrap_or(0) as i64);
            summary.output_tokens = summary
                .output_tokens
                .saturating_add(u.completion_tokens.unwrap_or(0) as i64);
            if let Some(c) = u.cost_usd {
                summary.cost_usd = Some(summary.cost_usd.unwrap_or(0.0) + c);
            }
        }

        let tool_calls = match decision {
            TurnDecision::Final { content } => {
                emit(AgentEvent::AssistantMessage {
                    run_id: id.clone(),
                    message_id: assistant_id,
                    content,
                    usage: turn_usage,
                    ts: now_ms(),
                })?;
                emit(AgentEvent::RunResult {
                    run_id: id.clone(),
                    result: serde_json::json!({ "status": "done" }),
                    ts: now_ms(),
                })?;
                settle_run(
                    sup,
                    &runs_dir,
                    &id,
                    &summary,
                    message_count,
                    AgentRunStatus::Done,
                )?;
                completed = true;
                break;
            }
            TurnDecision::Continue {
                content,
                tool_calls,
            } => {
                emit(AgentEvent::AssistantMessage {
                    run_id: id.clone(),
                    message_id: assistant_id,
                    content,
                    usage: turn_usage,
                    ts: now_ms(),
                })?;
                tool_calls
            }
        };

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
                let read_calls =
                    parallel_read_calls(&tool_calls, Some(root), max_parallel, |call, root| {
                        find_tool_kind_for_workspace(&call.name, root)
                    });
                if !read_calls.is_empty() {
                    precomputed =
                        run_read_tools_parallel(root, read_calls, max_parallel, &id).await;
                }
            }
        }

        for call in tool_calls {
            if cancel.is_cancelled() {
                finish_cancelled(&mut emit, sup, &runs_dir, &id, &summary, message_count)?;
                return Ok(());
            }
            let kind = find_tool_kind_for_workspace(&call.name, request.workspace_root.as_deref());
            emit(AgentEvent::ToolCallStarted {
                run_id: id.clone(),
                tool_call_id: call.id.clone(),
                name: call.name.clone(),
                input: call.input.clone(),
                summary: tool_summary_for_workspace(&call, request.workspace_root.as_deref()),
                ts: now_ms(),
            })?;

            let tool_result: ToolResult;

            let kind = match plan_tool_step(&request.mode, &call, kind) {
                ToolStepPlan::Execute { kind } => kind,
                ToolStepPlan::Blocked { result } => {
                    emit(AgentEvent::ToolCallFinished {
                        run_id: id.clone(),
                        tool_call_id: call.id.clone(),
                        result: result.clone(),
                        ts: now_ms(),
                    })?;
                    messages.push(tool_provider_message(&call, &result));
                    continue;
                }
            };

            let ctx = ToolCtx {
                sup,
                id: id.as_str(),
                request: &request,
                cancel: &cancel,
                runs_dir: runs_dir.as_path(),
            };

            let outcome = match kind {
                Some(ToolKind::Pause) if call.name == "spawn_subagent" => {
                    process_subagent_tool(&ctx, &call, &mut emit).await?
                }
                Some(ToolKind::Pause) if call.name == "consult_advisor" => {
                    process_advisor_tool(&ctx, &call, &mut emit).await?
                }
                Some(ToolKind::Pause) => process_pause_tool(&ctx, &call, &mut emit).await?,
                Some(ToolKind::Command) => process_command_tool(&ctx, &call, &mut emit).await?,
                Some(ToolKind::Network) => process_network_tool(&ctx, &call, &mut emit).await?,
                Some(ToolKind::Write) => process_write_tool(&ctx, &call, &mut emit).await?,
                // Read-only tools: serve the concurrently-computed result when
                // present (cap > 1); otherwise execute inline (sequential
                // default, or a write tool that slipped the filter — it can't,
                // but be safe).
                _ => ToolOutcome::Produced(match request.workspace_root.as_deref() {
                    Some(root) => precomputed
                        .remove(&call.id)
                        .unwrap_or_else(|| execute_read_only_tool(root, &call, &id)),
                    None => no_workspace_result(),
                }),
            };
            match outcome {
                ToolOutcome::Produced(result) => tool_result = result,
                ToolOutcome::Cancelled => {
                    finish_cancelled(&mut emit, sup, &runs_dir, &id, &summary, message_count)?;
                    return Ok(());
                }
            }

            emit(AgentEvent::ToolCallFinished {
                run_id: id.clone(),
                tool_call_id: call.id.clone(),
                result: tool_result.clone(),
                ts: now_ms(),
            })?;
            messages.push(tool_provider_message(&call, &tool_result));

            apply_clean_context_if_requested(&call, &mut messages);
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
                    "I reached the tool-turn limit ({max_turns}) before finishing this request. \
                     The work above is where I got to — send another message to have me continue from here, \
                     or raise \"Max tool turns\" in Settings → Harness for big tasks."
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
        settle_run(
            sup,
            &runs_dir,
            &id,
            &summary,
            message_count,
            AgentRunStatus::Error,
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
    state: tauri::State<'_, AgentSupervisorState>,
    decision: PermissionDecisionRequest,
) -> Result<(), String> {
    let runs = state
        .runs
        .lock()
        .map_err(|_| "Agent state is unavailable".to_string())?;
    match runs.get(&decision.run_id) {
        Some(handle) => {
            let sender = handle.pending_permission.lock().unwrap().take();
            if let Some(tx) = sender {
                // Forward the full decision JSON; the run loop parses it back
                // to read the behavior (allow/deny) and future scope.
                let _ = tx.send(decision.decision.to_string());
                Ok(())
            } else {
                Err("No pending permission request for this run.".to_string())
            }
        }
        None => Err(format!("No known run with id {}", decision.run_id)),
    }
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
                // Forward the full decision JSON; the write tool parses the
                // behavior back out plus the optional review `note` — the
                // user's line of feedback that turns a bare rejection into a
                // steerable "request changes".
                let _ = tx.send(decision.decision.to_string());
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

/// Live status of a run in the supervisor map, or `None` if no run with this id
/// is currently tracked (never started this session, or already settled and
/// evicted). The frontend calls this on panel mount: an *active* status
/// (running / waiting / queued / paused) means the run is still going in Rust,
/// so the panel reattaches to the `agent-run:{id}` stream instead of showing a
/// frozen transcript snapshot.
#[tauri::command]
pub fn agent_run_status(
    state: tauri::State<'_, AgentSupervisorState>,
    run_id: String,
) -> Option<String> {
    let runs = state.runs.lock().ok()?;
    runs.get(&run_id)
        .map(|h| run_status_wire(&h.status).to_string())
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
    validate_run_id(&run_id)?;
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
    let live_statuses = state
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
        .map(|(id, handle)| (id.clone(), handle.status.clone()))
        .collect::<HashMap<_, _>>();
    let mut summaries = list_summaries(&runs_dir, limit, offset)?;
    for summary in &mut summaries {
        if let Some(status) = live_statuses.get(&summary.id) {
            summary.status = run_status_wire(status).to_string();
        }
        if matches!(
            summary.status.as_str(),
            "running"
                | "queued"
                | "waiting"
                | "waiting_for_permission"
                | "waiting_for_diff"
                | "paused"
        ) && !live_statuses.contains_key(&summary.id)
        {
            summary.status = "cancelled".to_string();
        }
        // Evidence parity with the delegate board: surface the linked git
        // worktree a Klide run executed in (when its cwd is one). Derived, not
        // persisted, so historical runs pick it up too. See `worktree_label`.
        if summary.worktree.is_none() {
            if let Some(cwd) = summary.cwd.as_deref() {
                summary.worktree = crate::delegate::worktree_label(cwd);
            }
        }
    }
    Ok(summaries)
}

#[tauri::command]
pub async fn agent_read_run(
    app: tauri::AppHandle,
    run_id: String,
) -> Result<Vec<AgentEvent>, String> {
    validate_run_id(&run_id)?;
    let runs_dir = app_runs_dir(&app)?;
    read_events(&runs_dir, &run_id)
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceExport {
    pub markdown: String,
    /// Workspace-relative path of the written packet, when a workspace was
    /// given. `None` for markdown-only exports.
    pub rel_path: Option<String>,
    pub abs_path: Option<String>,
}

/// Fold a run's summary + transcript into a Markdown evidence packet and,
/// when a workspace is given, write it to `<workspace>/.klide/evidence/`.
/// Klide-native runs only — delegate CLI transcripts live outside `runs/`.
#[tauri::command]
pub async fn agent_export_evidence(
    app: tauri::AppHandle,
    run_id: String,
    workspace_root: Option<String>,
) -> Result<EvidenceExport, String> {
    validate_run_id(&run_id)?;
    let runs_dir = app_runs_dir(&app)?;
    let summary = transcripts::read_summary(&runs_dir, &run_id)?;
    let events = read_events(&runs_dir, &run_id)?;
    let markdown = evidence::render_evidence_markdown(&summary, &events);
    let mut rel_path = None;
    let mut abs_path = None;
    if let Some(root) = workspace_root.as_deref().filter(|r| !r.trim().is_empty()) {
        let dir = Path::new(root).join(".klide").join("evidence");
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Unable to create .klide/evidence directory: {e}"))?;
        let name = format!("{}.md", sanitize_file_id(&run_id));
        let file = dir.join(&name);
        std::fs::write(&file, &markdown)
            .map_err(|e| format!("Unable to write evidence file: {e}"))?;
        rel_path = Some(format!(".klide/evidence/{name}"));
        abs_path = Some(file.to_string_lossy().to_string());
    }
    Ok(EvidenceExport {
        markdown,
        rel_path,
        abs_path,
    })
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RevertCheckpointsResult {
    reverted: usize,
}

pub(crate) fn revert_all_checkpoints_at(
    runs_dir: &Path,
    run_id: &str,
) -> Result<RevertCheckpointsResult, String> {
    let entries = list_checkpoints_at(runs_dir, run_id)?;
    let mut reverted = 0usize;
    for entry in entries {
        revert_checkpoint_at(runs_dir, run_id, &entry.tool_call_id)?;
        reverted += 1;
    }
    Ok(RevertCheckpointsResult { reverted })
}

#[tauri::command]
pub async fn agent_list_checkpoints(
    app: tauri::AppHandle,
    run_id: String,
) -> Result<Vec<CheckpointEntry>, String> {
    validate_run_id(&run_id)?;
    let runs_dir = app_runs_dir(&app)?;
    list_checkpoints_at(&runs_dir, &run_id)
}

#[tauri::command]
pub async fn agent_revert_checkpoint(
    app: tauri::AppHandle,
    run_id: String,
    tool_call_id: String,
) -> Result<(), String> {
    validate_run_id(&run_id)?;
    let runs_dir = app_runs_dir(&app)?;
    revert_checkpoint_at(&runs_dir, &run_id, &tool_call_id)
}

#[tauri::command]
pub async fn agent_revert_run_checkpoints(
    app: tauri::AppHandle,
    run_id: String,
) -> Result<RevertCheckpointsResult, String> {
    validate_run_id(&run_id)?;
    let runs_dir = app_runs_dir(&app)?;
    revert_all_checkpoints_at(&runs_dir, &run_id)
}

#[cfg(test)]
mod replay_tests {
    //! The "agent has memory" fix lives in `reconstruct_prior_messages`:
    //! given a transcript, it has to produce provider-shaped messages that
    //! replay the user / assistant / tool turns in order. These tests
    //! pin the wire format and the edge cases (no events, no content
    //! blocks, malformed tool calls).

    use super::*;
    use crate::agent::types::{AgentContentBlock, AgentMode};

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
        assert!(reconstruct_prior_messages(&[], false).is_empty());
    }

    #[test]
    fn user_message_becomes_user_role() {
        let out = reconstruct_prior_messages(&[user_msg("hello")], false);
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
        let out = reconstruct_prior_messages(
            &[
                user_msg("old turn 1"),
                assistant_text("old reply 1"),
                compacted,
                user_msg("recent question"),
                assistant_text("recent answer"),
            ],
            false,
        );
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
        let out = reconstruct_prior_messages(&[assistant_text("hi back")], false);
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
        let out = reconstruct_prior_messages(&[assistant_with_tool_call()], false);
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
        let out = reconstruct_prior_messages(
            &[
                assistant_text("let me check"),
                tool_result("tc1", "file contents"),
                assistant_text("done"),
            ],
            false,
        );
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
        let out = reconstruct_prior_messages(&events, false);
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
        let out =
            reconstruct_prior_messages(&[user_msg("ping"), tool_result("tc1", "pong")], false);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["role"], "user");
    }

    #[test]
    fn tool_results_do_not_carry_across_user_turns() {
        // A buffered tool result from a previous turn must not leak
        // into the next user turn — the model shouldn't see a
        // tool result on the wrong side of a user message.
        let out = reconstruct_prior_messages(
            &[
                user_msg("first turn"),
                tool_result("tc1", "stale result"),
                user_msg("second turn"),
                assistant_text("second answer"),
            ],
            false,
        );
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
        let out = reconstruct_prior_messages(&events, false);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["role"], "user");
    }

    #[test]
    fn provider_caps_isolate_the_quirks() {
        // Native Ollama is the only provider on the text-fold path.
        let ollama = ProviderCaps::for_provider("ollama");
        assert!(!ollama.structured_replay);
        assert!(ollama.minimal_chat_context);

        // MLX is local (minimal chat) but OpenAI-wire (structured replay).
        let mlx = ProviderCaps::for_provider("mlx");
        assert!(mlx.structured_replay);
        assert!(mlx.minimal_chat_context);

        // Hosted + custom providers: structured replay, full chat context.
        for id in ["anthropic", "openai", "my-self-hosted-endpoint"] {
            let caps = ProviderCaps::for_provider(id);
            assert!(caps.structured_replay, "{id}");
            assert!(!caps.minimal_chat_context, "{id}");
        }
    }

    // --- Structured replay (OpenAI-wire / custom self-hosted providers) ---
    //
    // The opposite contract from the text-fold tests above: prior tool
    // calls replay as a structured `assistant.tool_calls` array followed
    // by `role: "tool"` results — never folded into text. This is the path
    // that stops devstral & co. from imitating fake `[tool_result]` blocks.

    #[test]
    fn structured_replay_emits_tool_calls_and_tool_role() {
        let out = reconstruct_prior_messages(
            &[
                user_msg("read the readme"),
                assistant_with_tool_call(),
                tool_result("tc1", "hello world"),
                assistant_text("the readme says hi"),
            ],
            true,
        );
        // user + assistant(tool_calls) + tool + assistant(final) = 4.
        assert_eq!(out.len(), 4, "got: {out:?}");
        assert_eq!(out[0]["role"], "user");

        // The calling assistant turn carries a structured tool_calls array,
        // NOT a folded [tool_result] text block.
        assert_eq!(out[1]["role"], "assistant");
        assert_eq!(out[1]["content"], "let me read that");
        let calls = out[1]["tool_calls"].as_array().expect("tool_calls array");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["id"], "tc1");
        assert_eq!(calls[0]["function"]["name"], "read_file");
        // arguments is a JSON-encoded string, matching the live loop's wire.
        assert_eq!(
            calls[0]["function"]["arguments"]
                .as_str()
                .expect("arguments is a string"),
            "{\"path\":\"README.md\"}"
        );

        // The result comes back as a paired role:"tool" message.
        assert_eq!(out[2]["role"], "tool");
        assert_eq!(out[2]["tool_call_id"], "tc1");
        assert_eq!(out[2]["name"], "read_file");
        assert_eq!(out[2]["content"], "hello world");

        assert_eq!(out[3]["role"], "assistant");
        assert_eq!(out[3]["content"], "the readme says hi");

        // No [tool_result] text leaks into any message.
        for m in &out {
            if let Some(c) = m["content"].as_str() {
                assert!(!c.contains("[tool_result]"), "text-fold leaked: {c}");
            }
        }
    }

    #[test]
    fn structured_replay_drops_orphan_tool_calls() {
        // A turn that called a tool but never got a result (e.g. cancelled
        // mid-call) must not replay an unanswered assistant.tool_calls —
        // OpenAI-compatible APIs reject that. The call is dropped.
        let out = reconstruct_prior_messages(&[user_msg("go"), assistant_with_tool_call()], true);
        assert_eq!(out.len(), 2);
        assert_eq!(out[1]["role"], "assistant");
        assert_eq!(out[1]["content"], "let me read that");
        assert!(
            out[1].get("tool_calls").is_none(),
            "orphan tool_call was not dropped: {:?}",
            out[1]
        );
    }

    #[test]
    fn structured_replay_preserves_compaction() {
        let out = reconstruct_prior_messages(
            &[
                user_msg("old"),
                assistant_text("old reply"),
                AgentEvent::ContextCompacted {
                    run_id: "r".into(),
                    summary: "did the thing".into(),
                    ts: 9,
                },
                user_msg("new"),
                assistant_text("new reply"),
            ],
            true,
        );
        assert_eq!(out.len(), 3, "got: {out:?}");
        assert_eq!(out[0]["role"], "system");
        assert!(out[0]["content"]
            .as_str()
            .expect("summary string")
            .contains("did the thing"));
        assert_eq!(out[1]["content"], "new");
        assert_eq!(out[2]["content"], "new reply");
    }
}

#[cfg(test)]
mod turn_decision_tests {
    //! `decide_turn` is the pure heart of the run loop: provider response in,
    //! a Final-or-Continue decision out, with no Tauri/channel/fs dependency.
    //! These pin the branches the loop used to do inline — terminal vs tool
    //! turn, thinking promotion, the truncation notice, text-embedded tool-call
    //! recovery, and id stamping — plus the bounded auto-compaction pass.

    use super::*;

    fn response(
        content: &str,
        thinking: Option<&str>,
        tool_calls: Vec<serde_json::Value>,
    ) -> AiChatResponse {
        AiChatResponse {
            content: content.to_string(),
            thinking: thinking.map(String::from),
            tool_calls,
            usage: None,
            stop_reason: None,
        }
    }

    fn structured_call(name: &str, args: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "function": { "name": name, "arguments": args } })
    }

    #[test]
    fn tool_free_response_is_final_with_the_answer() {
        let step = decide_turn(&response("All done.", None, vec![]), 0, 0);
        match step.decision {
            TurnDecision::Final { content } => {
                assert_eq!(content.len(), 1);
                assert!(
                    matches!(&content[0], AgentContentBlock::Text { text } if text == "All done.")
                );
            }
            _ => panic!("expected Final"),
        }
        // No tool calls → the wire message carries no tool_calls field.
        assert_eq!(step.assistant_message["content"], "All done.");
        assert!(step.assistant_message.get("tool_calls").is_none());
    }

    #[test]
    fn empty_content_promotes_thinking_to_the_answer() {
        // LFM2.5 routes the whole answer into the reasoning channel. The final
        // text should be the thinking, with NO separate Thinking block.
        let step = decide_turn(&response("", Some("The answer is 42."), vec![]), 0, 0);
        match step.decision {
            TurnDecision::Final { content } => {
                assert_eq!(content.len(), 1);
                assert!(
                    matches!(&content[0], AgentContentBlock::Text { text } if text == "The answer is 42.")
                );
            }
            _ => panic!("expected Final"),
        }
    }

    #[test]
    fn thinking_is_preserved_as_its_own_block_when_content_is_present() {
        let step = decide_turn(&response("Here.", Some("reasoning"), vec![]), 0, 0);
        match step.decision {
            TurnDecision::Final { content } => {
                assert_eq!(content.len(), 2);
                assert!(
                    matches!(&content[0], AgentContentBlock::Thinking { text } if text == "reasoning")
                );
                assert!(matches!(&content[1], AgentContentBlock::Text { text } if text == "Here."));
            }
            _ => panic!("expected Final"),
        }
    }

    #[test]
    fn length_stop_reason_appends_the_truncation_notice() {
        let mut resp = response("partial answer", None, vec![]);
        resp.stop_reason = Some("length".to_string());
        let step = decide_turn(&resp, 0, 0);
        match step.decision {
            TurnDecision::Final { content } => match &content[0] {
                AgentContentBlock::Text { text } => {
                    assert!(text.starts_with("partial answer"));
                    assert!(text.contains("Response cut off"));
                }
                _ => panic!("expected Text"),
            },
            _ => panic!("expected Final"),
        }
    }

    #[test]
    fn structured_tool_call_continues_with_a_toolcall_block() {
        let resp = response(
            "",
            None,
            vec![structured_call(
                "read_file",
                serde_json::json!({ "path": "a.rs" }),
            )],
        );
        let step = decide_turn(&resp, 0, 0);
        match step.decision {
            TurnDecision::Continue {
                content,
                tool_calls,
            } => {
                assert_eq!(tool_calls.len(), 1);
                assert_eq!(tool_calls[0].name, "read_file");
                assert!(content.iter().any(
                    |b| matches!(b, AgentContentBlock::ToolCall { name, .. } if name == "read_file")
                ));
            }
            _ => panic!("expected Continue"),
        }
        // The wire message replays the structured call back to the model.
        assert!(step.assistant_message["tool_calls"].is_array());
    }

    #[test]
    fn fallback_tool_ids_are_stamped_with_the_run_turn() {
        // A provider that returns no id falls back to "tool_<idx>"; the loop
        // stamps it with prior_turns + turn so ids stay unique across the run.
        let resp = response(
            "",
            None,
            vec![serde_json::json!({ "function": { "name": "grep", "arguments": {} } })],
        );
        let step = decide_turn(&resp, 3, 2);
        match step.decision {
            TurnDecision::Continue { tool_calls, .. } => {
                assert_eq!(tool_calls[0].id, "turn5_tool_0");
            }
            _ => panic!("expected Continue"),
        }
    }

    #[test]
    fn text_embedded_tool_call_is_recovered_into_continue() {
        // Local models that narrate a call as text instead of the structured
        // field still get routed to Continue, and the raw tokens are stripped.
        let content = "Let me read it. <|tool_call_start|>[{\"name\":\"read_file\",\"arguments\":{\"path\":\"x.md\"}}]<|tool_call_end|>";
        let step = decide_turn(&response(content, None, vec![]), 0, 0);
        match step.decision {
            TurnDecision::Continue {
                tool_calls,
                content,
            } => {
                assert_eq!(tool_calls.len(), 1);
                assert_eq!(tool_calls[0].name, "read_file");
                // The cleaned text keeps the prose, drops the special tokens.
                let has_clean_text = content.iter().any(|b| matches!(b, AgentContentBlock::Text { text } if text.contains("Let me read it.") && !text.contains("tool_call_start")));
                assert!(has_clean_text);
            }
            _ => panic!("expected Continue"),
        }
    }

    fn tool_msg(name: &str, content: &str) -> serde_json::Value {
        serde_json::json!({ "role": "tool", "name": name, "content": content })
    }

    #[test]
    fn compaction_rewrites_old_tool_results_and_keeps_the_system_prompt() {
        let long = "x".repeat(2_000);
        // One result past the recency window, so exactly the oldest is eligible.
        let mut messages =
            vec![serde_json::json!({ "role": "system", "content": "x".repeat(300) })];
        for _ in 0..(KEEP_RECENT_TOOL_RESULTS + 1) {
            messages.push(tool_msg("read_file", &long));
        }
        compact_old_tool_results(&mut messages);
        // System prompt untouched even though it is long.
        assert_eq!(messages[0]["content"].as_str().unwrap().len(), 300);
        // The single oldest result collapsed with an excerpt; its name dropped.
        assert!(messages[1]["content"]
            .as_str()
            .unwrap()
            .starts_with("[compacted: read_file; original"));
        assert!(messages[1].get("name").is_none());
        // Everything inside the recency window survives verbatim.
        assert_eq!(
            messages.last().unwrap()["content"].as_str().unwrap().len(),
            2_000
        );
    }

    #[test]
    fn compaction_preserves_the_recent_working_set() {
        let long = "x".repeat(2_000);
        // Exactly the window's worth of reads — nothing is old enough to gut.
        let mut messages = vec![serde_json::json!({ "role": "system", "content": "sys" })];
        for _ in 0..KEEP_RECENT_TOOL_RESULTS {
            messages.push(tool_msg("read_file", &long));
        }
        compact_old_tool_results(&mut messages);
        let compacted = messages
            .iter()
            .filter(|m| {
                m["content"]
                    .as_str()
                    .map(|s| s.starts_with("[compacted: read_file; original"))
                    .unwrap_or(false)
            })
            .count();
        assert_eq!(
            compacted, 0,
            "recent reads must stay verbatim for synthesis"
        );
    }

    #[test]
    fn token_estimate_scales_with_content_and_threshold_reserves_headroom() {
        let small = vec![serde_json::json!({ "role": "user", "content": "hi" })];
        let big = vec![tool_msg("read_file", &"x".repeat(40_000))];
        assert!(estimate_prompt_tokens(&big) > estimate_prompt_tokens(&small));
        // ~40k chars ≈ 10k tokens by the /4 heuristic.
        assert!((9_000..=11_000).contains(&estimate_prompt_tokens(&big)));

        // 8k window, 2k reply reserve, 1k schema reserve (window/8) → 5k prompt.
        assert_eq!(compaction_threshold(8_192, 2_048), 8_192 - 2_048 - 1_024);
        // Pathological tiny window never yields a zero threshold.
        assert_eq!(compaction_threshold(0, 4_096), 1);
    }

    #[test]
    fn compaction_holds_off_until_the_prompt_crowds_the_window() {
        // A handful of large reads that fit a roomy window: no compaction yet.
        let long = "x".repeat(2_000);
        let mut messages = vec![serde_json::json!({ "role": "system", "content": "sys" })];
        for _ in 0..6 {
            messages.push(tool_msg("read_file", &long));
        }
        let window = 200_000;
        if estimate_prompt_tokens(&messages) > compaction_threshold(window, 4_096) {
            compact_old_tool_results(&mut messages);
        }
        assert!(
            messages.iter().all(|m| !m["content"]
                .as_str()
                .map(|s| s.starts_with("[compacted: read_file; original"))
                .unwrap_or(false)),
            "a small prompt under a large window must not be compacted"
        );
    }

    #[test]
    fn compaction_leaves_short_tool_results_alone() {
        let mut messages = vec![
            serde_json::json!({ "role": "system", "content": "sys" }),
            tool_msg("grep", "short result"),
        ];
        compact_old_tool_results(&mut messages);
        assert_eq!(messages[1]["content"], "short result");
        assert_eq!(messages[1]["name"], "grep");
    }

    #[test]
    fn compaction_never_grows_a_medium_result() {
        // A result that clears the old 200-byte bar but is smaller than the
        // summary header + excerpt would be. Compacting it would *grow* the
        // prompt, so it must be left verbatim.
        let medium = "z".repeat(500);
        let mut messages = vec![serde_json::json!({ "role": "system", "content": "sys" })];
        for _ in 0..(KEEP_RECENT_TOOL_RESULTS + 1) {
            messages.push(tool_msg("read_file", &medium));
        }
        compact_old_tool_results(&mut messages);
        assert!(
            messages
                .iter()
                .filter(|m| m["role"].as_str() == Some("tool"))
                .all(|m| m["content"].as_str() == Some(medium.as_str())),
            "medium results must stay verbatim — compaction must never grow a message"
        );
    }

    #[test]
    fn compaction_stops_after_five_rewrites_per_pass() {
        let long = "y".repeat(2_000);
        let mut messages = vec![serde_json::json!({ "role": "system", "content": "sys" })];
        // 5 + window eligible, but a single pass caps at 5 rewrites.
        for _ in 0..(KEEP_RECENT_TOOL_RESULTS + 7) {
            messages.push(tool_msg("read_file", &long));
        }
        compact_old_tool_results(&mut messages);
        let compacted = messages
            .iter()
            .filter(|m| {
                m["content"]
                    .as_str()
                    .map(|s| s.starts_with("[compacted: read_file; original"))
                    .unwrap_or(false)
            })
            .count();
        assert_eq!(compacted, 5);
    }
}

#[cfg(test)]
mod test_after_edit_tests {
    use super::*;

    fn temp_workspace(name: &str) -> String {
        let dir = std::env::temp_dir().join(format!(
            "klide-test-after-edit-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().to_string()
    }

    fn applied_result() -> ToolResult {
        ToolResult {
            ok: true,
            content: "Applied: edited a.txt.".to_string(),
            metadata: None,
        }
    }

    #[tokio::test]
    async fn test_after_edit_pass_keeps_result_ok() {
        let root = temp_workspace("pass");
        let mut result = applied_result();
        run_test_after_edit(&root, Some("echo checked"), 30, &mut result).await;
        assert!(result.ok);
        assert!(result
            .content
            .contains("Post-edit check `echo checked` passed"));
        assert!(result.content.contains("checked"));
        assert_eq!(
            result
                .metadata
                .as_ref()
                .and_then(|m| m.get("testAfterEdit"))
                .and_then(|m| m.get("ok"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn test_after_edit_failure_marks_result_not_ok() {
        let root = temp_workspace("fail");
        let mut result = applied_result();
        run_test_after_edit(&root, Some("exit 7"), 30, &mut result).await;
        assert!(!result.ok);
        assert!(result.content.contains("Post-edit check `exit 7` failed"));
        assert!(result.content.contains("exit 7"));
        assert!(result.content.contains("fix forward"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn empty_test_after_edit_command_is_noop() {
        let root = temp_workspace("empty");
        let mut result = applied_result();
        run_test_after_edit(&root, Some("   "), 30, &mut result).await;
        assert_eq!(result.content, "Applied: edited a.txt.");
        assert!(result.metadata.is_none());
        let _ = std::fs::remove_dir_all(root);
    }
}

#[cfg(test)]
mod provider_caller_tests {
    use super::*;

    #[derive(Clone, Default)]
    struct MockProviderCaller {
        seen: std::sync::Arc<std::sync::Mutex<Vec<(String, String, usize, bool)>>>,
    }

    impl AgentProviderCaller for MockProviderCaller {
        fn call<'a>(
            &'a self,
            request: ProviderTurnRequest,
        ) -> Pin<Box<dyn Future<Output = Result<AiChatResponse, String>> + Send + 'a>> {
            let seen = self.seen.clone();
            Box::pin(async move {
                seen.lock().unwrap().push((
                    request.provider,
                    request.model,
                    request.messages.len(),
                    request.tools.is_some(),
                ));
                Ok(AiChatResponse {
                    content: "synthetic provider response".to_string(),
                    thinking: None,
                    tool_calls: Vec::new(),
                    usage: None,
                    stop_reason: None,
                })
            })
        }
    }

    #[tokio::test]
    async fn provider_caller_can_be_mocked_without_ai_chat() {
        let caller = MockProviderCaller::default();
        let response = caller
            .call(ProviderTurnRequest {
                provider: "mock-provider".to_string(),
                model: "mock-model".to_string(),
                messages: vec![serde_json::json!({ "role": "user", "content": "hello" })],
                tools: Some(Vec::new()),
                workspace_root: Some("/tmp".to_string()),
                num_ctx: Some(1024),
                num_predict: Some(128),
                reflection_level: Some("low".to_string()),
                stream: Channel::<StreamChunk>::new(|_| Ok(())),
            })
            .await
            .unwrap();

        assert_eq!(response.content, "synthetic provider response");
        assert_eq!(
            caller.seen.lock().unwrap().as_slice(),
            &[(
                "mock-provider".to_string(),
                "mock-model".to_string(),
                1,
                true
            )]
        );
    }
}

/// Shared test doubles for driving the harness headlessly: the fake supervisor
/// (the seam's second adapter), a scripted provider caller (the "model" for
/// loop-level tests), and the "frontend" halves of the pause ceremonies
/// (`answer_permission` / `answer_question`).
#[cfg(test)]
mod test_support {
    use super::*;
    use std::collections::{HashMap, VecDeque};

    /// A supervisor backed by a plain map — no Tauri app. This is the second
    /// adapter that makes the seam real: the loop's run-scoped helpers can be
    /// exercised headlessly against it.
    pub(super) struct FakeSupervisor {
        pub(super) runs: Mutex<HashMap<String, AgentRunHandle>>,
    }

    impl FakeSupervisor {
        pub(super) fn with_run(id: &str) -> Self {
            let mut runs = HashMap::new();
            runs.insert(id.to_string(), make_handle());
            Self {
                runs: Mutex::new(runs),
            }
        }
    }

    impl RunSupervisor for FakeSupervisor {
        fn set_status(&self, run_id: &str, status: AgentRunStatus) {
            if let Ok(mut runs) = self.runs.lock() {
                if let Some(handle) = runs.get_mut(run_id) {
                    handle.status = status;
                }
            }
        }
        fn with_handle(&self, run_id: &str, f: &mut dyn FnMut(&AgentRunHandle)) -> bool {
            let Ok(runs) = self.runs.lock() else {
                return false;
            };
            match runs.get(run_id) {
                Some(handle) => {
                    f(handle);
                    true
                }
                None => false,
            }
        }
        fn broadcast(&self, _run_id: &str, _seq: u64, _event: &AgentEvent) {}
    }

    pub(super) fn make_handle() -> AgentRunHandle {
        AgentRunHandle {
            status: AgentRunStatus::Running,
            cancel: CancellationToken::new(),
            pending_diff: Mutex::new(None),
            pending_question: Mutex::new(None),
            pending_permission: Mutex::new(None),
            approved_commands: Mutex::new(std::collections::HashSet::new()),
            rejected_edits: Mutex::new(std::collections::HashSet::new()),
            rejected_commands: Mutex::new(std::collections::HashSet::new()),
            approved_network: Mutex::new(std::collections::HashSet::new()),
            rejected_network: Mutex::new(std::collections::HashSet::new()),
        }
    }

    /// Poll the run's stashed permission sender and answer it — stands in for
    /// the agent_resolve_permission command in a headless drive of the pause.
    pub(super) async fn answer_permission(sup: &FakeSupervisor, id: &str, reply: &str) {
        loop {
            let mut answered = false;
            sup.with_handle(id, &mut |h| {
                if let Some(tx) = h.pending_permission.lock().unwrap().take() {
                    let _ = tx.send(reply.to_string());
                    answered = true;
                }
            });
            if answered {
                return;
            }
            tokio::task::yield_now().await;
        }
    }

    /// Poll the run's stashed diff sender and answer it — stands in for the
    /// agent_resolve_diff command in a headless drive of the diff-review pause.
    pub(super) async fn answer_diff(sup: &FakeSupervisor, id: &str, reply: &str) {
        loop {
            let mut answered = false;
            sup.with_handle(id, &mut |h| {
                if let Some(tx) = h.pending_diff.lock().unwrap().take() {
                    let _ = tx.send(reply.to_string());
                    answered = true;
                }
            });
            if answered {
                return;
            }
            tokio::task::yield_now().await;
        }
    }

    /// Poll the run's stashed question sender and answer it — stands in for the
    /// agent_resolve_question command (which the frontend calls after the
    /// advisor consult / subagent finishes) in a headless drive of the pause.
    pub(super) async fn answer_question(sup: &FakeSupervisor, id: &str, reply: &str) {
        loop {
            let mut answered = false;
            sup.with_handle(id, &mut |h| {
                if let Some(tx) = h.pending_question.lock().unwrap().take() {
                    let _ = tx.send(reply.to_string());
                    answered = true;
                }
            });
            if answered {
                return;
            }
            tokio::task::yield_now().await;
        }
    }

    /// A provider caller that replays a scripted sequence of responses — the
    /// "model" for loop-level tests. Records each request's message roles so a
    /// test can assert tool results were replayed to the model. Errors when the
    /// script runs dry so a runaway loop fails fast instead of hanging.
    #[derive(Clone, Default)]
    pub(super) struct ScriptedProviderCaller {
        pub(super) script: Arc<Mutex<VecDeque<Result<AiChatResponse, String>>>>,
        pub(super) seen_roles: Arc<Mutex<Vec<Vec<String>>>>,
    }

    impl ScriptedProviderCaller {
        pub(super) fn new(turns: Vec<Result<AiChatResponse, String>>) -> Self {
            Self {
                script: Arc::new(Mutex::new(turns.into())),
                seen_roles: Arc::new(Mutex::new(Vec::new())),
            }
        }
    }

    impl AgentProviderCaller for ScriptedProviderCaller {
        fn call<'a>(
            &'a self,
            request: ProviderTurnRequest,
        ) -> Pin<Box<dyn Future<Output = Result<AiChatResponse, String>> + Send + 'a>> {
            let script = self.script.clone();
            let seen = self.seen_roles.clone();
            Box::pin(async move {
                seen.lock().unwrap().push(
                    request
                        .messages
                        .iter()
                        .map(|m| {
                            m.get("role")
                                .and_then(|r| r.as_str())
                                .unwrap_or("?")
                                .to_string()
                        })
                        .collect(),
                );
                script.lock().unwrap().pop_front().unwrap_or_else(|| {
                    Err("provider script exhausted — the loop ran more turns than scripted"
                        .to_string())
                })
            })
        }
    }

    /// One scripted assistant turn in provider wire shape. Empty `tool_calls`
    /// makes it the final answer.
    pub(super) fn scripted_turn(
        content: &str,
        tool_calls: Vec<serde_json::Value>,
    ) -> Result<AiChatResponse, String> {
        Ok(AiChatResponse {
            content: content.to_string(),
            thinking: None,
            tool_calls,
            usage: None,
            stop_reason: None,
        })
    }

    /// A structured tool call as providers emit it (`function.name` +
    /// `function.arguments`).
    pub(super) fn scripted_tool_call(
        id: &str,
        name: &str,
        input: serde_json::Value,
    ) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "function": { "name": name, "arguments": input },
        })
    }

    /// A StartRunRequest for headless tests: goal mode, auto-accept diffs, an
    /// explicit num_ctx so the loop never looks up provider model metadata.
    pub(super) fn test_request(root: &str, command_allowlist: &[&str]) -> StartRunRequest {
        serde_json::from_value(serde_json::json!({
            "workspaceRoot": root,
            "mode": "goal",
            "provider": "mock",
            "model": "mock-model",
            "initialText": "Complete the fixture task.",
            "context": null,
            "systemPrompt": null,
            "numCtx": 32768,
            "requireDiffReview": false,
            "commandAllowlist": command_allowlist,
        }))
        .unwrap()
    }
}

#[cfg(test)]
mod run_supervisor_tests {
    use super::test_support::*;
    use super::*;

    #[test]
    fn set_status_and_with_run_handle_round_trip_off_tauri() {
        let sup = FakeSupervisor::with_run("run-1");
        set_run_status(&sup, "run-1", AgentRunStatus::WaitingForDiff);
        let status = with_run_handle(&sup, "run-1", |h| h.status);
        assert_eq!(status, Some(AgentRunStatus::WaitingForDiff));
    }

    #[test]
    fn with_run_handle_returns_none_for_a_missing_run() {
        let sup = FakeSupervisor::with_run("run-1");
        assert!(with_run_handle(&sup, "ghost", |_| ()).is_none());
    }

    fn request_event() -> AgentEvent {
        AgentEvent::RunResult {
            run_id: "run-1".to_string(),
            result: serde_json::json!({ "kind": "permission" }),
            ts: 0,
        }
    }

    #[tokio::test]
    async fn pause_for_user_drives_a_full_pause_through_the_seam() {
        let sup = FakeSupervisor::with_run("run-1");
        let cancel = CancellationToken::new();
        let mut emit = |_: AgentEvent| Ok(());
        let (outcome, _) = tokio::join!(
            pause_for_user(
                &sup,
                "run-1",
                AgentRunStatus::WaitingForPermission,
                request_event(),
                "(default)",
                &cancel,
                &mut emit,
                |h: &AgentRunHandle, tx| {
                    *h.pending_permission.lock().unwrap() = Some(tx);
                },
            ),
            answer_permission(&sup, "run-1", "approved"),
        );
        assert!(matches!(outcome, Ok(PauseOutcome::Resolved(r)) if r == "approved"));
        // Status was restored to Running after the pause resolved.
        assert_eq!(
            with_run_handle(&sup, "run-1", |h| h.status),
            Some(AgentRunStatus::Running)
        );
    }

    /// The advisor strategy end-to-end through the real tool code: the executor
    /// calls `consult_advisor`, the harness folds question+context into one
    /// prompt, emits `AdvisorRequested`, parks on the shared question oneshot,
    /// and (once the "frontend" resolves it) folds the advice back into the tool
    /// result and emits `AdvisorResolved`.
    #[tokio::test]
    async fn consult_advisor_folds_context_pauses_and_returns_guidance() {
        let sup = FakeSupervisor::with_run("adv-run");
        let cancel = CancellationToken::new();
        let request: StartRunRequest = serde_json::from_value(serde_json::json!({
            "workspaceRoot": null, "mode": "goal", "provider": "mock", "model": "mock",
            "initialText": "t", "context": null, "systemPrompt": null,
        }))
        .unwrap();
        let tmp = std::env::temp_dir();
        let ctx = ToolCtx {
            sup: &sup,
            id: "adv-run",
            request: &request,
            cancel: &cancel,
            runs_dir: tmp.as_path(),
        };
        let call = NormalizedToolCall {
            id: "c1".to_string(),
            name: "consult_advisor".to_string(),
            input: serde_json::json!({
                "question": "Use a queue or a channel here?",
                "context": "tried a Mutex, it deadlocked"
            }),
        };
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::<AgentEvent>::new()));
        let sink = events.clone();
        let mut emit =
            move |e: AgentEvent| -> Result<(), String> {
                sink.lock().unwrap().push(e);
                Ok(())
            };

        let (outcome, _) = tokio::join!(
            process_advisor_tool(&ctx, &call, &mut emit),
            answer_question(&sup, "adv-run", "Use a channel; it fits the ownership model."),
        );

        // Tool result wraps the advice as guidance for the executor.
        match outcome.expect("advisor tool ok") {
            ToolOutcome::Produced(r) => {
                assert!(r.ok);
                assert!(r.content.contains("Advisor guidance:"), "got: {}", r.content);
                assert!(r.content.contains("Use a channel"), "got: {}", r.content);
            }
            _ => panic!("expected Produced outcome"),
        }

        let evs = events.lock().unwrap();
        // AdvisorRequested carries the folded prompt (question + context section).
        let question = evs
            .iter()
            .find_map(|e| match e {
                AgentEvent::AdvisorRequested { question, .. } => Some(question.clone()),
                _ => None,
            })
            .expect("AdvisorRequested emitted");
        assert!(question.contains("Use a queue or a channel here?"));
        assert!(question.contains("Context:"));
        assert!(question.contains("deadlocked"));
        // AdvisorResolved captures the advice for the transcript.
        assert!(evs.iter().any(|e| matches!(
            e,
            AgentEvent::AdvisorResolved { advice, .. } if advice.contains("Use a channel")
        )));
    }

    /// A failed consult (frontend prefixes the reply with ADVISOR_ERROR_PREFIX)
    /// must come back as a NOT-ok tool result — otherwise the executor treats an
    /// error string like "Advisor unavailable: no key" as guidance to follow.
    #[tokio::test]
    async fn consult_advisor_marks_a_failed_consult_not_ok() {
        let sup = FakeSupervisor::with_run("adv-run");
        let cancel = CancellationToken::new();
        let request: StartRunRequest = serde_json::from_value(serde_json::json!({
            "workspaceRoot": null, "mode": "goal", "provider": "mock", "model": "mock",
            "initialText": "t", "context": null, "systemPrompt": null,
        }))
        .unwrap();
        let tmp = std::env::temp_dir();
        let ctx = ToolCtx {
            sup: &sup,
            id: "adv-run",
            request: &request,
            cancel: &cancel,
            runs_dir: tmp.as_path(),
        };
        let call = NormalizedToolCall {
            id: "c1".to_string(),
            name: "consult_advisor".to_string(),
            input: serde_json::json!({ "question": "A or B?" }),
        };
        let mut emit = |_: AgentEvent| -> Result<(), String> { Ok(()) };
        let reply = format!("{ADVISOR_ERROR_PREFIX}Advisor unavailable (anthropic/claude-opus-4-8): no key");

        let (outcome, _) = tokio::join!(
            process_advisor_tool(&ctx, &call, &mut emit),
            answer_question(&sup, "adv-run", &reply),
        );

        match outcome.expect("advisor tool ok") {
            ToolOutcome::Produced(r) => {
                assert!(!r.ok, "a failed consult must be a not-ok tool result");
                assert!(r.content.contains("Advisor consult failed"), "got: {}", r.content);
                assert!(r.content.contains("no key"), "got: {}", r.content);
                assert!(
                    !r.content.contains("Advisor guidance:"),
                    "an error must not be dressed up as guidance: {}",
                    r.content
                );
            }
            _ => panic!("expected Produced outcome"),
        }
    }

    #[tokio::test]
    async fn pause_for_user_reports_cancellation_through_the_seam() {
        let sup = FakeSupervisor::with_run("run-1");
        let cancel = CancellationToken::new();
        cancel.cancel(); // already cancelled → the pause bails immediately
        let mut emit = |_: AgentEvent| Ok(());
        let outcome = pause_for_user(
            &sup,
            "run-1",
            AgentRunStatus::WaitingForPermission,
            request_event(),
            "(default)",
            &cancel,
            &mut emit,
            |h: &AgentRunHandle, tx| {
                *h.pending_permission.lock().unwrap() = Some(tx);
            },
        )
        .await;
        assert!(matches!(outcome, Ok(PauseOutcome::Cancelled)));
    }
}

#[cfg(test)]
mod run_loop_tests {
    //! Loop-level tests: the real `run_agent_loop` driven headlessly through
    //! its three seams — `FakeSupervisor`, `ScriptedProviderCaller`, and a temp
    //! `runs_dir`. This is the coverage the scripted eval loop used to fake by
    //! re-implementing the turn sequence; now the one Harness loop is the test
    //! surface, including event emission, transcript writes, and `settle_run`.
    use super::test_support::*;
    use super::*;

    /// A fresh sandbox: `(runs_dir, workspace_root)`.
    fn sandbox(name: &str) -> (PathBuf, String) {
        let base = std::env::temp_dir().join(format!(
            "klide-run-loop-{name}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let runs = base.join("runs");
        let workspace = base.join("workspace");
        std::fs::create_dir_all(&runs).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        (runs, workspace.to_string_lossy().to_string())
    }

    async fn drive_loop(
        sup: Arc<FakeSupervisor>,
        runs_dir: &Path,
        id: &str,
        request: StartRunRequest,
        caller: ScriptedProviderCaller,
    ) {
        run_agent_loop(
            sup,
            runs_dir.to_path_buf(),
            id.to_string(),
            request,
            Channel::new(|_| Ok(())),
            CancellationToken::new(),
            caller,
        )
        .await
        .expect("run loop settles without an infrastructure error");
    }

    /// Ports the scripted-model eval: read → edit → verify → final answer, now
    /// through the real loop. Asserts the edit landed, the run settled Done,
    /// the transcript carries the full event sequence, and every tool result
    /// was replayed to the model as a `role: "tool"` message.
    #[tokio::test]
    async fn loop_executes_scripted_tools_and_settles_done() {
        let (runs_dir, root) = sandbox("read-edit-verify");
        std::fs::write(format!("{root}/greeting.txt"), "hello world\n").unwrap();

        let caller = ScriptedProviderCaller::new(vec![
            scripted_turn(
                "I'll inspect the file first.",
                vec![scripted_tool_call(
                    "call_read",
                    "read_file",
                    serde_json::json!({ "path": "greeting.txt" }),
                )],
            ),
            scripted_turn(
                "Now I'll make the requested edit.",
                vec![scripted_tool_call(
                    "call_write",
                    "write_file",
                    serde_json::json!({
                        "path": "greeting.txt",
                        "old_str": "hello world",
                        "new_str": "hello klide",
                    }),
                )],
            ),
            scripted_turn(
                "I'll verify the result.",
                vec![scripted_tool_call(
                    "call_verify",
                    "run_command",
                    serde_json::json!({ "command": "cat greeting.txt" }),
                )],
            ),
            scripted_turn("Done: greeting.txt now says hello klide.", vec![]),
        ]);

        let sup = Arc::new(FakeSupervisor::with_run("loop-run"));
        // The verify command is on the project allowlist so this scenario stays
        // linear; the ask-then-remember path is covered in permission_gate_tests.
        let request = test_request(&root, &["cat greeting.txt"]);
        drive_loop(sup.clone(), &runs_dir, "loop-run", request, caller.clone()).await;

        // The edit landed on disk and the run settled Done.
        assert_eq!(
            std::fs::read_to_string(format!("{root}/greeting.txt")).unwrap(),
            "hello klide\n"
        );
        assert_eq!(
            with_run_handle(sup.as_ref(), "loop-run", |h| h.status),
            Some(AgentRunStatus::Done)
        );

        // The transcript carries the whole sequence.
        let events = read_events(&runs_dir, "loop-run").unwrap();
        assert!(matches!(events.first(), Some(AgentEvent::RunStarted { .. })));
        let finished: Vec<&ToolResult> = events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::ToolCallFinished { result, .. } => Some(result),
                _ => None,
            })
            .collect();
        assert_eq!(finished.len(), 3);
        assert!(finished[0].content.contains("hello world"), "read shows original");
        assert!(finished[1].ok, "edit applied: {}", finished[1].content);
        assert!(
            finished[2].ok && finished[2].content.contains("hello klide"),
            "command sees the edit: {}",
            finished[2].content
        );
        assert!(
            events.iter().any(|e| matches!(
                e,
                AgentEvent::AssistantMessage { content, .. }
                    if content.iter().any(|b| matches!(
                        b,
                        AgentContentBlock::Text { text } if text.contains("Done: greeting.txt")
                    ))
            )),
            "final answer is on the transcript"
        );
        assert!(events.iter().any(|e| matches!(
            e,
            AgentEvent::RunResult { result, .. } if result["status"] == "done"
        )));

        // Every provider turn saw the conversation so far; by the final turn
        // all three tool results had been replayed as role:"tool" messages.
        let roles = caller.seen_roles.lock().unwrap();
        assert_eq!(roles.len(), 4, "one provider call per scripted turn");
        assert_eq!(
            roles[3].iter().filter(|r| r.as_str() == "tool").count(),
            3,
            "tool results are replayed to the model"
        );
    }

    /// A provider failure settles the run as a retryable error instead of
    /// crashing the loop or leaving the run stuck in Running.
    #[tokio::test]
    async fn provider_failure_emits_run_error_and_settles_error() {
        let (runs_dir, root) = sandbox("provider-error");
        let caller =
            ScriptedProviderCaller::new(vec![Err("connection refused (mock)".to_string())]);
        let sup = Arc::new(FakeSupervisor::with_run("err-run"));
        drive_loop(sup.clone(), &runs_dir, "err-run", test_request(&root, &[]), caller).await;

        assert_eq!(
            with_run_handle(sup.as_ref(), "err-run", |h| h.status),
            Some(AgentRunStatus::Error)
        );
        let events = read_events(&runs_dir, "err-run").unwrap();
        assert!(events.iter().any(|e| matches!(
            e,
            AgentEvent::RunError { error, .. }
                if error.code == "provider_unavailable" && error.retryable
        )));
    }

    /// Hitting the turn cap emits a readable final message plus a retryable
    /// max_turns error — never a silent stop on a tool result.
    #[tokio::test]
    async fn turn_cap_emits_a_readable_final_message_and_max_turns_error() {
        let (runs_dir, root) = sandbox("turn-cap");
        std::fs::write(format!("{root}/greeting.txt"), "hello world\n").unwrap();
        // The model keeps asking for tools; the cap (1) cuts it off.
        let caller = ScriptedProviderCaller::new(vec![scripted_turn(
            "Reading first.",
            vec![scripted_tool_call(
                "call_read",
                "read_file",
                serde_json::json!({ "path": "greeting.txt" }),
            )],
        )]);
        let mut request = test_request(&root, &[]);
        request.max_turns = Some(1);
        let sup = Arc::new(FakeSupervisor::with_run("cap-run"));
        drive_loop(sup.clone(), &runs_dir, "cap-run", request, caller).await;

        assert_eq!(
            with_run_handle(sup.as_ref(), "cap-run", |h| h.status),
            Some(AgentRunStatus::Error)
        );
        let events = read_events(&runs_dir, "cap-run").unwrap();
        assert!(
            events.iter().any(|e| matches!(
                e,
                AgentEvent::AssistantMessage { content, .. }
                    if content.iter().any(|b| matches!(
                        b,
                        AgentContentBlock::Text { text } if text.contains("tool-turn limit")
                    ))
            )),
            "the user sees a readable closing message"
        );
        assert!(events.iter().any(|e| matches!(
            e,
            AgentEvent::RunError { error, .. } if error.code == "max_turns" && error.retryable
        )));
    }
}

#[cfg(test)]
mod permission_gate_tests {
    //! The Permission engine's load-bearing behaviour, driven end-to-end
    //! through the real command gate: classify → ask only when new → remember
    //! at the chosen scope → auto-execute or auto-reject the identical
    //! re-proposal. `answer_permission` stands in for the frontend; the
    //! timeout-guarded second calls prove no prompt was shown.
    use super::test_support::*;
    use super::*;
    use std::time::Duration;

    fn temp_workspace(name: &str) -> String {
        let dir = std::env::temp_dir().join(format!(
            "klide-perm-gate-{name}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().to_string()
    }

    fn command_call(id: &str, command: &str) -> NormalizedToolCall {
        NormalizedToolCall {
            id: id.to_string(),
            name: "run_command".to_string(),
            input: serde_json::json!({ "command": command }),
        }
    }

    type EventLog = Arc<Mutex<Vec<AgentEvent>>>;

    fn event_log() -> (EventLog, impl FnMut(AgentEvent) -> Result<(), String>) {
        let events: EventLog = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let emit = move |e: AgentEvent| -> Result<(), String> {
            sink.lock().unwrap().push(e);
            Ok(())
        };
        (events, emit)
    }

    fn prompts_shown(events: &EventLog) -> usize {
        events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| matches!(e, AgentEvent::PermissionRequested { .. }))
            .count()
    }

    fn produced(outcome: Result<ToolOutcome, String>) -> ToolResult {
        match outcome.expect("gate returns ok") {
            ToolOutcome::Produced(result) => result,
            ToolOutcome::Cancelled => panic!("gate unexpectedly reported cancellation"),
        }
    }

    /// Run the command gate expecting NO prompt: if it pauses, nobody answers,
    /// so the timeout converts a would-be hang into a clear failure.
    async fn run_gate_without_prompt(
        ctx: &ToolCtx<'_>,
        call: &NormalizedToolCall,
        emit: &mut impl FnMut(AgentEvent) -> Result<(), String>,
    ) -> ToolResult {
        produced(
            tokio::time::timeout(
                Duration::from_secs(10),
                process_command_tool(ctx, call, emit),
            )
            .await
            .expect("no prompt expected — precheck should have decided"),
        )
    }

    #[tokio::test]
    async fn approve_for_run_executes_and_the_identical_command_skips_the_prompt() {
        let root = temp_workspace("approve-run");
        let sup = FakeSupervisor::with_run("perm-run");
        let cancel = CancellationToken::new();
        let request = test_request(&root, &[]);
        let runs_dir = std::env::temp_dir();
        let ctx = ToolCtx {
            sup: &sup,
            id: "perm-run",
            request: &request,
            cancel: &cancel,
            runs_dir: runs_dir.as_path(),
        };
        let (events, mut emit) = event_log();

        let first_call = command_call("c1", "echo approved-hi");
        let (outcome, _) = tokio::join!(
            process_command_tool(&ctx, &first_call, &mut emit),
            answer_permission(&sup, "perm-run", r#"{"behavior":"allow","scope":"run"}"#),
        );
        let result = produced(outcome);
        assert!(result.ok, "approved command ran: {}", result.content);
        assert!(result.content.contains("approved-hi"));

        // The prompt offered the four standard options.
        {
            let evs = events.lock().unwrap();
            let request_json = evs
                .iter()
                .find_map(|e| match e {
                    AgentEvent::PermissionRequested { request, .. } => Some(request.clone()),
                    _ => None,
                })
                .expect("PermissionRequested emitted");
            let ids: Vec<&str> = request_json["options"]
                .as_array()
                .expect("options array")
                .iter()
                .filter_map(|o| o["optionId"].as_str())
                .collect();
            assert_eq!(ids, ["allow_once", "allow_run", "allow_project", "deny"]);
        }

        // Approved for the run: the identical command auto-executes, no prompt.
        let second =
            run_gate_without_prompt(&ctx, &command_call("c2", "echo approved-hi"), &mut emit)
                .await;
        assert!(second.ok, "re-run auto-executes: {}", second.content);
        assert_eq!(prompts_shown(&events), 1, "asked exactly once");
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn rejected_command_is_remembered_and_the_reproposal_auto_rejects() {
        let root = temp_workspace("reject-run");
        let sup = FakeSupervisor::with_run("perm-run");
        let cancel = CancellationToken::new();
        let request = test_request(&root, &[]);
        let runs_dir = std::env::temp_dir();
        let ctx = ToolCtx {
            sup: &sup,
            id: "perm-run",
            request: &request,
            cancel: &cancel,
            runs_dir: runs_dir.as_path(),
        };
        let (events, mut emit) = event_log();

        let first_call = command_call("c1", "echo nope");
        let (outcome, _) = tokio::join!(
            process_command_tool(&ctx, &first_call, &mut emit),
            answer_permission(&sup, "perm-run", r#"{"behavior":"deny"}"#),
        );
        let result = produced(outcome);
        assert!(!result.ok, "rejected command must not run");
        assert!(result.content.contains("command not run"), "got: {}", result.content);

        // Re-proposing the identical command auto-rejects without a prompt.
        let second = run_gate_without_prompt(&ctx, &command_call("c2", "echo nope"), &mut emit).await;
        assert!(!second.ok);
        assert!(
            second.content.contains("already proposed this exact command"),
            "got: {}",
            second.content
        );
        assert_eq!(prompts_shown(&events), 1, "asked exactly once");
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn project_scope_approval_persists_to_the_on_disk_allowlist() {
        let root = temp_workspace("project-scope");
        let sup = FakeSupervisor::with_run("perm-run");
        let cancel = CancellationToken::new();
        let request = test_request(&root, &[]);
        let runs_dir = std::env::temp_dir();
        let ctx = ToolCtx {
            sup: &sup,
            id: "perm-run",
            request: &request,
            cancel: &cancel,
            runs_dir: runs_dir.as_path(),
        };
        let (events, mut emit) = event_log();

        let first_call = command_call("c1", "echo persist-me");
        let (outcome, _) = tokio::join!(
            process_command_tool(&ctx, &first_call, &mut emit),
            answer_permission(&sup, "perm-run", r#"{"behavior":"allow","scope":"project"}"#),
        );
        assert!(produced(outcome).ok);

        // The approval reached the project allowlist on disk…
        let stored = command_allowlist::list(&root).unwrap();
        assert!(
            stored.contains(&"echo persist-me".to_string()),
            "project approval persisted: {stored:?}"
        );
        // …and the run-scoped memory covers the rest of this run too.
        let second =
            run_gate_without_prompt(&ctx, &command_call("c2", "echo persist-me"), &mut emit).await;
        assert!(second.ok);
        assert_eq!(prompts_shown(&events), 1, "asked exactly once");
        let _ = std::fs::remove_dir_all(root);
    }
}

#[cfg(test)]
mod diff_gate_tests {
    //! The diff-review gate end-to-end through the real `process_write_tool`:
    //! a rejection carrying a review note steers the model (Diff Comment →
    //! Agent, harness route); a bare rejection keeps the legacy wording; an
    //! apply decision in either wire shape still applies.
    use super::test_support::*;
    use super::*;

    fn temp_workspace(name: &str) -> String {
        let dir = std::env::temp_dir().join(format!(
            "klide-diff-gate-{name}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().to_string()
    }

    fn create_call(id: &str, path: &str, contents: &str) -> NormalizedToolCall {
        NormalizedToolCall {
            id: id.to_string(),
            name: "create_file".to_string(),
            input: serde_json::json!({ "path": path, "contents": contents }),
        }
    }

    /// A request with diff review ON (the default), unlike test_request's
    /// auto-accept.
    fn reviewed_request(root: &str) -> StartRunRequest {
        let mut request = test_request(root, &[]);
        request.require_diff_review = None;
        request
    }

    #[test]
    fn parse_diff_decision_tolerates_every_wire_shape() {
        assert_eq!(parse_diff_decision("apply"), ("apply".to_string(), None));
        assert_eq!(parse_diff_decision("reject"), ("reject".to_string(), None));
        assert_eq!(
            parse_diff_decision(r#"{"behavior":"apply"}"#),
            ("apply".to_string(), None)
        );
        assert_eq!(
            parse_diff_decision(r#"{"behavior":"reject","note":"use snake_case"}"#),
            ("reject".to_string(), Some("use snake_case".to_string()))
        );
        // Blank notes are dropped; garbage falls back to a plain rejection.
        assert_eq!(
            parse_diff_decision(r#"{"behavior":"reject","note":"  "}"#),
            ("reject".to_string(), None)
        );
        assert_eq!(parse_diff_decision("{broken"), ("{broken".to_string(), None));
    }

    #[tokio::test]
    async fn reject_with_a_note_returns_the_feedback_as_steering() {
        let root = temp_workspace("note");
        let sup = FakeSupervisor::with_run("diff-run");
        let cancel = CancellationToken::new();
        let request = reviewed_request(&root);
        let runs_dir = std::env::temp_dir();
        let ctx = ToolCtx {
            sup: &sup,
            id: "diff-run",
            request: &request,
            cancel: &cancel,
            runs_dir: runs_dir.as_path(),
        };
        let events = std::sync::Arc::new(Mutex::new(Vec::<AgentEvent>::new()));
        let sink = events.clone();
        let mut emit = move |e: AgentEvent| -> Result<(), String> {
            sink.lock().unwrap().push(e);
            Ok(())
        };

        let call = create_call("c1", "notes.md", "- shipit\n");
        let (outcome, _) = tokio::join!(
            process_write_tool(&ctx, &call, &mut emit),
            answer_diff(
                &sup,
                "diff-run",
                r#"{"behavior":"reject","note":"Use a heading and full sentences."}"#
            ),
        );

        let result = match outcome.expect("gate ok") {
            ToolOutcome::Produced(r) => r,
            ToolOutcome::Cancelled => panic!("unexpected cancellation"),
        };
        assert!(!result.ok, "rejected edit must not report ok");
        assert!(
            result.content.contains("Use a heading and full sentences."),
            "the model sees the feedback: {}",
            result.content
        );
        assert!(
            result.content.contains("Revise the change"),
            "steering language, not abandon-course language: {}",
            result.content
        );
        assert!(
            !std::path::Path::new(&root).join("notes.md").exists(),
            "rejected create must not land on disk"
        );
        // The transcript's DiffResolved carries the note for replay surfaces.
        let evs = events.lock().unwrap();
        assert!(evs.iter().any(|e| matches!(
            e,
            AgentEvent::DiffResolved { decision, .. }
                if decision["behavior"] == "reject"
                    && decision["note"] == "Use a heading and full sentences."
        )));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn bare_reject_keeps_the_legacy_wording() {
        let root = temp_workspace("bare");
        let sup = FakeSupervisor::with_run("diff-run");
        let cancel = CancellationToken::new();
        let request = reviewed_request(&root);
        let runs_dir = std::env::temp_dir();
        let ctx = ToolCtx {
            sup: &sup,
            id: "diff-run",
            request: &request,
            cancel: &cancel,
            runs_dir: runs_dir.as_path(),
        };
        let mut emit = |_: AgentEvent| -> Result<(), String> { Ok(()) };

        let call = create_call("c1", "notes.md", "x\n");
        let (outcome, _) = tokio::join!(
            process_write_tool(&ctx, &call, &mut emit),
            // The cancellation-default wire shape: a bare behavior string.
            answer_diff(&sup, "diff-run", "reject"),
        );
        let result = match outcome.expect("gate ok") {
            ToolOutcome::Produced(r) => r,
            ToolOutcome::Cancelled => panic!("unexpected cancellation"),
        };
        assert!(!result.ok);
        assert!(
            result.content.contains("Rejected by user"),
            "got: {}",
            result.content
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn apply_decision_json_applies_the_edit() {
        let root = temp_workspace("apply");
        let sup = FakeSupervisor::with_run("diff-run");
        let cancel = CancellationToken::new();
        let request = reviewed_request(&root);
        let runs_dir = std::env::temp_dir().join(format!(
            "klide-diff-gate-runs-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&runs_dir).unwrap();
        let ctx = ToolCtx {
            sup: &sup,
            id: "diff-run",
            request: &request,
            cancel: &cancel,
            runs_dir: runs_dir.as_path(),
        };
        let mut emit = |_: AgentEvent| -> Result<(), String> { Ok(()) };

        let call = create_call("c1", "notes.md", "approved\n");
        let (outcome, _) = tokio::join!(
            process_write_tool(&ctx, &call, &mut emit),
            answer_diff(&sup, "diff-run", r#"{"behavior":"apply"}"#),
        );
        let result = match outcome.expect("gate ok") {
            ToolOutcome::Produced(r) => r,
            ToolOutcome::Cancelled => panic!("unexpected cancellation"),
        };
        assert!(result.ok, "applied: {}", result.content);
        assert_eq!(
            std::fs::read_to_string(std::path::Path::new(&root).join("notes.md")).unwrap(),
            "approved\n"
        );
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(runs_dir);
    }
}

#[cfg(test)]
mod network_permission_tests {
    use super::*;

    #[test]
    fn web_fetch_permission_targets_the_host() {
        let call = NormalizedToolCall {
            id: "call_fetch".to_string(),
            name: "web_fetch".to_string(),
            input: serde_json::json!({ "url": "https://Docs.RS/crate/serde" }),
        };
        let invocation = network_invocation(&call).expect("valid fetch");
        assert_eq!(invocation.target, "host:docs.rs");
        assert_eq!(invocation.input["host"], "docs.rs");
    }

    #[test]
    fn web_search_permission_uses_search_target() {
        let call = NormalizedToolCall {
            id: "call_search".to_string(),
            name: "web_search".to_string(),
            input: serde_json::json!({ "query": "serde docs" }),
        };
        let invocation = network_invocation(&call).expect("valid search");
        assert_eq!(invocation.target, "web_search");
        assert_eq!(invocation.input["target"], "web_search");
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
    fn revert_all_consumes_every_checkpoint_newest_first() {
        let (runs, ws) = make_sandbox("revert-all");
        let run = "run_all";
        let rel = "note.md";
        let abs = ws.join(rel);
        std::fs::write(&abs, "v3").unwrap();

        let older = checkpoint_json(
            "turn1_tool_1",
            rel,
            "v1",
            "v2",
            false,
            ws.to_str().unwrap(),
            1,
        );
        let newer = checkpoint_json(
            "turn2_tool_1",
            rel,
            "v2",
            "v3",
            false,
            ws.to_str().unwrap(),
            2,
        );
        write_checkpoint(&runs, run, "turn1_tool_1", &older);
        write_checkpoint(&runs, run, "turn2_tool_1", &newer);

        let result = revert_all_checkpoints_at(&runs, run).expect("revert all");
        assert_eq!(result.reverted, 2);
        assert_eq!(std::fs::read_to_string(&abs).unwrap(), "v1");
        assert!(
            list_checkpoints_at(&runs, run).unwrap().is_empty(),
            "all checkpoint files should be consumed"
        );
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
