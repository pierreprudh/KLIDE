//! Run host — the one door a Run passes through to be admitted, placed,
//! controlled and listed, whichever process ends up running its loop.
//!
//! Two hosts run `run_agent_loop` unchanged: the app (`TauriSupervisor`) and
//! `klide ptyd` (`daemon::RunHost`, the background subscription chats). What
//! sits *outside* the loop — is this id free, is the conversation quarantined,
//! which host gets it, build the handle, spawn the loop and report one that
//! left without settling, answer a card, say whether the Run is active — used
//! to be written once per host and had drifted (a budget that reset with the
//! daemon, a handle retired in two different places, three error texts for one
//! missing card). Each of those decisions lives here once; the hosts are
//! adapters around it, and the seven Tauri commands are one call each.
//!
//! The app is the only dispatcher: a daemon-hosted Run is still *admitted* by
//! the app (`start`), so the app's failure budget is the one judgement for a
//! conversation whatever host runs it. Local outcomes feed it from
//! `settle_run`; daemon outcomes feed it from the terminal event the watcher
//! delivers (`record_remote_outcome`).

use super::*;
use crate::pty_wire::ChatControl;

/// Where a new Run's loop runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Placement {
    /// This process: the app's `TauriSupervisor` (or, inside ptyd, its `RunHost`).
    App,
    /// `klide ptyd`, reached through `remote.rs`; the answer finishes with the
    /// window closed.
    Background,
}

/// The one rule for a Run that may live in the background host: a standalone
/// subscription conversation — no parent, no Mission. `daemon::RunHost`
/// refuses anything else at its own door with the same rule.
pub(super) fn background_eligible(request: &StartRunRequest) -> bool {
    crate::providers::is_subscription_provider(&request.provider)
        && request.parent_id.is_none()
        && request.mission_id.is_none()
        && request.mission_task_id.is_none()
}

/// Decide once where `request` runs. `nested` is a Run something in this
/// process waits on — a subagent's parent, an observer wake, a Mission
/// dispatch — which must stay beside its waiter. Off Unix there is no daemon.
pub(super) fn placement(request: &StartRunRequest, nested: bool) -> Placement {
    if cfg!(unix) && !nested && background_eligible(request) {
        Placement::Background
    } else {
        Placement::App
    }
}

/// The statuses that mean "still going": a handle with any other status is a
/// loop finishing its settle sequence, busy but not active. The one
/// definition, applied to a local handle and to a status the daemon reports.
pub(super) const ACTIVE: [AgentRunStatus; 5] = [
    AgentRunStatus::Queued,
    AgentRunStatus::Running,
    AgentRunStatus::WaitingForPermission,
    AgentRunStatus::WaitingForDiff,
    AgentRunStatus::Paused,
];

pub(super) fn is_active_status(status: AgentRunStatus) -> bool {
    ACTIVE.contains(&status)
}

/// The same rule over the wire string a daemon (or a summary) carries.
pub(super) fn is_active_wire(status: &str) -> bool {
    ACTIVE.iter().any(|s| run_status_wire(s) == status)
}

pub(super) fn busy(id: &str) -> String {
    format!("A run is already active for this conversation ({id}). Wait for it to finish or stop it first.")
}

/// What admission hands the host: the token the loop watches, and the
/// transcript as it stood when the conversation was claimed, so the loop and
/// the host's backstop count from the same place.
pub(super) struct Admitted {
    pub cancel: CancellationToken,
    pub prior_events: Vec<AgentEvent>,
}

impl Admitted {
    /// First transcript index belonging to this turn.
    pub fn from_seq(&self) -> u64 {
        self.prior_events.len() as u64
    }
}

/// Claim `id` for a new loop in `runs`: refuse a path-shaped id and a
/// conversation another loop still holds, run the host's own `guard`, then
/// insert the handle — all under the one lock, so a previous turn cannot
/// retire between counting its transcript and this claim. The transcript is
/// read here once and handed to the loop; it is the same read the loop made.
pub(super) fn admit(
    runs: &Mutex<HashMap<String, AgentRunHandle>>,
    runs_dir: &Path,
    id: &str,
    request: &StartRunRequest,
    guard: impl FnOnce() -> Result<(), String>,
) -> Result<Admitted, String> {
    validate_run_id(id)?;
    let cancel = CancellationToken::new();
    let mut runs = runs
        .lock()
        .map_err(|_| "Agent state is unavailable".to_string())?;
    // A handle remains owned through terminal summary write and retirement.
    // Even a terminal status is busy until the old loop releases that handle;
    // otherwise its settle_run could retire a newly started observer reply.
    if runs.contains_key(id) {
        return Err(busy(id));
    }
    guard()?;
    let prior_events = if transcript_path(runs_dir, id).exists() {
        read_events(runs_dir, id)?
    } else {
        Vec::new()
    };
    runs.insert(
        id.to_string(),
        AgentRunHandle {
            status: AgentRunStatus::Running,
            cancel: cancel.clone(),
            coordination_workspace_root: coordination_workspace_for(request).map(str::to_string),
            coordination_is_terminal_run: request.parent_id.is_some() || request.mission_id.is_some(),
            pending_diff: Mutex::new(None),
            pending_question: Mutex::new(None),
            pending_permission: Mutex::new(None),
            trust: permission::TrustMemory::default(),
            subject: permission::GateSubject::from_request(request),
        },
    );
    Ok(Admitted { cancel, prior_events })
}

/// Detach the loop for an admitted Run. The loop runs in a task of its own so
/// a panic inside it surfaces here as a join error: its `RunLease` has
/// already released the Run while unwinding, and `after` still runs, in the
/// same order as a normal exit. A loop that returned `Err` wrote its own
/// backstop before releasing (see `run_agent_loop`); a panic is reported here
/// through the same sequence the loop was writing with, so a pending stream
/// flush cannot land on the same index.
pub(super) fn spawn_loop(
    sup: Arc<dyn RunSupervisor>,
    runs_dir: PathBuf,
    id: String,
    request: StartRunRequest,
    on_event: Channel<AgentEvent>,
    admitted: Admitted,
    caller: impl AgentProviderCaller,
    after: impl FnOnce(Result<(), String>) + Send + 'static,
) {
    let sequence = Arc::new(Mutex::new(admitted.from_seq()));
    let backstop = (sup.clone(), runs_dir.clone(), id.clone(), on_event.clone(), sequence.clone());
    tauri::async_runtime::spawn(async move {
        let result = match tauri::async_runtime::spawn(hosted_loop(
            sup,
            runs_dir,
            id,
            request,
            on_event,
            admitted.cancel,
            caller,
            sequence,
            admitted.prior_events,
        ))
        .await
        {
            Ok(result) => result,
            Err(_) => {
                // The loop's frame is gone, but a stream-log timer it started
                // may still hold a tail to flush. It shares this sequence, so
                // it cannot collide — but the Transcript should still end on
                // the terminal line, so let the window pass first.
                tokio::time::sleep(stream_log::WINDOW * 2).await;
                let (sup, runs_dir, id, on_event, sequence) = &backstop;
                let message = "run panicked".to_string();
                settle_backstop(sup.as_ref(), runs_dir, id, sequence, on_event, &message);
                sup.retire_run(id);
                Err(message)
            }
        };
        after(result);
    });
}

/// The one terminal event for a loop that left without settling — a failed
/// Transcript write, a panic. Written at the loop's own sequence (best-effort:
/// the write that failed may well be the same one), broadcast only once it is
/// durable, and sent on the request channel regardless so a watching panel is
/// never left busy.
pub(super) fn settle_backstop(
    sup: &dyn RunSupervisor,
    runs_dir: &Path,
    id: &str,
    sequence: &Mutex<u64>,
    on_event: &Channel<AgentEvent>,
    message: &str,
) {
    let event = AgentEvent::RunError {
        run_id: id.to_string(),
        error: AgentError {
            code: error_code::RUN_HOST_FAILED.to_string(),
            message: message.to_string(),
            detail: None,
            retryable: true,
        },
        ts: now_ms(),
    };
    // A panic while the loop held the sequence poisons it; the count inside
    // is still right.
    let mut seq = sequence.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if append_event(runs_dir, id, *seq, &event).is_ok() {
        sup.broadcast(id, *seq, &event);
        *seq += 1;
    }
    let _ = on_event.send(event);
}

/// Answer a card — or Stop — on a live handle. One implementation for every
/// host: the app's commands and the daemon's `ChatControl` both land here.
/// `Ok(true)` when a pending card was answered.
pub(super) fn answer(handle: &AgentRunHandle, control: ChatControl) -> Result<bool, String> {
    let (pending, reply, missing) = match control {
        // Just cancel the token: the run loop observes it and settles the
        // run (aborted event, summary, status) so there is a single writer.
        ChatControl::Stop => {
            handle.cancel.cancel();
            return Ok(false);
        }
        ChatControl::CommandPolicy { auto_approve } => {
            return permission::apply_command_policy(handle, auto_approve)
        }
        // The full decision JSON travels; the run loop parses it back to read
        // the behavior (allow/deny), the scope, and a diff review's `note`.
        ChatControl::Permission { decision } => (
            &handle.pending_permission,
            decision.to_string(),
            "No pending permission request for this run.",
        ),
        ChatControl::Diff { decision } => (
            &handle.pending_diff,
            decision.to_string(),
            "No pending diff review for this run.",
        ),
        ChatControl::Question { answer } => {
            (&handle.pending_question, answer, "No pending question for this run.")
        }
    };
    let sender = pending
        .lock()
        .map_err(|_| "Run state is unavailable".to_string())?
        .take()
        .ok_or_else(|| missing.to_string())?;
    sender
        .send(reply)
        .map_err(|_| "Run stopped before the answer arrived".to_string())?;
    Ok(true)
}

/// Route a decision to the host that holds the Run: this process first, the
/// daemon otherwise. The local lock is never held across the socket call.
pub(super) async fn control(
    app: &tauri::AppHandle,
    id: &str,
    control: ChatControl,
) -> Result<bool, String> {
    {
        let state = app.state::<AgentSupervisorState>();
        let runs = state
            .runs
            .lock()
            .map_err(|_| "Agent state is unavailable".to_string())?;
        if let Some(handle) = runs.get(id) {
            return answer(handle, control);
        }
    }
    remote::control(app, id.to_string(), control).await
}

/// Live status of `id` wherever it runs, or `None` when no host holds it.
pub(super) async fn state(app: &tauri::AppHandle, id: &str) -> Result<RunState, String> {
    let local = app
        .state::<AgentSupervisorState>()
        .runs
        .lock()
        .ok()
        .and_then(|runs| runs.get(id).map(|h| run_status_wire(&h.status).to_string()));
    if local.is_some() {
        return Ok(RunState { status: local, from_seq: None });
    }
    remote::state(app, id).await
}

/// Whether some host still runs a live loop for `id` (see [`ACTIVE`]).
/// Mission restart reconciliation uses this before calling an attempt
/// orphaned: re-selecting a workspace in the same app process must never
/// interrupt a real active Run.
pub(super) fn is_active(app: &tauri::AppHandle, id: &str) -> bool {
    let local = app
        .state::<AgentSupervisorState>()
        .runs
        .lock()
        .ok()
        .and_then(|runs| runs.get(id).map(|handle| handle.status))
        .is_some_and(is_active_status);
    local
        || off_the_worker(|| {
            remote::statuses(app)
                .ok()
                .is_some_and(|runs| runs.get(id).is_some_and(|s| is_active_wire(s)))
        })
}

/// Whether any host holds a handle at all — a loop that has not released the
/// conversation yet, active or settling. Storage relocation must not strand
/// a writer in the previous directory, so it asks this, not [`is_active`].
pub(super) fn any_hosted(app: &tauri::AppHandle) -> Result<bool, String> {
    let local = !app
        .state::<AgentSupervisorState>()
        .runs
        .lock()
        .map_err(|_| "Agent state unavailable".to_string())?
        .is_empty();
    Ok(local || !remote::statuses(app)?.is_empty())
}

/// Every active Run across both hosts, as wire statuses.
pub(super) async fn active_statuses(
    app: &tauri::AppHandle,
) -> Result<HashMap<String, String>, String> {
    let mut live: HashMap<String, String> = app
        .state::<AgentSupervisorState>()
        .runs
        .lock()
        .map_err(|_| "Agent state is unavailable".to_string())?
        .iter()
        .filter(|(_, handle)| is_active_status(handle.status))
        .map(|(id, handle)| (id.clone(), run_status_wire(&handle.status).to_string()))
        .collect();
    let remote_app = app.clone();
    let remote = crate::blocking::run(move || remote::statuses(&remote_app)).await?;
    for (id, status) in remote {
        if is_active_wire(&status) {
            live.entry(id).or_insert(status);
        }
    }
    Ok(live)
}

/// Feed the app's failure budget with a daemon-hosted Run's outcome, read
/// from the terminal event its watcher delivered: the same rule `settle_run`
/// applies locally — an error counts, done clears, a Stop says nothing. The
/// event's own time is what counts: a reopen replays outcomes that landed
/// while the window was closed, and an old failure must not read as fresh.
pub(super) fn record_remote_outcome(
    app: &tauri::AppHandle,
    runs_dir: &Path,
    id: &str,
    event: &AgentEvent,
) {
    let failed = match event {
        AgentEvent::RunResult { .. } => false,
        AgentEvent::RunError { error, .. } if error.code != error_code::ABORTED => true,
        _ => return,
    };
    let budget = &app.state::<AgentSupervisorState>().failure_budget;
    if !failed {
        budget.record_success(id);
        return;
    }
    let Ok(summary) = transcripts::read_summary(runs_dir, id) else {
        return;
    };
    budget.record_failure(id, &summary.provider, &summary.model, event.ts());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(provider: &str) -> StartRunRequest {
        serde_json::from_value(serde_json::json!({
            "runId": "conversation", "mode": "chat", "provider": provider,
            "model": "default", "initialText": "Keep working"
        }))
        .unwrap()
    }

    fn sandbox(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("klide-run-host-{label}-{}", run_id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_standalone_subscription_conversation_goes_to_the_background_host() {
        let plain = request("opencode");
        assert!(background_eligible(&plain));
        assert_eq!(
            placement(&plain, false),
            if cfg!(unix) { Placement::Background } else { Placement::App }
        );
        // Something in this process waits on a nested Run: it stays here.
        assert_eq!(placement(&plain, true), Placement::App);

        let mut child = request("opencode");
        child.parent_id = Some("parent".into());
        assert!(!background_eligible(&child));
        assert_eq!(placement(&child, false), Placement::App);

        let mut attempt = request("claude-code");
        attempt.mission_id = Some("m".into());
        attempt.mission_task_id = Some("t".into());
        assert!(!background_eligible(&attempt));

        let api = request("openai");
        assert!(!background_eligible(&api));
        assert_eq!(placement(&api, false), Placement::App);
    }

    #[test]
    fn active_means_the_same_thing_for_a_handle_and_for_a_wire_status() {
        for status in [
            AgentRunStatus::Queued,
            AgentRunStatus::Running,
            AgentRunStatus::WaitingForPermission,
            AgentRunStatus::WaitingForDiff,
            AgentRunStatus::Paused,
            AgentRunStatus::Done,
            AgentRunStatus::Error,
            AgentRunStatus::Cancelled,
        ] {
            assert_eq!(
                is_active_status(status),
                is_active_wire(run_status_wire(&status)),
                "{status:?}"
            );
        }
        assert!(is_active_wire("waiting_for_diff"));
        assert!(!is_active_wire("done"));
        assert!(!is_active_wire("not a status"));
    }

    #[test]
    fn admission_refuses_a_path_shaped_id_a_busy_conversation_and_a_failed_guard() {
        let runs_dir = sandbox("admit");
        let runs = Mutex::new(HashMap::new());
        let req = request("mock");
        assert!(admit(&runs, &runs_dir, "../outside", &req, || Ok(())).is_err());
        assert!(runs.lock().unwrap().is_empty(), "nothing is claimed by a refusal");

        assert!(admit(&runs, &runs_dir, "c", &req, || Err("guard says no".into()))
            .err()
            .unwrap()
            .contains("guard says no"));
        assert!(runs.lock().unwrap().is_empty());

        let first = admit(&runs, &runs_dir, "c", &req, || Ok(())).unwrap();
        assert_eq!(first.from_seq(), 0, "a fresh conversation starts at seq 0");
        assert!(runs.lock().unwrap().contains_key("c"));
        assert_eq!(
            admit(&runs, &runs_dir, "c", &req, || Ok(())).err(),
            Some(busy("c"))
        );
        std::fs::remove_dir_all(runs_dir).unwrap();
    }

    #[test]
    fn admission_counts_the_transcript_so_a_follow_up_continues_the_sequence() {
        let runs_dir = sandbox("from-seq");
        let runs = Mutex::new(HashMap::new());
        for seq in 0..3 {
            append_event(
                &runs_dir,
                "c",
                seq,
                &AgentEvent::UserMessage {
                    run_id: "c".into(),
                    message_id: format!("u{seq}"),
                    text: "hi".into(),
                    attachments: vec![],
                    ts: 0,
                },
            )
            .unwrap();
        }
        let admitted = admit(&runs, &runs_dir, "c", &request("mock"), || Ok(())).unwrap();
        assert_eq!(admitted.from_seq(), 3);
        assert_eq!(admitted.prior_events.len(), 3);
        std::fs::remove_dir_all(runs_dir).unwrap();
    }

    #[test]
    fn the_backstop_writes_one_terminal_error_at_the_loop_sequence() {
        let runs_dir = sandbox("backstop");
        let sup = crate::agent::test_support::FakeSupervisor::with_run("c");
        let sequence = Mutex::new(4);
        let (tx, rx) = std::sync::mpsc::channel();
        let channel = Channel::new(move |body| {
            let _ = tx.send(body.deserialize::<AgentEvent>().unwrap());
            Ok(())
        });
        settle_backstop(&sup, &runs_dir, "c", &sequence, &channel, "run panicked");
        assert_eq!(*sequence.lock().unwrap(), 5, "the sequence moved past the write");
        let line = std::fs::read_to_string(transcript_path(&runs_dir, "c")).unwrap();
        let value: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(value["seq"], 4);
        assert!(matches!(
            rx.recv().unwrap(),
            AgentEvent::RunError { error, .. } if error.code == error_code::RUN_HOST_FAILED
        ));
        std::fs::remove_dir_all(runs_dir).unwrap();
    }

    #[test]
    fn answering_a_card_takes_its_sender_once_and_names_what_is_missing() {
        let handle = crate::agent::test_support::make_handle();
        let (tx, rx) = tokio::sync::oneshot::channel();
        *handle.pending_diff.lock().unwrap() = Some(tx);
        assert_eq!(
            answer(&handle, ChatControl::Diff { decision: serde_json::json!({"behavior": "allow"}) }),
            Ok(true)
        );
        assert_eq!(rx.blocking_recv().unwrap(), r#"{"behavior":"allow"}"#);
        assert_eq!(
            answer(&handle, ChatControl::Diff { decision: serde_json::json!({}) }).unwrap_err(),
            "No pending diff review for this run."
        );
        assert_eq!(
            answer(&handle, ChatControl::Permission { decision: serde_json::json!({}) })
                .unwrap_err(),
            "No pending permission request for this run."
        );
        assert_eq!(
            answer(&handle, ChatControl::Question { answer: "yes".into() }).unwrap_err(),
            "No pending question for this run."
        );
        assert_eq!(answer(&handle, ChatControl::Stop), Ok(false));
        assert!(handle.cancel.is_cancelled());
    }
}
