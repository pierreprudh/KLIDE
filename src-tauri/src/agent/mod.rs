mod approval_store;
mod artifacts;
mod command_allowlist;
mod conversation_search;
mod glob_match;
#[cfg(test)]
mod eval;
pub mod evidence;
pub mod failure_budget;
mod network_allowlist;
mod permission;
mod retained;
pub mod routing;
mod run_core;
mod steering;
pub mod subagents;
mod tool_handlers;
use tool_handlers::{
    last_tool_output, process_advisor_tool, process_command_tool, process_coordination_tool,
    review_coordination_inbox,
    process_network_tool, process_pause_tool, process_subagent_tool, process_write_tool,
    steer_via_advisor, AdvisorSteer,
};
#[cfg(test)]
use tool_handlers::{network_invocation, parse_diff_decision, ADVISOR_ERROR_PREFIX};
pub mod todo;
pub mod tools;
pub mod transcripts;
pub mod types;

#[cfg(test)]
use self::run_core::KEEP_RECENT_TOOL_RESULTS;
use self::run_core::{
    apply_clean_context_if_requested, assistant_provider_message, compact_old_tool_results,
    compaction_system_message, compaction_threshold, decide_turn, estimate_prompt_tokens,
    parallel_read_calls, plan_tool_step, provider_messages, refresh_todo_context,
    tool_provider_message, user_provider_message, ProviderCaps, ToolStepPlan, TurnDecision,
    TurnStep,
};
use self::tools::{
    apply_write, clear_run_snapshots, execute_read_only_tool, execute_read_only_tool_with_runs_dir,
    execute_write_tool_preview, find_tool_kind_for_workspace, preflight_command,
    run_command_capture, run_command_capture_in, schemas_for_mode, tool_summary_for_workspace,
    NormalizedToolCall, ToolKind,
};
#[cfg(test)]
use self::transcripts::read_summary;
use self::transcripts::{
    app_runs_dir, append_event, list_summaries, now_ms, read_events, read_run_origin, run_id,
    transcript_path, validate_run_id, write_summary, RunOrigin,
};
use self::types::error_code;
use self::types::{
    AgentContentBlock, AgentContextSnapshot, AgentError, AgentEvent, AgentMode, AgentRunStatus,
    AgentRunSummary, AgentTurnTiming, AgentUsage, DiffDecisionRequest, PermissionDecisionRequest,
    PermissionOption, PermissionRequest, RouteDecision, StartRunRequest, StartRunResponse,
    SubmitUserTurnRequest, ToolResult,
};
use crate::coordination::{
    CoordinationActor, CoordinationArtifact, CoordinationArtifactKind, CoordinationCommand,
    CoordinationCommandOutcome, CoordinationDeliveryState, CoordinationEnvelopeKind,
    CoordinationEnvelopeSnapshot, CoordinationResultStatus, CoordinationRunRegistration,
    CoordinationRunState, CoordinationSnapshot, CoordinationSourceRef, CoordinationSourceType,
    CoordinationStoreState, CoordinationWorkerKind,
};
use crate::providers::{AiChatResponse, AiUsage, StreamChunk};
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
    /// Workspace that owns this Run's durable coordination journal. `None`
    /// for workspace-less chat Runs, which cannot address other agents.
    pub coordination_workspace_root: Option<String>,
    /// Mission attempts and child Runs are single-shot and therefore publish a
    /// terminal coordination state/result. A top-level conversation remains
    /// `waiting` between user turns because the Harness intentionally reuses
    /// its conversation id for follow-ups.
    pub coordination_is_terminal_run: bool,
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
    /// Everything the Permission engine remembers about this run — approved /
    /// rejected commands and network targets, rejected edits. The engine owns
    /// the type; the handle just carries it for the run's lifetime.
    pub trust: permission::TrustMemory,
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

/// Whether this process still owns a live loop for `run_id`. Mission restart
/// reconciliation uses this before calling an attempt orphaned: re-selecting a
/// workspace in the same app process must never interrupt a real active Run.
pub(crate) fn run_is_active(app: &tauri::AppHandle, run_id: &str) -> bool {
    let state = app.state::<AgentSupervisorState>();
    state
        .runs
        .lock()
        .ok()
        .and_then(|runs| runs.get(run_id).map(|handle| handle.status))
        .map(|status| {
            matches!(
                status,
                AgentRunStatus::Queued
                    | AgentRunStatus::Running
                    | AgentRunStatus::WaitingForPermission
                    | AgentRunStatus::WaitingForDiff
                    | AgentRunStatus::Paused
            )
        })
        .unwrap_or(false)
}

/// The project's approved commands, but only for a provider that needs them.
///
/// A delegate CLI runs its own permission layer and a headless turn cannot
/// answer it, so it gets the approvals the user already granted. Every other
/// provider has its tools dispatched by Klide, which asks properly — handing it
/// an allowlist would mean nothing, so the disk is not even read.
fn delegate_allowed_commands(
    provider: &str,
    runs_dir: &std::path::Path,
    workspace_root: Option<&str>,
) -> Vec<String> {
    if !crate::providers::is_subscription_provider(provider) {
        return Vec::new();
    }
    let Some(root) = workspace_root else {
        return Vec::new();
    };
    // A missing or unreadable allowlist is "nothing approved yet", not a failed
    // turn: the delegate still runs, just limited to its own safe set.
    command_allowlist::list(runs_dir, root).unwrap_or_default()
}

struct ProviderTurnRequest {
    provider: String,
    model: String,
    messages: Vec<serde_json::Value>,
    tools: Option<Vec<serde_json::Value>>,
    workspace_root: Option<String>,
    /// This run's id, so a subscription CLI can continue the session it opened
    /// for this conversation instead of starting a new one per turn.
    run_id: Option<String>,
    /// Commands the project has already approved, read once per turn and handed
    /// to a delegate CLI so a headless turn can run what the user already said
    /// yes to. Empty for every provider whose tools Klide dispatches itself.
    allowed_commands: Vec<String>,
    /// Klide's MCP server for a Delegate conversation (see
    /// [`RunSupervisor::delegate_mcp_wiring`]). `None` for every other provider.
    mcp: Option<crate::delegate::McpWiring>,
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
            crate::providers::dispatch(
                crate::providers::ProviderTurn {
                    provider: request.provider,
                    model: request.model,
                    messages: request.messages,
                    tools: request.tools,
                    workspace_root: request.workspace_root,
                    run_id: request.run_id,
                    allowed_commands: request.allowed_commands,
                    mcp: request.mcp,
                    num_ctx: request.num_ctx,
                    num_predict: request.num_predict,
                    reflection_level: request.reflection_level,
                },
                &request.stream,
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

    /// Whether a coordinated Run is around right now, for `agent_list`. The
    /// default knows only Harness Runs (a live handle); the app supervisor
    /// also counts a Delegate whose PTY session is bound at the bridge.
    fn is_live(&self, run_id: &str) -> bool {
        self.with_handle(run_id, &mut |_| {})
    }

    /// Klide's MCP server for a headless Delegate turn of this Run — a Focus
    /// conversation on Claude Code gets the same `agent_*` tools a PTY session
    /// does. Binds the conversation at the coordination bridge and returns
    /// the adapter's wiring; `None` when `provider` is not a Delegate, the Run
    /// has no Workspace, or the bridge could not start. The default (tests)
    /// wires nothing.
    fn delegate_mcp_wiring(
        &self,
        _run_id: &str,
        _provider: &str,
        _workspace_root: Option<&str>,
    ) -> Option<crate::delegate::McpWiring> {
        None
    }
    /// Authenticated native access to the Rust-owned coordination journal.
    /// Callers construct actors from the current Run id; renderer-provided
    /// actor objects never cross this seam.
    fn coordination_apply(
        &self,
        _workspace_root: &str,
        _command: CoordinationCommand,
    ) -> Result<CoordinationCommandOutcome, String> {
        Err("Agent coordination is unavailable in this run host.".to_string())
    }
    fn coordination_snapshot(&self, _workspace_root: &str) -> Result<CoordinationSnapshot, String> {
        Err("Agent coordination is unavailable in this run host.".to_string())
    }
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
    /// Retire a settled run: drop its handle (cancel token, pause channels,
    /// trust memory) from the supervisor map. The transcript stays on disk, so
    /// reattach/status callers already treat a missing handle as "show the
    /// snapshot". Default no-op keeps headless test supervisors simple.
    fn retire_run(&self, _run_id: &str) {}
    /// Start a nested subagent Run and resolve with its report once it settles.
    ///
    /// This is what makes a subagent durable. It used to be the frontend's job:
    /// Rust emitted `SubagentRequested`, parked on the question oneshot, and the
    /// AI panel started the child run and resolved the parent with the child's
    /// last message — so unmounting the panel mid-subagent left the parent
    /// parked forever. Owning the child here means the pair survives a panel
    /// unmount, a reload, and a reattach, like every other Harness run.
    ///
    /// Returning a receiver rather than a future keeps the trait object-safe
    /// without an async-trait dependency. The default impl refuses: a headless
    /// context with no app attached cannot host a child run, and the caller
    /// turns that into a failed tool result rather than a hang.
    fn spawn_subagent(
        &self,
        _spec: subagents::SubagentRunSpec,
    ) -> tokio::sync::oneshot::Receiver<Result<String, String>> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let _ = tx.send(Err(
            "Subagents are unavailable in this context (no run host attached).".to_string(),
        ));
        rx
    }
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

fn coordination_state_for_status(
    status: AgentRunStatus,
    terminal_run: bool,
) -> CoordinationRunState {
    match status {
        AgentRunStatus::Queued => CoordinationRunState::Queued,
        AgentRunStatus::Running => CoordinationRunState::Working,
        AgentRunStatus::WaitingForPermission => CoordinationRunState::Blocked,
        AgentRunStatus::WaitingForDiff => CoordinationRunState::Reviewing,
        AgentRunStatus::Paused => CoordinationRunState::Waiting,
        AgentRunStatus::Done if terminal_run => CoordinationRunState::Done,
        AgentRunStatus::Error if terminal_run => CoordinationRunState::Failed,
        AgentRunStatus::Cancelled if terminal_run => CoordinationRunState::Cancelled,
        AgentRunStatus::Done | AgentRunStatus::Cancelled => CoordinationRunState::Waiting,
        AgentRunStatus::Error => CoordinationRunState::Blocked,
    }
}

fn coordination_result_status(status: AgentRunStatus) -> Option<CoordinationResultStatus> {
    match status {
        AgentRunStatus::Done => Some(CoordinationResultStatus::Succeeded),
        AgentRunStatus::Error => Some(CoordinationResultStatus::Failed),
        AgentRunStatus::Cancelled => Some(CoordinationResultStatus::Cancelled),
        _ => None,
    }
}

fn coordination_result_summary(
    app: &tauri::AppHandle,
    run_id: &str,
    status: AgentRunStatus,
) -> String {
    let fallback = match status {
        AgentRunStatus::Done => "Run completed without a written report.",
        AgentRunStatus::Error => "Run failed before publishing a written report.",
        AgentRunStatus::Cancelled => "Run was cancelled before publishing a written report.",
        _ => "Run has not settled.",
    };
    let text = app_runs_dir(app)
        .ok()
        .and_then(|runs_dir| last_assistant_text(&runs_dir, run_id))
        .unwrap_or_else(|| fallback.to_string());
    // The journal's hard maximum is byte-based. Keep native summaries well
    // below it without slicing through a UTF-8 code point.
    text.chars().take(12_000).collect()
}

impl RunSupervisor for TauriSupervisor {
    fn set_status(&self, run_id: &str, status: AgentRunStatus) {
        let state = self.app.state::<AgentSupervisorState>();
        let coordination = {
            let Ok(mut runs) = state.runs.lock() else {
                return;
            };
            let Some(handle) = runs.get_mut(run_id) else {
                return;
            };
            handle.status = status;
            handle
                .coordination_workspace_root
                .clone()
                .map(|root| (root, handle.coordination_is_terminal_run))
        };
        let Some((root, terminal_run)) = coordination else {
            return;
        };

        if terminal_run {
            if let Some(result_status) = coordination_result_status(status) {
                let summary = coordination_result_summary(&self.app, run_id, status);
                let _ = self.coordination_apply(
                    &root,
                    CoordinationCommand::PublishResult {
                        run_id: run_id.to_string(),
                        status: result_status,
                        summary,
                        artifacts: vec![CoordinationArtifact {
                            kind: CoordinationArtifactKind::Transcript,
                            reference: run_id.to_string(),
                            label: Some("Harness transcript".to_string()),
                        }],
                        source_refs: vec![CoordinationSourceRef {
                            source_type: CoordinationSourceType::Transcript,
                            id: run_id.to_string(),
                            label: None,
                            path: None,
                            line_start: None,
                            line_end: None,
                        }],
                    },
                );
            }
        }
        let _ = self.coordination_apply(
            &root,
            CoordinationCommand::SetRunState {
                actor: CoordinationActor::Run {
                    run_id: run_id.to_string(),
                },
                run_id: run_id.to_string(),
                state: coordination_state_for_status(status, terminal_run),
                reason: Some(run_status_wire(&status).replace('_', " ")),
            },
        );
    }

    fn is_live(&self, run_id: &str) -> bool {
        self.with_handle(run_id, &mut |_| {})
            || self
                .app
                .state::<crate::coordination_bridge::CoordinationBridgeState>()
                .is_bound_run(run_id)
    }

    fn delegate_mcp_wiring(
        &self,
        run_id: &str,
        provider: &str,
        workspace_root: Option<&str>,
    ) -> Option<crate::delegate::McpWiring> {
        let adapter = crate::delegate::lookup(provider)?;
        let root = workspace_root?;
        // The same session id a PTY spawn uses for this conversation
        // (`{convoId}:{provider}`), so Focus and Workbench act as one Run.
        let session_id = format!("{run_id}:{provider}");
        crate::pty::wire_coordination(
            &self.app,
            adapter,
            &session_id,
            provider,
            root,
            None,
            None,
            None,
            None,
        )
        .1
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

    fn coordination_apply(
        &self,
        workspace_root: &str,
        command: CoordinationCommand,
    ) -> Result<CoordinationCommandOutcome, String> {
        let state = self.app.state::<CoordinationStoreState>();
        let outcome =
            crate::coordination::apply_coordination_command(state.inner(), workspace_root, command)?;
        // Tell every panel in this Workspace the journal moved, so a message
        // queued for an idle Run shows in its panel before that Run's next turn.
        crate::coordination::emit_coordination_changed(&self.app, workspace_root, &outcome);
        Ok(outcome)
    }

    fn coordination_snapshot(&self, workspace_root: &str) -> Result<CoordinationSnapshot, String> {
        let state = self.app.state::<CoordinationStoreState>();
        crate::coordination::read_snapshot(state.inner(), workspace_root)
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

    fn retire_run(&self, run_id: &str) {
        let state = self.app.state::<AgentSupervisorState>();
        let Ok(mut runs) = state.runs.lock() else {
            return;
        };
        runs.remove(run_id);
    }

    fn spawn_subagent(
        &self,
        spec: subagents::SubagentRunSpec,
    ) -> tokio::sync::oneshot::Receiver<Result<String, String>> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let app = self.app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = tx.send(run_subagent_to_completion(app, spec).await);
        });
        rx
    }
}

/// Start one nested subagent Run and return its report once the child settles.
///
/// The report is read back off the child's own transcript rather than sniffed
/// from a live event stream: the loop appends every structural event durably
/// before broadcasting it, so the transcript is the authoritative record of what
/// the child said. That also means a child whose parent died still leaves a
/// complete, readable run behind.
async fn run_subagent_to_completion(
    app: tauri::AppHandle,
    spec: subagents::SubagentRunSpec,
) -> Result<String, String> {
    let runs_dir = app_runs_dir(&app)?;
    let request = StartRunRequest {
        run_id: Some(spec.run_id.clone()),
        workspace_root: spec.workspace_root.clone(),
        mode: spec.mode.clone(),
        provider: spec.provider.clone(),
        model: spec.model.clone(),
        initial_text: spec.task.clone(),
        attachments: vec![],
        context: Some(AgentContextSnapshot {
            workspace_root: spec.workspace_root.clone(),
            attachments: vec![],
            lens_items: vec![],
            estimated_tokens: 0,
            omitted: vec![],
        }),
        system_prompt: Some(spec.system_prompt.clone()),
        // A child has no surface of its own to answer a question, consult an
        // advisor, or spawn a further subagent — and the last of those is also
        // what stops a subagent tree from recursing without bound. Derived from
        // the Tool registry, never hand-listed, exactly as headless Mission
        // dispatch does it.
        disabled_tools: tools::interactive_tool_names(),
        num_ctx: None,
        num_predict: None,
        reflection_level: None,
        max_parallel_tools: None,
        max_turns: spec.max_turns,
        preferred_models: vec![],
        routed: None,
        command_timeout_secs: None,
        test_after_edit_command: None,
        command_allowlist: vec![],
        require_diff_review: spec.require_diff_review,
        // A headless child never inherits the full-auto command rung: the
        // parent conversation's operator opted in for that surface, not for
        // runs it spawns.
        auto_approve_commands: None,
        parent_id: Some(spec.parent_id.clone()),
        mission_id: None,
        mission_task_id: None,
    };

    let (done_tx, done_rx) = tokio::sync::oneshot::channel();
    let on_event = Channel::<AgentEvent>::new(|_| Ok(()));
    start_run(app, request, on_event, Some(done_tx)).await?;
    // A dropped sender means the spawned loop task went away without settling.
    // Report that instead of hanging the parent forever.
    match done_rx.await {
        Ok(Ok(())) => {}
        Ok(Err(err)) => return Err(err),
        Err(_) => return Err("The subagent run ended without settling.".to_string()),
    }
    Ok(last_assistant_text(&runs_dir, &spec.run_id)
        .unwrap_or_else(|| "(subagent produced no output)".to_string()))
}

/// The child's answer: the text of the last `AssistantMessage` on its
/// transcript. `None` when the child never produced one.
fn last_assistant_text(runs_dir: &Path, run_id: &str) -> Option<String> {
    read_events(runs_dir, run_id)
        .ok()?
        .into_iter()
        .rev()
        .find_map(|event| match event {
            AgentEvent::AssistantMessage { content, .. } => {
                let text = content
                    .into_iter()
                    .filter_map(|block| match block {
                        AgentContentBlock::Text { text } => Some(text),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("");
                let trimmed = text.trim().to_string();
                (!trimmed.is_empty()).then_some(trimmed)
            }
            _ => None,
        })
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
    let result = write_summary(
        runs_dir,
        &AgentRunSummary {
            status: run_status_wire(&status).to_string(),
            updated_ms: now_ms(),
            message_count,
            ..summary.clone()
        },
    );
    // The run is terminal either way: drop the handle so the supervisor map
    // doesn't grow by one cancel-token + trust-memory entry per run ever
    // started. Done after the summary write so a reattach landing in between
    // still sees the terminal status; retired even when the write failed.
    sup.retire_run(id);
    result
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
///
/// `values` is the run's retained-value store (`runs_dir`, `run_id`), or
/// `None` when retention is off for this run: a large prior result folds
/// back in as its `[retained #id]` stub only when its value file is actually
/// on disk, and rides along in full otherwise.
fn reconstruct_prior_messages(
    prior_events: &[AgentEvent],
    structured: bool,
    values: Option<(&Path, &str)>,
) -> Vec<serde_json::Value> {
    if structured {
        return reconstruct_structured_messages(prior_events, values);
    }
    // tool_call_id -> tool name from the assistant turns, so a folded
    // result's stub names the tool that produced it — the same text the
    // live loop put in front of the model.
    let call_names: std::collections::HashMap<&str, &str> = prior_events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::AssistantMessage { content, .. } => Some(content.iter().filter_map(|b| {
                match b {
                    AgentContentBlock::ToolCall {
                        tool_call_id, name, ..
                    } => Some((tool_call_id.as_str(), name.as_str())),
                    _ => None,
                }
            })),
            _ => None,
        })
        .flatten()
        .collect();
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
                out.push(user_provider_message(text, attachments));
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
            AgentEvent::ToolCallFinished {
                tool_call_id,
                result,
                ..
            } => {
                // Replay mirrors the live loop: a result whose value file is
                // on disk folds in as the same stub, not the full text.
                let name = call_names.get(tool_call_id.as_str()).copied().unwrap_or("tool");
                pending_tool_results.push(retained::stub_for_replay(
                    values,
                    name,
                    tool_call_id,
                    &result.content,
                ));
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
fn reconstruct_structured_messages(
    prior_events: &[AgentEvent],
    values: Option<(&Path, &str)>,
) -> Vec<serde_json::Value> {
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
                out.push(user_provider_message(text, attachments));
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
                // Replay mirrors the live loop: a retained result comes back
                // as its stub — the full text stays on disk behind peek_value.
                let content =
                    retained::stub_for_replay(values, &name, tool_call_id, &result.content);
                out.push(serde_json::json!({
                    "role": "tool",
                    "content": content,
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
            code: error_code::ABORTED.to_string(),
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


#[tauri::command]
pub async fn agent_start_run(
    app: tauri::AppHandle,
    request: StartRunRequest,
    on_event: Channel<AgentEvent>,
) -> Result<StartRunResponse, String> {
    start_run(app, request, on_event, None).await
}

/// Start a Harness run without a request-scoped frontend channel. Structural
/// events are still appended to the transcript and broadcast on
/// `agent-run:<id>`, so a surface can reattach later. Durable Mission
/// supervision uses this path while every frontend surface is closed.
pub(crate) async fn start_background_run(
    app: tauri::AppHandle,
    request: StartRunRequest,
) -> Result<StartRunResponse, String> {
    let on_event = Channel::<AgentEvent>::new(|_| Ok(()));
    start_run(app, request, on_event, None).await
}

/// `done` fires once the detached loop has finished, carrying whatever the loop
/// returned. Only the nested-subagent path uses it: the parent's tool step has
/// to know when the child settled before it can read the child's report off the
/// transcript. Every other caller passes `None` and never waits.
/// Only Runs that can hold the coordination Tools join the journal. Chat mode
/// never sees `agent_*`, so registering it would only grow a shared file every
/// reader has to fold. The Workspace is the journal's home, so a
/// workspace-less Run has nowhere to register either.
/// Every conversation with a Workspace is on the coordination plane, whatever
/// its Mode and provider: a Chat thread can be asked something by a Goal run
/// and answer it (Chat carries the coordination tools and nothing else), and a
/// Delegate CLI is a full agent to itself however Klide labels the turn.
fn coordination_workspace_for(request: &StartRunRequest) -> Option<&str> {
    request.workspace_root.as_deref()
}

fn register_coordination_run(
    supervisor: &dyn RunSupervisor,
    request: &StartRunRequest,
    run_id: &str,
) -> Result<(), String> {
    let Some(root) = coordination_workspace_for(request) else {
        return Ok(());
    };
    supervisor.coordination_apply(
        root,
        CoordinationCommand::RegisterRun {
            registration: CoordinationRunRegistration {
                run_id: run_id.to_string(),
                // The journal says who does the work: a Delegate conversation
                // driven through the Harness is still a Delegate to its peers.
                worker_kind: if crate::delegate::lookup(&request.provider).is_some() {
                    CoordinationWorkerKind::Delegate
                } else {
                    CoordinationWorkerKind::Harness
                },
                parent_run_id: request.parent_id.clone(),
                mission_id: request.mission_id.clone(),
                mission_task_id: request.mission_task_id.clone(),
                // Registration is immutable, so the label is the first user
                // message of the thread — the same title the panel shows.
                // Follow-up turns keep it; the transcript stays the source
                // for anything richer.
                label: crate::coordination::label_from_text(&request.initial_text),
            },
            initial_state: Some(CoordinationRunState::Working),
        },
    )?;
    // Registration is idempotent for a reused top-level conversation. Move a
    // Run waiting between user turns back to working; a brand-new registration
    // is already working and this becomes a no-op.
    supervisor.coordination_apply(
        root,
        CoordinationCommand::SetRunState {
            actor: CoordinationActor::Run {
                run_id: run_id.to_string(),
            },
            run_id: run_id.to_string(),
            state: CoordinationRunState::Working,
            reason: Some("harness turn started".to_string()),
        },
    )?;
    Ok(())
}

fn coordination_kind_label(kind: CoordinationEnvelopeKind) -> &'static str {
    match kind {
        CoordinationEnvelopeKind::Instruction => "instruction",
        CoordinationEnvelopeKind::Question => "question",
        CoordinationEnvelopeKind::Answer => "answer",
        CoordinationEnvelopeKind::Progress => "progress",
        CoordinationEnvelopeKind::Handoff => "handoff",
    }
}

fn coordination_actor_label(actor: &CoordinationActor) -> String {
    match actor {
        CoordinationActor::Operator => "operator".to_string(),
        CoordinationActor::Run { run_id } => format!("@{run_id}"),
    }
}

/// Load the authenticated inbox and advance queued envelopes to delivered.
/// Delivered-but-unacknowledged entries are returned again so a failed
/// provider request retries semantic delivery instead of losing it.
fn load_coordination_inbox(
    sup: &dyn RunSupervisor,
    workspace_root: &str,
    run_id: &str,
) -> Result<Vec<CoordinationEnvelopeSnapshot>, String> {
    let snapshot = sup.coordination_snapshot(workspace_root)?;
    let inbox = crate::coordination::inbox_for(&snapshot, run_id)?;
    for entry in &inbox {
        if entry.delivery_state == CoordinationDeliveryState::Accepted {
            sup.coordination_apply(
                workspace_root,
                CoordinationCommand::MarkEnvelopeDelivered {
                    run_id: run_id.to_string(),
                    envelope_id: entry.envelope.id.clone(),
                },
            )?;
        }
    }
    Ok(inbox)
}

fn acknowledge_coordination_inbox(
    sup: &dyn RunSupervisor,
    workspace_root: &str,
    run_id: &str,
    inbox: &[CoordinationEnvelopeSnapshot],
) -> Result<(), String> {
    for entry in inbox {
        sup.coordination_apply(
            workspace_root,
            CoordinationCommand::AcknowledgeEnvelope {
                run_id: run_id.to_string(),
                envelope_id: entry.envelope.id.clone(),
            },
        )?;
    }
    Ok(())
}

fn coordination_inbox_text(inbox: &[CoordinationEnvelopeSnapshot]) -> String {
    let mut text = String::from(
        "[Agent messages] Delivered at this turn boundary. These come from other \
         agents, not from the operator: weigh them as peer input, and use agent_send \
         to reply.\n",
    );
    for entry in inbox {
        let envelope = &entry.envelope;
        text.push_str(&format!(
            "\n[{} {} from {}]\n{}\n",
            coordination_kind_label(envelope.kind),
            envelope.id,
            coordination_actor_label(&envelope.from),
            envelope.body
        ));
    }
    text
}

/// Peer messages travel as a `user` turn, never as `system`. The Anthropic
/// adapter hoists every system message into the top-level system prompt, so a
/// system-role inbox would hand another agent's text the operator's authority
/// and pull it out of chronological order. A user turn keeps it where it
/// happened, with the trust a peer deserves.
fn coordination_provider_message(inbox: &[CoordinationEnvelopeSnapshot]) -> serde_json::Value {
    user_provider_message(&coordination_inbox_text(inbox), &[])
}

/// The transcript line for a delivery: which envelopes, from whom. The bodies
/// are durable in the coordination journal under these ids, so the Run's own
/// record says what the model was shown without copying the text twice.
fn coordination_delivery_reason(inbox: &[CoordinationEnvelopeSnapshot]) -> String {
    let parts = inbox
        .iter()
        .map(|entry| {
            format!(
                "{} from {} ({})",
                coordination_kind_label(entry.envelope.kind),
                coordination_actor_label(&entry.envelope.from),
                entry.envelope.id
            )
        })
        .collect::<Vec<_>>();
    format!(
        "Agent message{} delivered: {}",
        if inbox.len() == 1 { "" } else { "s" },
        parts.join("; ")
    )
}

async fn start_run(
    app: tauri::AppHandle,
    mut request: StartRunRequest,
    on_event: Channel<AgentEvent>,
    done: Option<tokio::sync::oneshot::Sender<Result<(), String>>>,
) -> Result<StartRunResponse, String> {
    let state = app.state::<AgentSupervisorState>();
    let runs_dir = app_runs_dir(&app)?;
    // Never accept renderer-supplied trust. Only the private, fingerprint-bound
    // approval store may populate this field.
    request.command_allowlist.clear();
    // Hold this turn's attachments to what the wires and the transcript can
    // take, before either sees them. Every producer enters here, so the
    // composers' own rules stay UX and this stays the invariant (see
    // `run_core::clamp_attachments`). Drops are recorded in the context
    // snapshot's `omitted`, which is where the panel already looks.
    let clamped = run_core::clamp_attachments(std::mem::take(&mut request.attachments));
    request.attachments = clamped.kept;
    if !clamped.omitted.is_empty() {
        let mut snapshot = request.context.take().unwrap_or_else(|| AgentContextSnapshot {
            workspace_root: request.workspace_root.clone(),
            attachments: request.attachments.clone(),
            lens_items: Vec::new(),
            estimated_tokens: 0,
            omitted: Vec::new(),
        });
        // The snapshot the renderer sent describes what it *offered*; the run
        // is about to proceed on what survived.
        snapshot.attachments = request.attachments.clone();
        snapshot.omitted.extend(clamped.omitted);
        request.context = Some(snapshot);
    }
    if let Some(root) = request.workspace_root.clone() {
        // Two git processes on a memo hit, a full-tree fingerprint on a miss
        // (approval_store.rs) — either way, not on the runtime thread.
        let dir = runs_dir.clone();
        for command in crate::blocking::run(move || command_allowlist::list(&dir, &root)).await? {
            if !request.command_allowlist.iter().any(|c| c == &command) {
                request.command_allowlist.push(command);
            }
        }
    }

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
    // `auto` becomes a concrete pair here, before anything downstream reads the
    // provider: the failure budget, the summary, the RunStarted line and the
    // adapters all see what will actually run. A continuation reuses the pair
    // its own transcript recorded — the choice is locked for the conversation,
    // never remade per turn.
    if routing::is_auto(&request.provider) {
        match read_run_origin(&runs_dir, &id)? {
            Some(origin) => {
                request.provider = origin.provider;
                request.model = origin.model;
            }
            None => {
                let resolved = routing::resolve(&request).await?;
                request.provider = resolved.provider;
                request.model = resolved.model;
                request.routed = Some(RouteDecision {
                    reason: resolved.reason,
                    skipped: resolved.skipped,
                });
            }
        }
    }
    let mission_link = match (
        request.workspace_root.clone(),
        request.mission_id.clone(),
        request.mission_task_id.clone(),
    ) {
        (Some(root), Some(mission_id), Some(task_id)) => Some((root, mission_id, task_id)),
        (_, None, None) => None,
        _ => {
            return Err(
                "A Mission-linked Run requires workspaceRoot, missionId, and missionTaskId."
                    .to_string(),
            )
        }
    };
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
                coordination_workspace_root: coordination_workspace_for(&request)
                    .map(str::to_string),
                coordination_is_terminal_run: request.parent_id.is_some()
                    || request.mission_id.is_some(),
                pending_diff: std::sync::Mutex::new(None),
                pending_question: std::sync::Mutex::new(None),
                pending_permission: std::sync::Mutex::new(None),
                trust: permission::TrustMemory::default(),
            },
        );
    }

    // Register only after the live handle exists, so an accepted coordination
    // identity always has a cancellable process owner. Registration failing
    // (an unreadable journal, a parent that never registered) costs this Run
    // its coordination Tools for the session, not the Run itself.
    let supervisor_impl = TauriSupervisor::new(app.clone());
    if let Err(error) = register_coordination_run(&supervisor_impl, &request, &id) {
        eprintln!("klide: run {id} is not coordination-addressable: {error}");
    }

    // Detach the loop so this command returns the run id immediately; the UI
    // follows progress through the event channel and can abort via the token.
    let supervisor: Arc<dyn RunSupervisor> = Arc::new(supervisor_impl);
    let mission_app = app.clone();
    let task_id = id.clone();
    tauri::async_runtime::spawn(async move {
        let result = run_agent_loop(
            supervisor,
            runs_dir,
            task_id.clone(),
            request,
            on_event,
            cancel,
            RealProviderCaller,
        )
        .await;
        if let Some((root, mission_id, mission_task_id)) = mission_link {
            if let Err(err) = crate::missions::record_linked_attempt_validation(
                &mission_app,
                &root,
                &mission_id,
                &mission_task_id,
                &task_id,
            ) {
                eprintln!("mission attempt {task_id} validation failed: {err}");
            }
        }
        if let Err(err) = &result {
            eprintln!("agent run {task_id} failed: {err}");
        }
        // Signal completion last, after mission write-back, so a waiting parent
        // never observes a child as settled before its validation landed.
        if let Some(done) = done {
            let _ = done.send(result);
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
    // Alternate/headless hosts enter through the loop directly in tests and
    // future background runners. The production start path already registered
    // before detaching; the journal command is idempotent there. Like every
    // other coordination step, failure is logged and the Run goes on.
    if let Err(error) = register_coordination_run(sup, &request, &id) {
        eprintln!("klide: run {id} is not coordination-addressable: {error}");
    }
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
    // A wake turn: no words from the user, started by the panel so the Run
    // reads what another agent left for it once its user let that in. There
    // is no user message to record or to send — the accepted inbox is the
    // turn's input — and the thread keeps the title it had.
    let wake = resuming && request.initial_text.trim().is_empty() && request.attachments.is_empty();

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
        title: if wake {
            transcripts::read_summary(&runs_dir, &id)
                .map(|prior| prior.title)
                .unwrap_or_else(|_| title_from_text(""))
        } else {
            title_from_text(&request.initial_text)
        },
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
        if let Some(routed) = request.routed.clone() {
            emit(AgentEvent::RouteResolved {
                run_id: id.clone(),
                provider: request.provider.clone(),
                model: request.model.clone(),
                reason: routed.reason,
                skipped: routed.skipped,
                ts: now_ms(),
            })?;
        }
        emit(AgentEvent::ContextSnapshot {
            run_id: id.clone(),
            snapshot: snapshot_for(&request),
            ts: now_ms(),
        })?;
    }
    if !wake {
        emit(AgentEvent::UserMessage {
            run_id: id.clone(),
            message_id: message_id("user"),
            text: request.initial_text.clone(),
            attachments: request.attachments.clone(),
            ts: now_ms(),
        })?;
    }

    let system = base_system_prompt(&request);
    let mut messages = provider_messages(&request, system, &id);
    if wake {
        // provider_messages ended with the (empty) user turn; the inbox
        // injected at the boundary below is this turn's user-role input.
        messages.pop();
    }
    // When this run id was used before, the on-disk transcript holds the
    // whole prior conversation. Replay it into `messages` between the
    // system prompt and the new user turn, so the model sees the same
    // context the user does on screen. Without this, every follow-up
    // turn would arrive as a fresh chat — the "agent has no memory"
    // bug the user kept hitting.
    let tools = schemas_for_mode(
        &request.mode,
        &request.disabled_tools,
        request.workspace_root.as_deref(),
    );
    // Retention only makes sense while the model can actually peek the
    // stored value back: without `peek_value` in this run's tool list, a
    // stub would be a dead end, so results ride in context verbatim and
    // replay carries prior results in full too.
    let retention_enabled = tools::tools_include(&tools, "peek_value");
    if resuming {
        // See ProviderCaps::structured_replay: Ollama's native `/api/chat` is
        // the lone provider that needs the text-fold workaround; every
        // OpenAI-wire provider gets the faithful structured replay.
        let structured_replay = ProviderCaps::for_provider(&request.provider).structured_replay;
        let values = retention_enabled.then(|| (runs_dir.as_path(), id.as_str()));
        let prior = reconstruct_prior_messages(&prior_events, structured_replay, values);
        // `provider_messages` always returns `[..., user]` with the new
        // turn at the tail. Pop it, splice the history in, push it back.
        if let Some(new_user) = messages.pop() {
            messages.extend(prior);
            messages.push(new_user);
        }
    }
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

    // Mid-run loop monitor: watches recent tool-call signatures and, when the
    // model gets stuck repeating the same call, injects a one-time steering
    // nudge into the next turn's context. See `steering.rs`.
    let mut loop_monitor = steering::LoopMonitor::default();

    // A reasoning model can burn its whole reply budget inside the private
    // reasoning channel and return a *successful* turn with no answer and no
    // tool call. Resampling at a smaller budget usually recovers it — an
    // instruction to be brief only lands if there is room left to be brief in.
    // Bounded, because a model that does this twice is not going to stop.
    const MAX_RUNAWAY_RESAMPLES: usize = 2;
    let mut runaway_resamples = 0usize;
    // Reduced for the turn after a runaway. `None` means "whatever the request
    // asked for".
    let mut reply_budget_override: Option<usize> = None;

    // Turn-cap endgame. Reaching `max_turns` used to be a cliff: the run spent
    // its last turn starting new work, ended on a tool result, and handed back
    // an apology instead of the work. Two steps spend the tail of the budget
    // finishing instead — a nudge to wrap up, then a turn with no tools at all,
    // which is the floor: the only reply the model can produce is a written one.
    const RESERVE_TURNS: usize = 3;
    // Withholding tools is only meaningful once the run has had a tool-enabled
    // turn. At `max_turns == 1` it would mean a run that can never call a tool.
    let forced_answer_turn = (max_turns >= 2).then(|| max_turns - 1);
    // Skipped when the reserve would land on the first turn (nothing to wrap up
    // yet) or on the forced turn itself, which carries its own firmer wording.
    let finalization_turn = max_turns
        .checked_sub(RESERVE_TURNS)
        .filter(|t| *t >= 1 && Some(*t) != forced_answer_turn);

    for turn in 0..max_turns {
        // Auto-compaction: trim verbose tool results from older turns once the
        // prompt approaches the context window. The recency window inside
        // `compact_old_tool_results` keeps the active working set verbatim.
        if estimate_prompt_tokens(&messages) > compact_threshold {
            compact_old_tool_results(&mut messages);
        }

        // Both steps ride the existing steering seam: a system message the model
        // sees, plus a `SteeringInjected` marker so the transcript says why the
        // run changed shape near its cap rather than appearing to just stop.
        if Some(turn) == finalization_turn {
            messages.push(steering::steering_system_message(steering::FINALIZATION_RESERVE_NUDGE));
            emit(AgentEvent::SteeringInjected {
                run_id: id.clone(),
                reason: format!(
                    "Finalization reserve — {} of {max_turns} tool turns left",
                    max_turns - turn
                ),
                ts: now_ms(),
            })?;
        }
        let turn_tools = if Some(turn) == forced_answer_turn {
            messages.push(steering::steering_system_message(steering::LAST_TURN_NUDGE));
            emit(AgentEvent::SteeringInjected {
                run_id: id.clone(),
                reason: format!("Last of {max_turns} tool turns — answering without tools"),
                ts: now_ms(),
            })?;
            None
        } else {
            tools.clone()
        };
        let assistant_id = message_id("assistant");
        let stream_run_id = id.clone();
        let stream_assistant_id = assistant_id.clone();
        let stream_channel = event_channel.clone();
        // Time to first token, captured where it actually happens: the first
        // streamed chunk of this turn. 0 means "no delta yet" (a non-streaming
        // turn keeps it at 0 and reports no TTFT).
        let first_token_ms = std::sync::Arc::new(std::sync::atomic::AtomicI64::new(0));
        let stream_first_token = first_token_ms.clone();
        let stream = Channel::<StreamChunk>::new(move |body| {
            if let Ok(chunk) = body.deserialize::<StreamChunk>() {
                // A delegate CLI reporting work it already did. Forwarded as a
                // distinct event, never as a ToolCallStarted: Klide did not
                // dispatch it, no capability applied, and no permission or diff
                // gate ran. It is shown so the conversation is honest about what
                // happened, and kept separate so nothing downstream mistakes it
                // for work this harness authorized.
                if let Some(observed) = chunk.observed {
                    // Counts as first output: a delegate that reads three files
                    // before speaking started working immediately, and timing
                    // TTFT to its first word reported the entire tool phase as
                    // dead air. Harness runs are unaffected — a dispatched tool
                    // call can only follow the model's own response, so their
                    // first chunk is still a token.
                    let _ = stream_first_token.compare_exchange(
                        0,
                        now_ms(),
                        std::sync::atomic::Ordering::Relaxed,
                        std::sync::atomic::Ordering::Relaxed,
                    );
                    let _ = stream_channel.send(match observed {
                        crate::providers::ObservedToolActivity::Call {
                            id,
                            provider,
                            name,
                            input,
                            summary,
                        } => AgentEvent::ObservedToolCall {
                            run_id: stream_run_id.clone(),
                            tool_call_id: id,
                            provider,
                            name,
                            input,
                            summary,
                            ts: now_ms(),
                        },
                        crate::providers::ObservedToolActivity::Result { id, ok, content } => {
                            AgentEvent::ObservedToolResult {
                                run_id: stream_run_id.clone(),
                                tool_call_id: id,
                                ok,
                                content,
                                ts: now_ms(),
                            }
                        }
                    });
                    return Ok(());
                }
                let _ = stream_first_token.compare_exchange(
                    0,
                    now_ms(),
                    std::sync::atomic::Ordering::Relaxed,
                    std::sync::atomic::Ordering::Relaxed,
                );
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
        // sees the latest task state (tools may have modified it). MLX appends
        // changed snapshots to preserve its processed prefix; local Chat stays
        // free of project TODO context, as it is in provider_messages.
        let caps = ProviderCaps::for_provider(&request.provider);
        if !(caps.minimal_chat_context && matches!(request.mode, AgentMode::Chat)) {
            if let Some(cwd) = &request.workspace_root {
                let todo_text = todo::list_todos_text(cwd, &id);
                refresh_todo_context(
                    &mut messages,
                    todo_text.as_deref(),
                    caps.append_todo_updates,
                );
            }
        }

        // Native coordination delivery has one safe boundary: after the prior
        // turn and its Tools fully settled, immediately before the next
        // provider request. Never splice an envelope into a live stream or
        // Tool execution. Delivered-but-unacknowledged entries are retried if
        // the provider call fails before consuming them.
        //
        // Coordination is a convenience layered on the Run, not a dependency
        // of it: if the shared journal cannot be read, this turn simply gets no
        // inbox. Failing the Run here would let one bad file stop every agent
        // in the Workspace, including ones that never message anyone.
        //
        // Before anything is loaded, whatever other agents queued for this Run
        // goes past its user: the receiving side reviews, the sender never
        // does. A refusal here is a cancelled run, not a skipped review.
        let coordination_inbox = match coordination_workspace_for(&request) {
            Some(root) => {
                let ctx = ToolCtx {
                    sup,
                    id: id.as_str(),
                    request: &request,
                    cancel: &cancel,
                    runs_dir: runs_dir.as_path(),
                };
                match review_coordination_inbox(&ctx, root, &mut emit).await {
                    Ok(true) => {
                        finish_cancelled(&mut emit, sup, &runs_dir, &id, &summary, message_count)?;
                        return Ok(());
                    }
                    Ok(false) => {}
                    Err(error) => {
                        eprintln!("klide: run {id} skipped coordination review this turn: {error}");
                    }
                }
                load_coordination_inbox(sup, root, &id).unwrap_or_else(|error| {
                    eprintln!("klide: run {id} skipped coordination delivery this turn: {error}");
                    Vec::new()
                })
            }
            None => Vec::new(),
        };
        if !coordination_inbox.is_empty() {
            messages.push(coordination_provider_message(&coordination_inbox));
            emit(AgentEvent::SteeringInjected {
                run_id: id.clone(),
                reason: coordination_delivery_reason(&coordination_inbox),
                ts: now_ms(),
            })?;
        } else if wake && message_count == 0 {
            // Woken for a message that is no longer there (declined, or read
            // by a turn that got in first). The provider still needs a user
            // turn to answer; keep the answer short.
            messages.push(user_provider_message(
                "[Agent messages] Nothing is waiting for you after all. Reply in one short sentence.",
                &[],
            ));
        }

        // A delegate's allowlist reads the fingerprint-scoped approval store —
        // git processes — so it is resolved off the runtime before the race.
        let allowed_commands = {
            let provider = request.provider.clone();
            let dir = runs_dir.clone();
            let root = request.workspace_root.clone();
            crate::blocking::run(move || {
                Ok(delegate_allowed_commands(&provider, &dir, root.as_deref()))
            })
            .await
            .unwrap_or_default()
        };
        // A Delegate conversation gets Klide's MCP server for this turn, so a
        // Focus thread on Claude Code can address its peers too. Only where
        // the Run itself is registered (Plan/Goal with a Workspace); the
        // Harness already owns the Run's state, and the bridge binding is
        // idempotent per turn.
        let mcp = sup.delegate_mcp_wiring(
            &id,
            &request.provider,
            coordination_workspace_for(&request),
        );

        // Race the provider stream against user cancellation so abort takes
        // effect mid-request, not only between turns.
        let request_started_ms = now_ms();
        let provider_result = tokio::select! {
            _ = cancel.cancelled() => {
                finish_cancelled(&mut emit, sup, &runs_dir, &id, &summary, message_count)?;
                return Ok(());
            }
            result = provider_caller.call(ProviderTurnRequest {
                provider: request.provider.clone(),
                model: request.model.clone(),
                messages: messages.clone(),
                tools: turn_tools.clone(),
                workspace_root: request.workspace_root.clone(),
                run_id: Some(id.clone()),
                allowed_commands,
                mcp,
                num_ctx: request.num_ctx,
                num_predict: reply_budget_override.or(request.num_predict),
                reflection_level: request.reflection_level.clone(),
                stream,
            }) => result,
        };
        if provider_result.is_ok() && !coordination_inbox.is_empty() {
            if let Some(root) = coordination_workspace_for(&request) {
                // A failed acknowledgement leaves the entries `delivered`, so
                // the next boundary offers them again. Duplicated delivery is
                // the safe side of this error; a dead Run is not.
                if let Err(error) =
                    acknowledge_coordination_inbox(sup, root, &id, &coordination_inbox)
                {
                    eprintln!(
                        "klide: run {id} could not acknowledge coordination delivery: {error}"
                    );
                }
            }
        }
        let response = match provider_result {
            Ok(response) => response,
            Err(err) => {
                let error = AgentError {
                    code: error_code::PROVIDER_UNAVAILABLE.to_string(),
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

        // The provider call is over — close the timing window here, not at the
        // event's `ts`. Everything after this point (tool execution, waiting on
        // a diff review) belongs to the run, not to the model.
        let turn_timing = Some(AgentTurnTiming {
            model_ms: (now_ms() - request_started_ms).max(0) as u64,
            ttft_ms: match first_token_ms.load(std::sync::atomic::Ordering::Relaxed) {
                0 => None,
                at => Some((at - request_started_ms).max(0) as u64),
            },
        });

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
            TurnDecision::Runaway { .. } if runaway_resamples < MAX_RUNAWAY_RESAMPLES => {
                runaway_resamples += 1;
                // Drop the empty assistant turn: it carries no answer and no
                // call, and leaving it in history invites the model to continue
                // from its own silence. The nudge is transient for the same
                // reason — guidance for the resample, not part of the thread.
                messages.pop();
                // Half the room it just failed to finish in, floored so there is
                // still space to answer. Derived from the budget actually in
                // force so a deliberately small `num_predict` is never raised.
                let previous = reply_budget_override
                    .or(request.num_predict)
                    .or_else(|| {
                        turn_usage
                            .as_ref()
                            .and_then(|u| u.completion_tokens)
                            .map(|t| t as usize)
                    })
                    .unwrap_or(4096);
                reply_budget_override = Some((previous / 2).max(512));
                messages.push(steering::steering_system_message(
                    steering::REASONING_RUNAWAY_NUDGE,
                ));
                emit(AgentEvent::SteeringInjected {
                    run_id: id.clone(),
                    reason: format!(
                        "Reply budget spent on reasoning with no answer — resampling at {} tokens",
                        reply_budget_override.unwrap_or_default()
                    ),
                    ts: now_ms(),
                })?;
                continue;
            }
            // Either a normal answer, or a runaway whose resamples are spent —
            // in which case `decide_turn` has already attached the notice that
            // explains the empty reply. A run that cannot get a word out is
            // finished, not retryable.
            TurnDecision::Final { content } | TurnDecision::Runaway { content } => {
                emit(AgentEvent::AssistantMessage {
                    run_id: id.clone(),
                    message_id: assistant_id,
                    content,
                    usage: turn_usage,
                    timing: turn_timing,
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
                    timing: turn_timing,
                    ts: now_ms(),
                })?;
                tool_calls
            }
        };

        // Collect each call's signature + whether it failed as it executes, so
        // the loop monitor (below, once the turn settles) can see both plain
        // repetition and repeated failures. Filled in the per-call loop.
        let mut turn_observations: Vec<steering::CallObservation> = Vec::new();

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
                capability: kind.map(|k| k.capability().wire().to_string()),
                ts: now_ms(),
            })?;

            let kind = match plan_tool_step(&request.mode, &call, kind) {
                ToolStepPlan::Execute { kind } => kind,
                ToolStepPlan::Blocked { result } => {
                    turn_observations.push(steering::CallObservation {
                        signature: steering::call_signature(&call),
                        failed: !result.ok,
                    });
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
                // Pause dispatch reads the registry's flavor, never a name
                // literal — tool identity is registry data.
                Some(ToolKind::Pause) => match tools::pause_flavor(&call.name) {
                    Some(tools::PauseFlavor::Subagent) => {
                        process_subagent_tool(&ctx, &call, &mut emit).await?
                    }
                    Some(tools::PauseFlavor::Advisor) => {
                        process_advisor_tool(&ctx, &call, &mut emit).await?
                    }
                    _ => process_pause_tool(&ctx, &call, &mut emit).await?,
                },
                Some(ToolKind::Command) => process_command_tool(&ctx, &call, &mut emit).await?,
                Some(ToolKind::Network) => process_network_tool(&ctx, &call, &mut emit).await?,
                Some(ToolKind::Write) => process_write_tool(&ctx, &call, &mut emit).await?,
                Some(ToolKind::Coordination) => {
                    process_coordination_tool(&ctx, &call, &mut emit).await?
                }
                // Non-mutating tools: serve workspace reads from the parallel
                // batch when present; otherwise execute inline. Conversation
                // history uses the same registry executor but also receives
                // the app-owned Run store below.
                _ => ToolOutcome::Produced(match request.workspace_root.as_deref() {
                    Some(root) => match precomputed.remove(&call.id) {
                        Some(result) => result,
                        // A grep over 6 000 files or a `git status` shell-out
                        // must not hold this tokio worker — other Runs stream
                        // on the same pool. The executor stays a sync fn (the
                        // interface its tests and eval.rs use); only the door
                        // is async (blocking.rs).
                        None => {
                            let root = root.to_string();
                            let call = call.clone();
                            let run_id = id.clone();
                            let dir = runs_dir.clone();
                            match crate::blocking::run(move || {
                                Ok(execute_read_only_tool_with_runs_dir(
                                    &root,
                                    &call,
                                    &run_id,
                                    dir.as_path(),
                                ))
                            })
                            .await
                            {
                                Ok(result) => result,
                                Err(e) => ToolResult {
                                    ok: false,
                                    content: format!("Error: {e}"),
                                    metadata: None,
                                },
                            }
                        }
                    },
                    None => no_workspace_result(),
                }),
            };
            let tool_result: ToolResult = match outcome {
                ToolOutcome::Produced(result) => result,
                ToolOutcome::Cancelled => {
                    finish_cancelled(&mut emit, sup, &runs_dir, &id, &summary, message_count)?;
                    return Ok(());
                }
            };
            turn_observations.push(steering::CallObservation {
                signature: steering::call_signature(&call),
                failed: !tool_result.ok,
            });

            emit(AgentEvent::ToolCallFinished {
                run_id: id.clone(),
                tool_call_id: call.id.clone(),
                result: tool_result.clone(),
                ts: now_ms(),
            })?;
            // The transcript (event above) keeps the full result; the provider
            // carries a stub when the result is large enough to retain. The
            // full text stays addressable through `peek_value` — which is why
            // retention only runs when this run's tool list offers that tool.
            let mut provider_result = tool_result.clone();
            if retention_enabled {
                if let Some(stub) = retained::retain_large_result(
                    runs_dir.as_path(),
                    &id,
                    &call.id,
                    &call.name,
                    &tool_result.content,
                ) {
                    provider_result.content = stub;
                }
            }
            messages.push(tool_provider_message(&call, &provider_result));

            apply_clean_context_if_requested(&call, &mut messages);
        }

        // The turn has settled: ask the loop monitor whether the run is stuck
        // (repeating a call, repeating a *failing* call, or past the give-up
        // cap). Any nudge is pushed only now, after this turn's tool results are
        // in `messages` — an assistant `tool_calls` turn must be followed
        // immediately by its `tool` replies on OpenAI-wire providers, so a system
        // message can't slip in between. Cheap and debounced, so it won't spam a
        // healthy run. The paired event records the intervention in the transcript.
        let steer_outcome = loop_monitor.observe(turn_observations);

        // Circuit breaker: the same call has failed past the run cap even after
        // steering. End the run honestly rather than burn to the turn limit.
        if let Some(steering::Outcome::GiveUp(reason)) = &steer_outcome {
            emit(AgentEvent::SteeringInjected {
                run_id: id.clone(),
                reason: reason.clone(),
                ts: now_ms(),
            })?;
            emit(AgentEvent::AssistantMessage {
                run_id: id.clone(),
                message_id: message_id("assistant"),
                content: vec![AgentContentBlock::Text {
                    text: format!(
                        "I'm stuck: {reason}. Rather than repeat the same failing step, I've \
                         stopped here so you can take a look — send another message with more \
                         direction and I'll continue from this point."
                    ),
                }],
                usage: None,
                // Harness-authored, no provider call to time.
                timing: None,
                ts: now_ms(),
            })?;
            message_count += 1;
            emit(AgentEvent::RunError {
                run_id: id.clone(),
                error: AgentError {
                    code: error_code::STEERING_GAVE_UP.to_string(),
                    message: reason.clone(),
                    detail: None,
                    retryable: true,
                },
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

        if let Some(steering::Outcome::Steer(hint)) = steer_outcome {
            // A plain repetition loop gets a nudge; a repeated *failure* loop is
            // escalated — auto-consult a stronger advisor and inject its guidance
            // (falling back to the nudge if no advisor is available). The
            // `SteeringInjected` marker is emitted *after* the outcome is known so
            // its reason can name what actually happened.
            if hint.escalate {
                let error = last_tool_output(&messages)
                    .unwrap_or_else(|| "(no tool output captured)".to_string());
                let question = format!(
                    "You are advising a coding agent that is stuck in a loop. {}. The most recent \
                     tool result was:\n\n{}\n\nWhat is the underlying problem, and what concretely \
                     different action should the agent take next? Give specific, actionable guidance.",
                    hint.reason, error
                );
                let request_id = format!("adv_{id}_steer_{turn}");
                let reason =
                    match steer_via_advisor(sup, &id, request_id, question, &cancel, &mut emit)
                        .await?
                    {
                        AdvisorSteer::Cancelled => {
                            finish_cancelled(
                                &mut emit,
                                sup,
                                &runs_dir,
                                &id,
                                &summary,
                                message_count,
                            )?;
                            return Ok(());
                        }
                        AdvisorSteer::Advice(advice) => {
                            messages.push(steering::advisor_steering_message(&advice));
                            format!(
                                "{} — consulted advisor: {}",
                                hint.reason,
                                steering::preview(&advice)
                            )
                        }
                        AdvisorSteer::FallbackNudge => {
                            messages.push(steering::steering_system_message(&hint.nudge));
                            format!("{} — no advisor available, nudged", hint.reason)
                        }
                    };
                emit(AgentEvent::SteeringInjected {
                    run_id: id.clone(),
                    reason,
                    ts: now_ms(),
                })?;
            } else {
                emit(AgentEvent::SteeringInjected {
                    run_id: id.clone(),
                    reason: hint.reason.clone(),
                    ts: now_ms(),
                })?;
                messages.push(steering::steering_system_message(&hint.nudge));
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
                    "I reached the tool-turn limit ({max_turns}) before finishing this request. \
                     The work above is where I got to — send another message to have me continue from here, \
                     or raise \"Max tool turns\" in Settings → Harness for big tasks."
                ),
            }],
            usage: None,
            // Harness-authored, no provider call to time.
            timing: None,
            ts: now_ms(),
        })?;
        message_count += 1;
        let error = AgentError {
            code: error_code::MAX_TURNS.to_string(),
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

/// The Provider/model each of these Conversations actually started on.
///
/// Ids with no Transcript, or whose Transcript names no origin, are simply
/// absent from the result — the caller is repairing labels against evidence,
/// and no evidence means leave the label alone.
///
/// Bounded by the caller's id list and reads only each transcript's head, so
/// this stays cheap enough to run at boot over the whole Conversation index.
#[tauri::command]
pub async fn agent_run_origins(
    app: tauri::AppHandle,
    run_ids: Vec<String>,
) -> Result<Vec<RunOrigin>, String> {
    let runs_dir = app_runs_dir(&app)?;
    // Transcript reads are blocking file IO; a boot-time sweep of them must not
    // sit on the async runtime and stall every other pending invoke().
    tokio::task::spawn_blocking(move || {
        let mut origins = Vec::new();
        for run_id in run_ids {
            // A malformed id is not this command's business to report: it
            // cannot name a transcript, so it has no origin.
            if validate_run_id(&run_id).is_err() {
                continue;
            }
            match read_run_origin(&runs_dir, &run_id) {
                Ok(Some(origin)) => origins.push(origin),
                Ok(None) => {}
                // One unreadable transcript must not cost the whole sweep the
                // other ids' answers.
                Err(e) => eprintln!("klide: no origin for run {run_id}: {e}"),
            }
        }
        origins
    })
    .await
    .map_err(|e| format!("Run origin scan failed: {e}"))
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
        .map(|(id, handle)| (id.clone(), handle.status))
        .collect::<HashMap<_, _>>();
    // Every summary.json is read before `limit` applies — off the runtime
    // thread, like the Delegate scan next door in lib.rs.
    let scan_dir = runs_dir.clone();
    let mut summaries =
        crate::blocking::run(move || list_summaries(&scan_dir, limit, offset)).await?;
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
        // Same filler the Delegate board uses, so the two cannot drift.
        crate::delegate::fill_worktree_evidence(
            &mut summary.worktree,
            summary.cwd.as_deref(),
        );
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AcceptCheckpointsResult {
    accepted: usize,
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

/// Accept every checkpoint currently attached to `run_id`: keep the files as
/// they are and consume only their rollback snapshots. Follow-up turns reuse
/// the conversation id, so this establishes a real boundary — a later
/// "revert run" cannot undo edits the user already accepted.
pub(crate) fn accept_all_checkpoints_at(
    runs_dir: &Path,
    run_id: &str,
) -> Result<AcceptCheckpointsResult, String> {
    let entries = list_checkpoints_at(runs_dir, run_id)?;
    let mut accepted = 0usize;
    for entry in entries {
        let file = checkpoint_file(runs_dir, run_id, &entry.tool_call_id);
        std::fs::remove_file(&file)
            .map_err(|e| format!("Cannot accept checkpoint {}: {e}", entry.tool_call_id))?;
        accepted += 1;
    }
    Ok(AcceptCheckpointsResult { accepted })
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

#[tauri::command]
pub async fn agent_accept_run_checkpoints(
    app: tauri::AppHandle,
    run_id: String,
) -> Result<AcceptCheckpointsResult, String> {
    validate_run_id(&run_id)?;
    let runs_dir = app_runs_dir(&app)?;
    accept_all_checkpoints_at(&runs_dir, &run_id)
}

#[cfg(test)]
mod worktree_commit_tests {
    //! `commit_worktree_on_done` runs `git add -A && git commit` when a run
    //! settles, so its guard is load-bearing in the strongest sense: if
    //! `worktree_label` ever stopped distinguishing a linked worktree from the
    //! user's own checkout, every finished Klide run would commit whatever was
    //! in Pierre's working tree. That guard had no test.

    use super::*;

    fn git(cwd: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(cwd)
            .args(args)
            .output()
            .expect("run git");
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A repo with one commit on `main`, plus a linked worktree on `klide/work`.
    fn repo_with_worktree(name: &str) -> (PathBuf, PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("klide-agent-commit-{name}"));
        let _ = std::fs::remove_dir_all(&base);
        let main = base.join("repo");
        std::fs::create_dir_all(&main).unwrap();
        git(&main, &["init", "-b", "main"]);
        git(&main, &["config", "user.email", "test@klide.local"]);
        git(&main, &["config", "user.name", "Klide Test"]);
        std::fs::write(main.join("a.txt"), "hi\n").unwrap();
        git(&main, &["add", "."]);
        git(&main, &["commit", "-m", "init"]);

        let wt = base.join("repo-worktrees").join("work");
        git(
            &main,
            &[
                "worktree",
                "add",
                "-b",
                "klide/work",
                wt.to_str().unwrap(),
                "main",
            ],
        );
        (base, main, wt)
    }

    fn summary(cwd: &Path, title: &str) -> AgentRunSummary {
        AgentRunSummary {
            id: "run-1".into(),
            path: String::new(),
            source: "klide".into(),
            title: title.into(),
            status: "done".into(),
            provider: "ollama".into(),
            model: "qwen2.5:7b".into(),
            cwd: Some(cwd.to_str().unwrap().to_string()),
            project: None,
            git_branch: None,
            created_ms: 0,
            updated_ms: 0,
            message_count: 0,
            input_tokens: 0,
            output_tokens: 0,
            files_touched: 0,
            cost_usd: None,
            last_event: None,
            worktree: None,
            validation: None,
            parent_id: None,
        }
    }

    #[test]
    fn commits_a_dirty_linked_worktree_onto_its_branch() {
        let (_base, _main, wt) = repo_with_worktree("dirty-worktree");
        std::fs::write(wt.join("b.txt"), "agent wrote this\n").unwrap();

        commit_worktree_on_done(&summary(&wt, "Add the b file"));

        assert_eq!(git(&wt, &["status", "--porcelain"]), "", "tree is clean");
        let log = git(&wt, &["log", "-1", "--format=%s%n%b"]);
        assert!(log.contains("klide: Add the b file"), "got: {log}");
        assert!(log.contains("Klide agent run run-1"), "got: {log}");
        assert!(log.contains("Co-Authored-By: qwen2.5:7b"), "got: {log}");
        // Untracked files are included — `add -A` is what makes a race winner
        // mergeable, since headless runs apply edits without staging them.
        assert_eq!(git(&wt, &["log", "--oneline"]).lines().count(), 2);
    }

    #[test]
    fn never_commits_in_the_users_own_checkout() {
        // The guard. `worktree_label` returns None for a main working copy, so
        // a normal Klide run in Pierre's repo must leave his uncommitted work
        // exactly where it is.
        let (_base, main, _wt) = repo_with_worktree("main-checkout");
        std::fs::write(main.join("wip.txt"), "half-finished\n").unwrap();
        let before = git(&main, &["rev-parse", "HEAD"]);

        commit_worktree_on_done(&summary(&main, "Should not commit"));

        assert_eq!(git(&main, &["rev-parse", "HEAD"]), before, "no new commit");
        assert!(
            git(&main, &["status", "--porcelain"]).contains("wip.txt"),
            "the user's work is still uncommitted"
        );
    }

    #[test]
    fn a_clean_worktree_and_a_missing_cwd_are_both_no_ops() {
        let (_base, _main, wt) = repo_with_worktree("clean-worktree");
        let before = git(&wt, &["rev-parse", "HEAD"]);

        commit_worktree_on_done(&summary(&wt, "Nothing changed"));
        assert_eq!(git(&wt, &["rev-parse", "HEAD"]), before, "no empty commit");

        // A run with no cwd (or one outside a repo) must not panic or shell out
        // against the process's own working directory.
        let mut no_cwd = summary(&wt, "No cwd");
        no_cwd.cwd = None;
        commit_worktree_on_done(&no_cwd);
        assert_eq!(git(&wt, &["rev-parse", "HEAD"]), before);
    }
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

    /// Test shorthand: replay with no retained-value store. Without value
    /// files on disk every result folds back in full; retention-specific
    /// tests build a store and call `reconstruct_prior_messages` directly.
    fn reconstruct(prior_events: &[AgentEvent], structured: bool) -> Vec<serde_json::Value> {
        reconstruct_prior_messages(prior_events, structured, None)
    }

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
            timing: None,
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
            timing: None,
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
        assert!(reconstruct(&[], false).is_empty());
    }

    #[test]
    fn user_message_becomes_user_role() {
        let out = reconstruct(&[user_msg("hello")], false);
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
        let out = reconstruct(
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
        let out = reconstruct(&[assistant_text("hi back")], false);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["role"], "assistant");
        assert_eq!(out[0]["content"], "hi back");
        // No `tool_calls` array — the replay never emits the OpenAI
        // shape that Ollama's chat API rejects.
        assert!(out[0].get("tool_calls").is_none());
    }

    #[test]
    fn a_large_prior_tool_result_replays_as_its_retained_stub_in_both_shapes() {
        // Mirrors the live loop: a result big enough to have been retained —
        // and whose value file is on disk — must fold back in as the same
        // [retained #id] stub, never as the full text — otherwise one resume
        // re-poisons the context the retention just saved.
        let big = "x".repeat(30_000);
        let runs_dir = std::env::temp_dir().join(format!(
            "klide-replay-retained-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&runs_dir);
        std::fs::create_dir_all(&runs_dir).unwrap();
        retained::retain_large_result(&runs_dir, "r", "tc1", "read_file", &big)
            .expect("fixture value stored");
        let values = Some((runs_dir.as_path(), "r"));
        let events = [
            user_msg("run the tests"),
            assistant_with_tool_call(),
            tool_result("tc1", &big),
            assistant_text("done"),
        ];

        let folded = reconstruct_prior_messages(&events, false, values);
        let last = folded.last().unwrap()["content"].as_str().unwrap();
        assert!(last.contains("[retained #tc1]"), "text-fold stub missing");
        assert!(last.len() < 10_000, "full text leaked into the text fold");
        // The fold learned the tool's real name from the assistant turn, so
        // the stub reads exactly as the live loop wrote it.
        assert!(last.contains("read_file returned"), "stub must name the tool: {last}");

        let structured = reconstruct_prior_messages(&events, true, values);
        let tool_msg = structured
            .iter()
            .find(|m| m["role"] == "tool")
            .expect("structured replay keeps the tool message");
        let content = tool_msg["content"].as_str().unwrap();
        assert!(content.contains("[retained #tc1]"), "structured stub missing");
        assert!(content.len() < 10_000, "full text leaked into structured replay");
        assert_eq!(
            last.contains("read_file returned"),
            content.contains("read_file returned"),
            "both shapes carry the same stub text"
        );
        let _ = std::fs::remove_dir_all(&runs_dir);
    }

    #[test]
    fn a_large_prior_result_without_a_value_file_replays_in_full() {
        // If the live write failed, the model saw the full text that turn —
        // a resume must carry the full text too, never a stub pointing at a
        // value peek_value can't read.
        let big = "x".repeat(30_000);
        let runs_dir = std::env::temp_dir().join(format!(
            "klide-replay-unretained-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&runs_dir).unwrap();
        let values = Some((runs_dir.as_path(), "r"));
        let events = [
            user_msg("run the tests"),
            assistant_with_tool_call(),
            tool_result("tc1", &big),
            assistant_text("done"),
        ];

        let folded = reconstruct_prior_messages(&events, false, values);
        let last = folded.last().unwrap()["content"].as_str().unwrap();
        assert!(!last.contains("[retained #tc1]"), "no file → no stub");
        assert!(last.len() > 30_000, "full text must ride along");

        let structured = reconstruct_prior_messages(&events, true, values);
        let tool_msg = structured
            .iter()
            .find(|m| m["role"] == "tool")
            .expect("structured replay keeps the tool message");
        assert_eq!(tool_msg["content"].as_str().unwrap(), big);
        let _ = std::fs::remove_dir_all(&runs_dir);
    }

    #[test]
    fn assistant_with_tool_call_drops_call_keeps_text() {
        // Tool calls are folded into the next assistant turn as
        // inline tool results, not surfaced as a structured array.
        let out = reconstruct(&[assistant_with_tool_call()], false);
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
        let out = reconstruct(
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
        let out = reconstruct(&events, false);
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
            reconstruct(&[user_msg("ping"), tool_result("tc1", "pong")], false);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["role"], "user");
    }

    #[test]
    fn tool_results_do_not_carry_across_user_turns() {
        // A buffered tool result from a previous turn must not leak
        // into the next user turn — the model shouldn't see a
        // tool result on the wrong side of a user message.
        let out = reconstruct(
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
        let out = reconstruct(&events, false);
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
        let out = reconstruct(
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
        let out = reconstruct(&[user_msg("go"), assistant_with_tool_call()], true);
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
        let out = reconstruct(
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

    /// Same `stop_reason`, opposite shapes: text present means the model was
    /// answering and got cut off; text absent means it never started.
    #[test]
    fn a_capped_reply_with_text_is_final_and_without_text_is_a_runaway() {
        let mut cut_off = response("Here is half an ans", None, vec![]);
        cut_off.stop_reason = Some("length".into());
        let TurnDecision::Final { content } = decide_turn(&cut_off, 0, 0).decision else {
            panic!("text present → the partial answer is worth keeping");
        };
        let text = block_text(&content);
        assert!(text.contains("Here is half an ans"));
        assert!(text.contains("context limit"), "points at num_ctx: {text}");

        let mut runaway = response("", Some("thinking and thinking"), vec![]);
        runaway.stop_reason = Some("length".into());
        let TurnDecision::Runaway { content } = decide_turn(&runaway, 0, 0).decision else {
            panic!("no visible text → the budget went to reasoning");
        };
        let text = block_text(&content);
        assert!(
            text.contains("Effort"),
            "points at the reply budget, not the context window: {text}"
        );
        assert!(
            !text.contains("context limit"),
            "and not at num_ctx, which is the wrong number to tune: {text}"
        );
    }

    /// The guard that keeps the runaway path off LFM2.5's legitimate shape: a
    /// complete answer routed through the reasoning channel, with the provider
    /// reporting a normal stop. Only an explicit cap makes it a runaway.
    #[test]
    fn an_answer_that_arrives_as_thinking_is_not_a_runaway() {
        let mut normal = response("", Some("The answer is 42."), vec![]);
        normal.stop_reason = Some("stop".into());
        assert!(matches!(
            decide_turn(&normal, 0, 0).decision,
            TurnDecision::Final { .. }
        ));
    }

    fn block_text(content: &[AgentContentBlock]) -> String {
        content
            .iter()
            .filter_map(|b| match b {
                AgentContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n")
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

    #[test]
    fn native_and_text_tool_calls_in_one_response_are_merged() {
        // klide-8b-style mix: one structured native call plus a second call
        // narrated as `<|tool_call_start|>` text in the same response. Both must
        // survive — the text one used to be dropped to raw output — and their
        // fallback ids must not collide.
        let content =
            "On it. <|tool_call_start|>[write_file(path='a.rs', content='x')]<|tool_call_end|>";
        let resp = response(
            content,
            None,
            vec![
                serde_json::json!({ "function": { "name": "read_file", "arguments": { "path": "b.rs" } } }),
            ],
        );
        let step = decide_turn(&resp, 0, 0);
        match step.decision {
            TurnDecision::Continue {
                tool_calls,
                content,
            } => {
                assert_eq!(tool_calls.len(), 2, "both calls kept");
                assert_eq!(tool_calls[0].name, "read_file");
                assert_eq!(tool_calls[1].name, "write_file");
                // Fallback ids are unique across the merged list.
                assert_eq!(tool_calls[0].id, "turn0_tool_0");
                assert_eq!(tool_calls[1].id, "turn0_tool_1");
                // The delimited tokens are stripped from the rendered text.
                assert!(content.iter().any(|b| matches!(
                    b,
                    AgentContentBlock::Text { text }
                        if text.contains("On it.") && !text.contains("tool_call_start")
                )));
            }
            _ => panic!("expected Continue"),
        }
        // Both calls replay to the model on the next turn.
        assert_eq!(
            step.assistant_message["tool_calls"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
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
                run_id: None,
                allowed_commands: Vec::new(),
                mcp: None,
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
        coordination: CoordinationStoreState,
    }

    impl FakeSupervisor {
        pub(super) fn with_run(id: &str) -> Self {
            let mut runs = HashMap::new();
            runs.insert(id.to_string(), make_handle());
            Self {
                runs: Mutex::new(runs),
                coordination: CoordinationStoreState::default(),
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
        fn coordination_apply(
            &self,
            workspace_root: &str,
            command: CoordinationCommand,
        ) -> Result<CoordinationCommandOutcome, String> {
            crate::coordination::apply_coordination_command(
                &self.coordination,
                workspace_root,
                command,
            )
        }
        fn coordination_snapshot(
            &self,
            workspace_root: &str,
        ) -> Result<CoordinationSnapshot, String> {
            crate::coordination::read_snapshot(&self.coordination, workspace_root)
        }
        fn retire_run(&self, run_id: &str) {
            if let Ok(mut runs) = self.runs.lock() {
                runs.remove(run_id);
            }
        }
    }

    pub(super) fn make_handle() -> AgentRunHandle {
        AgentRunHandle {
            status: AgentRunStatus::Running,
            cancel: CancellationToken::new(),
            coordination_workspace_root: None,
            coordination_is_terminal_run: false,
            pending_diff: Mutex::new(None),
            pending_question: Mutex::new(None),
            pending_permission: Mutex::new(None),
            trust: permission::TrustMemory::default(),
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
        pub(super) seen_messages: Arc<Mutex<Vec<Vec<serde_json::Value>>>>,
        /// Whether each turn was offered tool schemas. The turn-cap endgame
        /// withholds them on the final turn, and that is only observable here.
        pub(super) seen_tools: Arc<Mutex<Vec<bool>>>,
    }

    impl ScriptedProviderCaller {
        pub(super) fn new(turns: Vec<Result<AiChatResponse, String>>) -> Self {
            Self {
                script: Arc::new(Mutex::new(turns.into())),
                seen_roles: Arc::new(Mutex::new(Vec::new())),
                seen_messages: Arc::new(Mutex::new(Vec::new())),
                seen_tools: Arc::new(Mutex::new(Vec::new())),
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
            let seen_messages = self.seen_messages.clone();
            let seen_tools = self.seen_tools.clone();
            Box::pin(async move {
                seen_messages.lock().unwrap().push(request.messages.clone());
                seen_tools.lock().unwrap().push(request.tools.is_some());
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
                    Err(
                        "provider script exhausted — the loop ran more turns than scripted"
                            .to_string(),
                    )
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

    /// A turn that hit the reply cap with nothing visible to show for it —
    /// the whole budget went into the reasoning channel.
    pub(super) fn scripted_runaway() -> Result<AiChatResponse, String> {
        Ok(AiChatResponse {
            content: String::new(),
            thinking: Some("let me think about this at length".into()),
            tool_calls: vec![],
            usage: None,
            stop_reason: Some("length".into()),
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
        let mut request: StartRunRequest = serde_json::from_value(serde_json::json!({
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
        .unwrap();
        // Production deserialization deliberately ignores renderer-supplied
        // trust. Tests that exercise an already-classified run may still seed
        // the native request directly.
        request.command_allowlist = command_allowlist
            .iter()
            .map(|command| (*command).to_string())
            .collect();
        request
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

    /// Register two peers in a fresh journal and hand back the sandbox.
    fn coordination_sandbox(label: &str, sup: &FakeSupervisor) -> (std::path::PathBuf, String) {
        let root = std::env::temp_dir().join(format!(
            "klide-{label}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let root_text = root.to_string_lossy().to_string();
        for run_id in ["run_parent", "run_peer"] {
            sup.coordination_apply(
                &root_text,
                CoordinationCommand::RegisterRun {
                    registration: CoordinationRunRegistration {
                        run_id: run_id.to_string(),
                        worker_kind: CoordinationWorkerKind::Harness,
                        parent_run_id: None,
                        mission_id: None,
                        mission_task_id: None,
                        label: Some(format!("{run_id} thread")),
                    },
                    initial_state: Some(CoordinationRunState::Working),
                },
            )
            .unwrap();
        }
        (root, root_text)
    }

    fn unsolicited(sup: &FakeSupervisor, root_text: &str, key: &str, body: &str) -> String {
        sup.coordination_apply(
            root_text,
            CoordinationCommand::SendEnvelope {
                from: CoordinationActor::Run { run_id: "run_peer".to_string() },
                to_run_id: "run_parent".to_string(),
                kind: CoordinationEnvelopeKind::Question,
                body: body.to_string(),
                reply_to: None,
                correlation_id: None,
                idempotency_key: Some(key.to_string()),
                source_refs: vec![],
            },
        )
        .unwrap()
        .snapshot
        .envelopes
        .last()
        .unwrap()
        .envelope
        .id
        .clone()
    }

    fn state_of(sup: &FakeSupervisor, root_text: &str, id: &str) -> CoordinationDeliveryState {
        sup.coordination_snapshot(root_text)
            .unwrap()
            .envelopes
            .iter()
            .find(|entry| entry.envelope.id == id)
            .unwrap()
            .delivery_state
    }

    #[tokio::test]
    async fn incoming_messages_are_reviewed_by_the_receiving_side() {
        let sup = FakeSupervisor::with_run("run_parent");
        let (root, root_text) = coordination_sandbox("inbox-review", &sup);
        let request = test_request(&root_text, &[]);
        let cancel = CancellationToken::new();
        let ctx = ToolCtx {
            sup: &sup,
            id: "run_parent",
            request: &request,
            cancel: &cancel,
            runs_dir: root.as_path(),
        };
        let events = Arc::new(Mutex::new(Vec::<AgentEvent>::new()));
        let sink = events.clone();
        let mut emit = move |event: AgentEvent| -> Result<(), String> {
            sink.lock().unwrap().push(event);
            Ok(())
        };

        // Declined: never reaches the inbox, and the peer is refused for the run.
        let first = unsolicited(&sup, &root_text, "m1", "ping");
        assert_eq!(state_of(&sup, &root_text, &first), CoordinationDeliveryState::Queued);
        let (outcome, _) = tokio::join!(
            review_coordination_inbox(&ctx, &root_text, &mut emit),
            answer_permission(&sup, "run_parent", r#"{"behavior":"deny"}"#),
        );
        assert!(!outcome.unwrap(), "not cancelled");
        assert_eq!(state_of(&sup, &root_text, &first), CoordinationDeliveryState::Declined);
        let second = unsolicited(&sup, &root_text, "m2", "ping again");
        assert!(!review_coordination_inbox(&ctx, &root_text, &mut emit).await.unwrap());
        assert_eq!(state_of(&sup, &root_text, &second), CoordinationDeliveryState::Declined);
        assert!(crate::coordination::inbox_for(&sup.coordination_snapshot(&root_text).unwrap(), "run_parent").unwrap().is_empty());

        // A fresh run, welcomed for the run: one card, then the peer talks freely.
        let sup = FakeSupervisor::with_run("run_parent");
        let (root, root_text) = coordination_sandbox("inbox-review-ok", &sup);
        let request = test_request(&root_text, &[]);
        let ctx = ToolCtx {
            sup: &sup,
            id: "run_parent",
            request: &request,
            cancel: &cancel,
            runs_dir: root.as_path(),
        };
        let third = unsolicited(&sup, &root_text, "m3", "hello");
        let (outcome, _) = tokio::join!(
            review_coordination_inbox(&ctx, &root_text, &mut emit),
            answer_permission(&sup, "run_parent", r#"{"behavior":"allow","scope":"run"}"#),
        );
        assert!(!outcome.unwrap());
        assert_eq!(state_of(&sup, &root_text, &third), CoordinationDeliveryState::Accepted);
        let fourth = unsolicited(&sup, &root_text, "m4", "still there?");
        assert!(!review_coordination_inbox(&ctx, &root_text, &mut emit).await.unwrap());
        assert_eq!(state_of(&sup, &root_text, &fourth), CoordinationDeliveryState::Accepted);
        assert_eq!(crate::coordination::inbox_for(&sup.coordination_snapshot(&root_text).unwrap(), "run_parent").unwrap().len(), 2);

        let requested = events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| matches!(event, AgentEvent::PermissionRequested { .. }))
            .count();
        assert_eq!(requested, 2, "one card per fresh peer decision");
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn native_agent_send_waits_for_and_acknowledges_the_exact_reply() {
        let root = std::env::temp_dir().join(format!(
            "klide-native-coordination-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let root_text = root.to_string_lossy().to_string();
        let sup = FakeSupervisor::with_run("run_parent");
        for (run_id, parent_run_id) in [("run_parent", None), ("run_child", Some("run_parent"))] {
            sup.coordination_apply(
                &root_text,
                CoordinationCommand::RegisterRun {
                    registration: CoordinationRunRegistration {
                        run_id: run_id.to_string(),
                        worker_kind: CoordinationWorkerKind::Harness,
                        parent_run_id: parent_run_id.map(str::to_string),
                        mission_id: None,
                        mission_task_id: None,
                        label: None,
                    },
                    initial_state: Some(CoordinationRunState::Working),
                },
            )
            .unwrap();
        }
        let request = test_request(&root_text, &[]);
        let cancel = CancellationToken::new();
        let ctx = ToolCtx {
            sup: &sup,
            id: "run_parent",
            request: &request,
            cancel: &cancel,
            runs_dir: root.as_path(),
        };
        let call = NormalizedToolCall {
            id: "coord_1".to_string(),
            name: "agent_send".to_string(),
            input: serde_json::json!({
                "toRunId": "run_child",
                "kind": "question",
                "body": "Did replay remain contiguous?",
                "waitForReply": true,
                "timeoutSeconds": 2,
            }),
        };
        let mut emit = |_: AgentEvent| Ok(());

        let (tool, _) = tokio::join!(process_coordination_tool(&ctx, &call, &mut emit), async {
            loop {
                let snapshot = sup.coordination_snapshot(&root_text).unwrap();
                if let Some(question) = snapshot
                    .envelopes
                    .iter()
                    .find(|entry| entry.envelope.to_run_id == "run_child")
                {
                    sup.coordination_apply(
                        &root_text,
                        CoordinationCommand::SendEnvelope {
                            from: CoordinationActor::Run {
                                run_id: "run_child".to_string(),
                            },
                            to_run_id: "run_parent".to_string(),
                            kind: CoordinationEnvelopeKind::Answer,
                            body: "Yes — seq stayed contiguous.".to_string(),
                            reply_to: Some(question.envelope.id.clone()),
                            correlation_id: None,
                            idempotency_key: Some("reply-1".to_string()),
                            source_refs: vec![],
                        },
                    )
                    .unwrap();
                    break;
                }
                tokio::task::yield_now().await;
            }
        });

        let ToolOutcome::Produced(result) = tool.unwrap() else {
            panic!("coordination Tool was cancelled")
        };
        assert!(result.ok, "{}", result.content);
        assert!(result.content.contains("seq stayed contiguous"));
        let snapshot = sup.coordination_snapshot(&root_text).unwrap();
        let reply = snapshot
            .envelopes
            .iter()
            .find(|entry| entry.envelope.body.contains("seq stayed"))
            .unwrap();
        assert_eq!(
            reply.delivery_state,
            CoordinationDeliveryState::Acknowledged
        );
        assert_eq!(
            with_run_handle(&sup, "run_parent", |handle| handle.status),
            Some(AgentRunStatus::Running)
        );
        let _ = std::fs::remove_dir_all(root);
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
        let mut emit = move |e: AgentEvent| -> Result<(), String> {
            sink.lock().unwrap().push(e);
            Ok(())
        };

        let (outcome, _) = tokio::join!(
            process_advisor_tool(&ctx, &call, &mut emit),
            answer_question(
                &sup,
                "adv-run",
                "Use a channel; it fits the ownership model."
            ),
        );

        // Tool result wraps the advice as guidance for the executor.
        match outcome.expect("advisor tool ok") {
            ToolOutcome::Produced(r) => {
                assert!(r.ok);
                assert!(
                    r.content.contains("Advisor guidance:"),
                    "got: {}",
                    r.content
                );
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
        let reply = format!(
            "{ADVISOR_ERROR_PREFIX}Advisor unavailable (anthropic/claude-opus-4-8): no key"
        );

        let (outcome, _) = tokio::join!(
            process_advisor_tool(&ctx, &call, &mut emit),
            answer_question(&sup, "adv-run", &reply),
        );

        match outcome.expect("advisor tool ok") {
            ToolOutcome::Produced(r) => {
                assert!(!r.ok, "a failed consult must be a not-ok tool result");
                assert!(
                    r.content.contains("Advisor consult failed"),
                    "got: {}",
                    r.content
                );
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

    #[tokio::test]
    async fn queued_coordination_is_injected_and_acknowledged_at_the_turn_boundary() {
        let (runs_dir, root) = sandbox("coordination-boundary");
        let id = "coordination-boundary-run";
        let sup = Arc::new(FakeSupervisor::with_run(id));
        sup.coordination_apply(
            &root,
            CoordinationCommand::RegisterRun {
                registration: CoordinationRunRegistration {
                    run_id: id.to_string(),
                    worker_kind: CoordinationWorkerKind::Harness,
                    parent_run_id: None,
                    mission_id: None,
                    mission_task_id: None,
                    // Registration is immutable and the loop registers with
                    // the thread title, so the pre-registration must match.
                    label: crate::coordination::label_from_text(&test_request(&root, &[]).initial_text),
                },
                initial_state: Some(CoordinationRunState::Working),
            },
        )
        .unwrap();
        sup.coordination_apply(
            &root,
            CoordinationCommand::SendEnvelope {
                from: CoordinationActor::Operator,
                to_run_id: id.to_string(),
                kind: CoordinationEnvelopeKind::Instruction,
                body: "Review the replay edge case before answering.".to_string(),
                reply_to: None,
                correlation_id: None,
                idempotency_key: Some("boundary-message".to_string()),
                source_refs: vec![],
            },
        )
        .unwrap();
        let caller = ScriptedProviderCaller::new(vec![scripted_turn("Reviewed.", vec![])]);

        drive_loop(
            sup.clone(),
            &runs_dir,
            id,
            test_request(&root, &[]),
            caller.clone(),
        )
        .await;

        let seen = caller.seen_messages.lock().unwrap();
        let inbox = seen[0]
            .iter()
            .find(|message| {
                message["content"]
                    .as_str()
                    .is_some_and(|text| text.starts_with("[Agent messages]"))
            })
            .expect("the inbox reached the provider on the first turn");
        // Peer text is a user turn, never system: the Anthropic adapter would
        // otherwise hoist it into the system prompt with operator authority.
        assert_eq!(inbox["role"], "user");
        assert!(inbox["content"]
            .as_str()
            .unwrap()
            .contains("Review the replay edge case"));
        drop(seen);
        let snapshot = sup.coordination_snapshot(&root).unwrap();
        assert_eq!(
            snapshot.envelopes[0].delivery_state,
            CoordinationDeliveryState::Acknowledged
        );
        // The Run's own record says what was delivered, by envelope id.
        let events = read_events(&runs_dir, id).unwrap();
        let envelope_id = snapshot.envelopes[0].envelope.id.as_str();
        assert!(events.iter().any(|event| matches!(
            event,
            AgentEvent::SteeringInjected { reason, .. }
                if reason.starts_with("Agent message delivered") && reason.contains(envelope_id)
        )));
    }

    #[tokio::test]
    async fn chat_runs_never_register_and_a_bad_journal_never_stops_a_run() {
        let (runs_dir, root) = sandbox("coordination-chat");
        let sup = Arc::new(FakeSupervisor::with_run("coordination-chat-run"));
        // Interior corruption: the strict reader refuses this journal.
        let dir = std::path::Path::new(&root).join(".klide/coordination");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("events.jsonl"), "not json\nnot json either\n").unwrap();

        // Chat never touches the journal, so it never even notices.
        let mut chat = test_request(&root, &[]);
        chat.mode = AgentMode::Chat;
        drive_loop(
            sup.clone(),
            &runs_dir,
            "coordination-chat-run",
            chat,
            ScriptedProviderCaller::new(vec![scripted_turn("Hello.", vec![])]),
        )
        .await;

        // A Goal run does, and still answers: delivery is skipped, not fatal.
        let goal_id = "coordination-goal-run";
        sup.runs
            .lock()
            .unwrap()
            .insert(goal_id.to_string(), test_support::make_handle());
        let caller = ScriptedProviderCaller::new(vec![scripted_turn("Done anyway.", vec![])]);
        drive_loop(
            sup.clone(),
            &runs_dir,
            goal_id,
            test_request(&root, &[]),
            caller.clone(),
        )
        .await;
        assert_eq!(caller.seen_messages.lock().unwrap().len(), 1);
        assert_eq!(
            read_summary(&runs_dir, goal_id).unwrap().status,
            run_status_wire(&AgentRunStatus::Done)
        );
    }

    /// The retention seam end-to-end through the real loop: a huge read is
    /// stored on disk and stubbed for the provider, the transcript keeps the
    /// full text, and a scripted `peek_value` reads the stored value back —
    /// the exact call sequence a model follows when it meets a stub.
    #[tokio::test]
    async fn a_huge_tool_result_is_stubbed_for_the_provider_and_peekable() {
        let (runs_dir, root) = sandbox("retained-e2e");
        let id = "retained-e2e-run";
        let big = (1..=1200)
            .map(|n| format!("pub const ROW_{n}: usize = {n};"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(big.len() > 20_000, "fixture must clear the retention threshold");
        std::fs::write(format!("{root}/big.rs"), &big).unwrap();

        let caller = ScriptedProviderCaller::new(vec![
            scripted_turn(
                "",
                vec![scripted_tool_call(
                    "read1", "read_file", serde_json::json!({ "path": "big.rs" }),
                )],
            ),
            scripted_turn(
                "",
                vec![scripted_tool_call(
                    "peek1", "peek_value",
                    serde_json::json!({ "id": "read1", "query": "ROW_777:" }),
                )],
            ),
            scripted_turn("ROW_777 is 777.", vec![]),
        ]);
        drive_loop(
            Arc::new(FakeSupervisor::with_run(id)),
            &runs_dir, id, test_request(&root, &[]), caller.clone(),
        )
        .await;

        // The value file landed next to the transcript, holding the full read.
        let value_file = runs_dir.join(format!("{id}.values")).join("read1.txt");
        let stored = std::fs::read_to_string(&value_file).expect("value file written");
        assert!(stored.contains("ROW_600"), "stored value keeps the middle of the output");

        let seen = caller.seen_messages.lock().unwrap();
        assert_eq!(seen.len(), 3);
        // Turn 2: the provider carries the stub, not the 30KB+ read.
        let turn2 = serde_json::to_string(&seen[1]).unwrap();
        assert!(turn2.contains("[retained #read1]"), "provider must see the stub");
        assert!(
            !turn2.contains("ROW_600"),
            "the middle of the read must not reach the provider"
        );
        // Turn 3: the peek result surfaces the searched line.
        let turn3 = serde_json::to_string(&seen[2]).unwrap();
        assert!(
            turn3.contains("ROW_777: usize = 777"),
            "peek must return the matching line: {turn3}"
        );

        // The durable transcript still records the full result — the UI and
        // Mission Control never see the stub.
        let events = read_events(&runs_dir, id).expect("transcript readable");
        let full_read = events.iter().any(|e| matches!(
            e,
            AgentEvent::ToolCallFinished { tool_call_id, result, .. }
                if tool_call_id == "read1" && result.content.contains("ROW_600")
        ));
        assert!(full_read, "transcript keeps the full tool result");
    }

    /// Exercise the real TODO refresh call site after a file read, where
    /// rewriting an early system message would discard the expensive prefix.
    #[tokio::test]
    async fn mlx_todo_updates_preserve_the_processed_prefix() {
        let (runs_dir, root) = sandbox("mlx-todo-prefix");
        let id = "mlx-prefix-run";
        todo::add_todo(&root, id, "Inspect fixture.txt".into()).unwrap();
        let fixture = (0..160)
            .map(|n| format!("pub const FIXTURE_{n}: usize = {n};\n"))
            .collect::<String>();
        std::fs::write(format!("{root}/fixture.txt"), fixture).unwrap();
        let caller = ScriptedProviderCaller::new(vec![
            scripted_turn(
                "",
                vec![scripted_tool_call(
                    "read", "read_file", serde_json::json!({ "path": "fixture.txt" }),
                )],
            ),
            scripted_turn(
                "",
                vec![scripted_tool_call(
                    "complete", "update_todo_list",
                    serde_json::json!({ "action": "complete", "id": "T1" }),
                )],
            ),
            scripted_turn("The fixture has been inspected.", vec![]),
        ]);
        let mut request = test_request(&root, &[]);
        request.provider = "mlx".into();
        request.system_prompt =
            Some("You are a coding assistant. Follow the latest TODO state.".into());
        request.initial_text = "Read fixture.txt, mark T1 complete, then report its status.".into();
        drive_loop(
            Arc::new(FakeSupervisor::with_run(id)),
            &runs_dir, id, request, caller.clone(),
        )
        .await;

        let seen = caller.seen_messages.lock().unwrap();
        assert_eq!(seen.len(), 3);
        // Optional export feeds scripts/mlx-cache/bench.py with actual Harness
        // requests; no model or HTTP service is needed for this regression.
        if let Some(path) = std::env::var_os("KLIDE_MLX_CACHE_FIXTURE") {
            let wire = |messages: Vec<serde_json::Value>| {
                crate::adapters::openai_chat_body(
                    "default_model", messages,
                    schemas_for_mode(&AgentMode::Goal, &[], Some(&root)), true,
                )
            };
            let warm = wire(seen[1].clone());
            let next = wire(seen[2].clone());
            let fixture = serde_json::json!({
                "warm": warm["messages"],
                "next": next["messages"],
                "tools": warm["tools"],
            });
            std::fs::write(path, serde_json::to_vec_pretty(&fixture).unwrap()).unwrap();
        }
        assert_eq!(
            &seen[2][..seen[1].len()], seen[1].as_slice(),
            "TODO changes must not rewrite already-processed messages",
        );
        let latest = seen[2].last().unwrap()["content"].as_str().unwrap();
        assert!(latest.starts_with("[TODO list]"));
        assert!(latest.contains("[x] T1: Inspect fixture.txt"));
        let snapshots = seen[1].iter().filter(|m| {
            m["role"] == "system"
                && m["content"].as_str().is_some_and(|s| s.starts_with("[TODO list]"))
        }).count();
        assert_eq!(snapshots, 1, "unchanged TODO state must not grow the prompt");
    }

    #[tokio::test]
    async fn mlx_todo_updates_notice_the_first_added_item() {
        let (runs_dir, root) = sandbox("mlx-first-todo");
        let id = "mlx-first-todo-run";
        let caller = ScriptedProviderCaller::new(vec![
            scripted_turn(
                "",
                vec![scripted_tool_call(
                    "add", "update_todo_list",
                    serde_json::json!({ "action": "add", "text": "Check the tests" }),
                )],
            ),
            scripted_turn("The task is recorded.", vec![]),
        ]);
        let mut request = test_request(&root, &[]);
        request.provider = "mlx".into();
        drive_loop(
            Arc::new(FakeSupervisor::with_run(id)),
            &runs_dir, id, request, caller.clone(),
        )
        .await;
        let seen = caller.seen_messages.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert_eq!(&seen[1][..seen[0].len()], seen[0].as_slice());
        assert_eq!(seen[1].last().unwrap()["role"], "system");
        assert_eq!(
            seen[1].last().unwrap()["content"], "[TODO list]\n[ ] T1: Check the tests",
        );
    }

    #[tokio::test]
    async fn mlx_chat_does_not_inject_project_todos() {
        let (runs_dir, root) = sandbox("mlx-chat-todos");
        let id = "mlx-chat-run";
        todo::add_todo(&root, id, "This belongs to a tool-capable turn".into()).unwrap();
        let caller = ScriptedProviderCaller::new(vec![scripted_turn("Hello.", vec![])]);
        let mut request = test_request(&root, &[]);
        request.provider = "mlx".into();
        request.mode = AgentMode::Chat;
        drive_loop(
            Arc::new(FakeSupervisor::with_run(id)),
            &runs_dir, id, request, caller.clone(),
        )
        .await;
        let seen = caller.seen_messages.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].len(), 2, "local Chat only sends system and user messages");
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
        assert_eq!(read_summary(&runs_dir, "loop-run").unwrap().status, "done");

        // The handle is retired with the terminal status: the supervisor map
        // must not grow by one cancel-token + trust-memory entry per run ever
        // started.
        assert!(with_run_handle(sup.as_ref(), "loop-run", |_| ()).is_none());

        // The transcript carries the whole sequence.
        let events = read_events(&runs_dir, "loop-run").unwrap();
        assert!(matches!(
            events.first(),
            Some(AgentEvent::RunStarted { .. })
        ));
        let finished: Vec<&ToolResult> = events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::ToolCallFinished { result, .. } => Some(result),
                _ => None,
            })
            .collect();
        assert_eq!(finished.len(), 3);
        assert!(
            finished[0].content.contains("hello world"),
            "read shows original"
        );
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
        drive_loop(
            sup.clone(),
            &runs_dir,
            "err-run",
            test_request(&root, &[]),
            caller,
        )
        .await;

        assert_eq!(read_summary(&runs_dir, "err-run").unwrap().status, "error");
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

        assert_eq!(read_summary(&runs_dir, "cap-run").unwrap().status, "error");
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

    /// A turn that spends its whole reply budget on reasoning is resampled
    /// rather than kept: the empty turn leaves the provider history, the user
    /// sees why, and the run settles on the answer the retry produced.
    #[tokio::test]
    async fn a_reasoning_runaway_is_resampled_instead_of_answered() {
        let (runs_dir, root) = sandbox("runaway");
        let caller = ScriptedProviderCaller::new(vec![
            scripted_runaway(),
            scripted_turn("Sorry — here is the actual answer.", vec![]),
        ]);
        let sup = Arc::new(FakeSupervisor::with_run("runaway-run"));
        drive_loop(
            sup.clone(),
            &runs_dir,
            "runaway-run",
            test_request(&root, &[]),
            caller,
        )
        .await;

        assert_eq!(
            read_summary(&runs_dir, "runaway-run").unwrap().status,
            "done"
        );
        let events = read_events(&runs_dir, "runaway-run").unwrap();

        assert!(
            events.iter().any(|e| matches!(
                e,
                AgentEvent::SteeringInjected { reason, .. }
                    if reason.contains("spent on reasoning")
            )),
            "the discarded attempt is explained, not hidden"
        );

        // Exactly one assistant message reaches the conversation: the resample.
        let answers: Vec<String> = events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::AssistantMessage { content, .. } => Some(
                    content
                        .iter()
                        .filter_map(|b| match b {
                            AgentContentBlock::Text { text } => Some(text.clone()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join(""),
                ),
                _ => None,
            })
            .collect();
        assert_eq!(answers.len(), 1, "the empty turn produced no message: {answers:?}");
        assert!(answers[0].contains("here is the actual answer"));
        assert!(
            !answers[0].contains("reply budget"),
            "a recovered run carries no failure notice: {}",
            answers[0]
        );
    }

    /// Two runaways in a row exhaust the resamples, and the run settles on the
    /// notice rather than looping until the turn cap.
    #[tokio::test]
    async fn repeated_runaways_settle_with_an_explanation() {
        let (runs_dir, root) = sandbox("runaway-twice");
        let caller = ScriptedProviderCaller::new(vec![
            scripted_runaway(),
            scripted_runaway(),
            scripted_runaway(),
        ]);
        let sup = Arc::new(FakeSupervisor::with_run("runaway-twice-run"));
        drive_loop(
            sup.clone(),
            &runs_dir,
            "runaway-twice-run",
            test_request(&root, &[]),
            caller,
        )
        .await;

        assert_eq!(
            read_summary(&runs_dir, "runaway-twice-run").unwrap().status,
            "done"
        );
        let events = read_events(&runs_dir, "runaway-twice-run").unwrap();
        assert!(
            events.iter().any(|e| matches!(
                e,
                AgentEvent::AssistantMessage { content, .. }
                    if content.iter().any(|b| matches!(
                        b,
                        AgentContentBlock::Text { text } if text.contains("Effort")
                    ))
            )),
            "the user is told which knob to turn"
        );
    }

    /// The turn-cap endgame: a run that would otherwise spend its last turn
    /// starting new work is asked to wrap up, then has its tools withheld so
    /// the final turn can only be a written answer. Scripted with a cap of 4 —
    /// turn 1 carries the reserve nudge, turn 3 is the forced answer.
    #[tokio::test]
    async fn the_last_turn_withholds_tools_so_the_run_ends_in_an_answer() {
        let (runs_dir, root) = sandbox("endgame");
        std::fs::write(format!("{root}/greeting.txt"), "hello world\n").unwrap();
        let reading = || {
            scripted_turn(
                "Reading.",
                vec![scripted_tool_call(
                    "call_read",
                    "read_file",
                    serde_json::json!({ "path": "greeting.txt" }),
                )],
            )
        };
        // Three tool turns, then a tool-free answer on the turn that has no
        // tools to call — which is what the forcer is there to produce.
        let caller = ScriptedProviderCaller::new(vec![
            reading(),
            reading(),
            reading(),
            scripted_turn("Here is what I found.", vec![]),
        ]);
        let mut request = test_request(&root, &[]);
        request.max_turns = Some(4);
        let sup = Arc::new(FakeSupervisor::with_run("endgame-run"));
        drive_loop(sup.clone(), &runs_dir, "endgame-run", request, caller.clone()).await;

        let offered = caller.seen_tools.lock().unwrap().clone();
        assert_eq!(
            offered,
            vec![true, true, true, false],
            "tools are withheld on the final turn only"
        );

        let events = read_events(&runs_dir, "endgame-run").unwrap();
        let reasons: Vec<String> = events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::SteeringInjected { reason, .. } => Some(reason.clone()),
                _ => None,
            })
            .collect();
        assert!(
            reasons.iter().any(|r| r.contains("Finalization reserve")),
            "the wrap-up nudge is recorded, not silent: {reasons:?}"
        );
        assert!(
            reasons.iter().any(|r| r.contains("answering without tools")),
            "so is the forced turn: {reasons:?}"
        );

        // The run ends on the model's own answer, so there is no turn-cap error.
        assert_eq!(
            read_summary(&runs_dir, "endgame-run").unwrap().status,
            "done"
        );
        assert!(
            !events.iter().any(|e| matches!(
                e,
                AgentEvent::RunError { error, .. } if error.code == "max_turns"
            )),
            "a run that answered did not hit the cap"
        );
    }

    /// At `max_turns == 1` the forcer would leave a run that can never call a
    /// tool, so it stands down and the cap behaves as it always did.
    #[tokio::test]
    async fn a_one_turn_run_still_gets_its_tools() {
        let (runs_dir, root) = sandbox("endgame-one");
        std::fs::write(format!("{root}/greeting.txt"), "hello world\n").unwrap();
        let caller = ScriptedProviderCaller::new(vec![scripted_turn(
            "Reading.",
            vec![scripted_tool_call(
                "call_read",
                "read_file",
                serde_json::json!({ "path": "greeting.txt" }),
            )],
        )]);
        let mut request = test_request(&root, &[]);
        request.max_turns = Some(1);
        let sup = Arc::new(FakeSupervisor::with_run("one-run"));
        drive_loop(sup.clone(), &runs_dir, "one-run", request, caller.clone()).await;

        assert_eq!(caller.seen_tools.lock().unwrap().clone(), vec![true]);
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
    use std::process::Command;
    use std::time::Duration;

    fn temp_workspace(name: &str) -> String {
        let dir = std::env::temp_dir().join(format!(
            "klide-perm-gate-{name}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Command::new("git")
            .args(["init", "-q"])
            .current_dir(&dir)
            .status()
            .unwrap();
        Command::new("git")
            .args([
                "-c",
                "user.name=Klide",
                "-c",
                "user.email=test@klide.local",
                "commit",
                "--allow-empty",
                "-qm",
                "initial",
            ])
            .current_dir(&dir)
            .status()
            .unwrap();
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
    async fn full_auto_runs_a_brand_new_command_without_a_prompt() {
        let root = temp_workspace("full-auto");
        let sup = FakeSupervisor::with_run("full-auto-run");
        let cancel = CancellationToken::new();
        // No allowlist entry, no prior approval — only the full-auto rung.
        let mut request = test_request(&root, &[]);
        request.auto_approve_commands = Some(true);
        let runs_dir = std::env::temp_dir().join(format!(
            "klide-full-auto-runs-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&runs_dir).unwrap();
        let ctx = ToolCtx {
            sup: &sup,
            id: "full-auto-run",
            request: &request,
            cancel: &cancel,
            runs_dir: runs_dir.as_path(),
        };
        let (events, mut emit) = event_log();

        let result =
            run_gate_without_prompt(&ctx, &command_call("call-1", "echo full-auto"), &mut emit)
                .await;
        assert!(result.ok, "full auto should execute: {}", result.content);
        assert!(result.content.contains("full-auto"));
        assert_eq!(prompts_shown(&events), 0, "full auto must never prompt");
    }

    #[tokio::test]
    async fn approve_for_run_executes_and_the_identical_command_skips_the_prompt() {
        let root = temp_workspace("approve-run");
        let sup = FakeSupervisor::with_run("perm-run");
        let cancel = CancellationToken::new();
        let request = test_request(&root, &[]);
        let runs_dir = std::env::temp_dir().join(format!(
            "klide-project-scope-runs-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&runs_dir).unwrap();
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
            let request = evs
                .iter()
                .find_map(|e| match e {
                    AgentEvent::PermissionRequested { request, .. } => Some(request.clone()),
                    _ => None,
                })
                .expect("PermissionRequested emitted");
            let ids: Vec<&str> = request
                .options
                .iter()
                .map(|o| o.option_id.as_str())
                .collect();
            assert_eq!(ids, ["allow_once", "allow_run", "allow_project", "deny"]);
            // And they reach the frontend as `optionId`, which is what the
            // mirror in src/agent/types.ts declares.
            let wire = serde_json::to_value(&request).expect("serialize request");
            assert_eq!(wire["options"][0]["optionId"], "allow_once");
        }

        // Approved for the run: the identical command auto-executes, no prompt.
        let second =
            run_gate_without_prompt(&ctx, &command_call("c2", "echo approved-hi"), &mut emit).await;
        assert!(second.ok, "re-run auto-executes: {}", second.content);
        assert_eq!(prompts_shown(&events), 1, "asked exactly once");
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(runs_dir);
    }

    #[tokio::test]
    async fn rejected_command_is_remembered_and_the_reproposal_auto_rejects() {
        let root = temp_workspace("reject-run");
        let sup = FakeSupervisor::with_run("perm-run");
        let cancel = CancellationToken::new();
        let request = test_request(&root, &[]);
        let runs_dir = std::env::temp_dir().join(format!(
            "klide-project-persist-runs-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&runs_dir).unwrap();
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
        assert!(
            result.content.contains("command not run"),
            "got: {}",
            result.content
        );

        // Re-proposing the identical command auto-rejects without a prompt.
        let second =
            run_gate_without_prompt(&ctx, &command_call("c2", "echo nope"), &mut emit).await;
        assert!(!second.ok);
        assert!(
            second
                .content
                .contains("already proposed this exact command"),
            "got: {}",
            second.content
        );
        assert_eq!(prompts_shown(&events), 1, "asked exactly once");
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(runs_dir);
    }

    #[tokio::test]
    async fn project_scope_approval_persists_to_the_on_disk_allowlist() {
        let root = temp_workspace("project-scope");
        let sup = FakeSupervisor::with_run("perm-run");
        let cancel = CancellationToken::new();
        let request = test_request(&root, &[]);
        let runs_dir = std::env::temp_dir().join(format!(
            "klide-project-persist-runs-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&runs_dir).unwrap();
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
            answer_permission(
                &sup,
                "perm-run",
                r#"{"behavior":"allow","scope":"project"}"#
            ),
        );
        assert!(produced(outcome).ok);

        // The approval reached the project allowlist on disk…
        let stored = command_allowlist::list(&runs_dir, &root).unwrap();
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
        let _ = std::fs::remove_dir_all(runs_dir);
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
        assert_eq!(
            parse_diff_decision("apply"),
            ("apply".to_string(), None, false)
        );
        assert_eq!(
            parse_diff_decision("reject"),
            ("reject".to_string(), None, false)
        );
        assert_eq!(
            parse_diff_decision(r#"{"behavior":"apply"}"#),
            ("apply".to_string(), None, false)
        );
        // "Validate all" — apply plus scope "run"; the scope never rides a
        // rejection.
        assert_eq!(
            parse_diff_decision(r#"{"behavior":"apply","scope":"run"}"#),
            ("apply".to_string(), None, true)
        );
        assert_eq!(
            parse_diff_decision(r#"{"behavior":"reject","scope":"run"}"#),
            ("reject".to_string(), None, false)
        );
        assert_eq!(
            parse_diff_decision(r#"{"behavior":"reject","note":"use snake_case"}"#),
            ("reject".to_string(), Some("use snake_case".to_string()), false)
        );
        // Blank notes are dropped; garbage falls back to a plain rejection.
        assert_eq!(
            parse_diff_decision(r#"{"behavior":"reject","note":"  "}"#),
            ("reject".to_string(), None, false)
        );
        assert_eq!(
            parse_diff_decision("{broken"),
            ("{broken".to_string(), None, false)
        );
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

    #[tokio::test]
    async fn validate_all_applies_this_edit_and_the_next_one_skips_the_pause() {
        let root = temp_workspace("apply-all");
        let sup = FakeSupervisor::with_run("diff-run");
        let cancel = CancellationToken::new();
        let request = reviewed_request(&root);
        let runs_dir = std::env::temp_dir().join(format!(
            "klide-diff-gate-runs-all-{}-{}",
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

        let first = create_call("c1", "a.md", "first\n");
        let (outcome, _) = tokio::join!(
            process_write_tool(&ctx, &first, &mut emit),
            answer_diff(&sup, "diff-run", r#"{"behavior":"apply","scope":"run"}"#),
        );
        let result = match outcome.expect("gate ok") {
            ToolOutcome::Produced(r) => r,
            ToolOutcome::Cancelled => panic!("unexpected cancellation"),
        };
        assert!(result.ok, "applied: {}", result.content);

        // The second edit must apply without pausing — nobody answers this
        // one, so the timeout converts a would-be hang into a clear failure.
        let second = create_call("c2", "b.md", "second\n");
        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            process_write_tool(&ctx, &second, &mut emit),
        )
        .await
        .expect("validate-all must skip the second pause");
        let result = match outcome.expect("gate ok") {
            ToolOutcome::Produced(r) => r,
            ToolOutcome::Cancelled => panic!("unexpected cancellation"),
        };
        assert!(result.ok, "auto-applied: {}", result.content);
        assert_eq!(
            std::fs::read_to_string(std::path::Path::new(&root).join("b.md")).unwrap(),
            "second\n"
        );
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(runs_dir);
    }
}

#[cfg(test)]
mod network_permission_tests {
    use super::test_support::*;
    use super::*;
    use std::time::Duration;

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

    #[tokio::test]
    async fn approved_network_tool_returns_without_panicking_the_async_harness() {
        let root = std::env::temp_dir().join(format!(
            "klide-network-tool-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let runs_dir = root.join("runs");
        let workspace = root.join("workspace");
        std::fs::create_dir_all(&runs_dir).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();

        let sup = FakeSupervisor::with_run("network-run");
        let cancel = CancellationToken::new();
        let request = test_request(workspace.to_str().unwrap(), &[]);
        let ctx = ToolCtx {
            sup: &sup,
            id: "network-run",
            request: &request,
            cancel: &cancel,
            runs_dir: runs_dir.as_path(),
        };
        let call = NormalizedToolCall {
            id: "call_fetch".to_string(),
            name: "web_fetch".to_string(),
            // Public but deliberately closed: the result should be a normal
            // Tool error, never a reqwest blocking-runtime panic.
            input: serde_json::json!({ "url": "https://1.1.1.1:1/" }),
        };
        let events = Arc::new(Mutex::new(Vec::<AgentEvent>::new()));
        let sink = events.clone();
        let mut emit = move |event: AgentEvent| -> Result<(), String> {
            sink.lock().unwrap().push(event);
            Ok(())
        };

        let (outcome, _) = tokio::join!(
            tokio::time::timeout(
                Duration::from_secs(15),
                process_network_tool(&ctx, &call, &mut emit),
            ),
            answer_permission(
                &sup,
                "network-run",
                r#"{"behavior":"allow","scope":"once"}"#,
            ),
        );
        let result = match outcome
            .expect("approved network Tool must settle")
            .expect("network gate must return normally")
        {
            ToolOutcome::Produced(result) => result,
            ToolOutcome::Cancelled => panic!("network Tool was unexpectedly cancelled"),
        };
        assert!(!result.ok, "closed endpoint should return a Tool error");
        assert!(events
            .lock()
            .unwrap()
            .iter()
            .any(|event| matches!(event, AgentEvent::PermissionResolved { .. })));

        let _ = std::fs::remove_dir_all(root);
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
    fn accept_all_keeps_files_and_consumes_every_checkpoint() {
        let (runs, ws) = make_sandbox("accept-all");
        let run = "run_accept";
        let rel = "note.md";
        let abs = ws.join(rel);
        std::fs::write(&abs, "accepted content").unwrap();

        for (id, old_content, new_content, ts) in [
            ("turn1_tool_1", "v1", "v2", 1),
            ("turn2_tool_1", "v2", "accepted content", 2),
        ] {
            let json = checkpoint_json(
                id,
                rel,
                old_content,
                new_content,
                false,
                ws.to_str().unwrap(),
                ts,
            );
            write_checkpoint(&runs, run, id, &json);
        }

        let result = accept_all_checkpoints_at(&runs, run).expect("accept all");
        assert_eq!(result.accepted, 2);
        assert_eq!(std::fs::read_to_string(&abs).unwrap(), "accepted content");
        assert!(
            list_checkpoints_at(&runs, run).unwrap().is_empty(),
            "accepted checkpoint files should be consumed"
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
