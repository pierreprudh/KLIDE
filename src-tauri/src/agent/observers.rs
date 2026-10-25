//! Completion-triggered conversation turns. This lives in Rust, so changing
//! panels does not stop a watch or lose its notification. Only one loop may
//! write a conversation; start_run's atomic guard arbitrates a simultaneous send.
//!
//! Two things finish behind a conversation's back and deserve a turn of
//! their own: a background shell the Run asked to be told about
//! (`background.rs`), and a worker it dispatched without waiting
//! (`workers.rs`). One watcher serves both; `Followup` only says which
//! registry to ask.
use super::{background, run_is_active, start_run, with_run_handle, workers, RunSupervisor, types::{AgentMode, StartRunRequest}};
use tauri::Emitter;

/// What a follow-up turn is for. The id is what the registry is asked about.
#[derive(Clone, Debug)]
pub(super) enum Followup {
    /// A background shell the conversation watches, by shell id.
    Observer(String),
    /// A worker dispatched in the background, by its child Run id.
    Worker(String),
}

impl Followup {
    fn prepare_request(&self, run_id: &str, mut request: StartRunRequest) -> StartRunRequest {
        request.run_id = Some(run_id.to_string());
        request.initial_text.clear();
        request.attachments.clear();
        request.context = None;
        if matches!(self, Self::Observer(_)) {
            request.auto_approve_commands = Some(false);
            request.require_diff_review = Some(true);
            request.mode = AgentMode::Plan;
            request.max_turns = Some(4);
        }
        // A worker completion resumes the original task, including the
        // operator's command and edit policy. Dispatch still has its own gate.
        request
    }

    /// A worker's follow-up runs on the rung the conversation stands on now,
    /// not the one it stood on at dispatch: a flip made while the parent's Run
    /// is up carries. Once that Run is gone the last value read stays. A shell
    /// notification never borrows the rung.
    pub(super) fn adopt_live_policy(&self, sup: &dyn RunSupervisor, run_id: &str, request: &mut StartRunRequest) {
        if !matches!(self, Self::Worker(_)) { return; }
        if let Some(full_auto) = with_run_handle(sup, run_id, |h| h.subject.full_auto(h.trust.commands_policy())) {
            request.auto_approve_commands = Some(full_auto);
        }
    }

    /// None = delivered or cancelled, false = still working, true = ready.
    pub(super) fn state(&self, run_id: &str) -> Option<bool> {
        match self {
            Followup::Observer(shell_id) => background::notification_state(run_id, shell_id),
            Followup::Worker(child_id) => workers::notification_state(run_id, child_id),
        }
    }

    pub(super) fn pending(&self, run_id: &str) -> bool {
        self.state(run_id).is_some()
    }

    fn emit_error(&self, app: &tauri::AppHandle, run_id: &str, what_went_wrong: &str) {
        let what = match self {
            Followup::Observer(_) => "Observer finished",
            Followup::Worker(_) => "Worker reported",
        };
        let _ = app.emit("agent-observer-error", serde_json::json!({
            "runId": run_id, "message": format!("{what}, but {what_went_wrong}")
        }));
    }
}

pub(super) fn watch(app: tauri::AppHandle, run_id: String, followup: Followup, request: StartRunRequest) {
    let mut request = followup.prepare_request(&run_id, request);
    let task: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> = Box::pin(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            followup.adopt_live_policy(&super::TauriSupervisor::new(app.clone()), &run_id, &mut request);
            match followup.state(&run_id) {
                None => return,
                Some(false) => continue,
                Some(true) => {}
            }
            if run_is_active(&app, &run_id) { continue; }
            let (done_tx, done_rx) = tokio::sync::oneshot::channel();
            let channel = tauri::ipc::Channel::new(|_| Ok(()));
            match start_run(app.clone(), request.clone(), channel, Some(done_tx), Some(&followup)).await {
                Ok(_) => {
                    // A stopped turn settles Ok; only a turn that broke is an
                    // Err, and it must not be announced as an update.
                    match done_rx.await {
                        Ok(Err(error)) => followup.emit_error(&app, &run_id, &format!("its follow-up failed: {error}")),
                        _ => { let _ = app.emit("agent-observer-finished", &run_id); }
                    }
                    return;
                }
                Err(_) if !followup.pending(&run_id) => return,
                // A user turn won the race. It will consume the completion,
                // or the next iteration can wake after that turn finishes.
                Err(error) if error.starts_with("A run is already active for this conversation") => continue,
                Err(error) => {
                    followup.emit_error(&app, &run_id, &format!("its follow-up could not start: {error}"));
                    // Keep the completion for the next user turn, without a
                    // retry loop hammering a missing provider or failing setup.
                    return;
                }
            }
        }
    });
    tauri::async_runtime::spawn(task);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::test_support::{test_request, FakeSupervisor};

    #[test]
    fn worker_followup_preserves_full_auto_and_original_budget() {
        let mut original = test_request("/tmp/workers", &[]);
        original.max_turns = Some(32);
        original.auto_approve_commands = Some(true);
        let request = Followup::Worker("child".into()).prepare_request("parent", original);
        assert!(matches!(request.mode, AgentMode::Goal));
        assert_eq!(request.max_turns, Some(32));
        assert_eq!(request.auto_approve_commands, Some(true));
        assert_eq!(request.require_diff_review, Some(false));
        assert_eq!(request.run_id.as_deref(), Some("parent"));
        assert!(request.initial_text.is_empty());
        assert!(request.attachments.is_empty());
        assert!(request.context.is_none());
    }

    #[test]
    fn shell_notifications_and_plan_workers_stay_read_only() {
        let request = Followup::Observer("shell".into())
            .prepare_request("parent", test_request("/tmp/workers", &[]));
        assert!(matches!(request.mode, AgentMode::Plan));
        assert_eq!(request.max_turns, Some(4));
        assert_eq!(request.auto_approve_commands, Some(false));
        assert_eq!(request.require_diff_review, Some(true));
        let mut original = test_request("/tmp/workers", &[]);
        original.mode = AgentMode::Plan;
        original.max_turns = None;
        let request = Followup::Worker("child".into()).prepare_request("parent", original);
        assert!(matches!(request.mode, AgentMode::Plan));
        assert_eq!(request.max_turns, None);
    }

    #[test]
    fn worker_followup_keeps_review_policy_when_full_auto_is_off() {
        let mut original = test_request("/tmp/workers", &[]);
        original.auto_approve_commands = Some(false);
        original.require_diff_review = Some(true);
        let request = Followup::Worker("child".into()).prepare_request("parent", original);
        assert_eq!(request.auto_approve_commands, Some(false));
        assert_eq!(request.require_diff_review, Some(true));
    }

    /// Test 3: dispatched on review, flipped to Full auto from the foot bar
    /// while the parent still runs — the follow-up runs on the flip.
    #[test]
    fn a_rung_flipped_after_dispatch_reaches_the_worker_followup() {
        let mut original = test_request("/tmp/workers", &[]);
        original.auto_approve_commands = Some(false);
        let sup = FakeSupervisor::for_request("parent", &original);
        let worker = Followup::Worker("child".into());
        let mut request = worker.prepare_request("parent", original.clone());
        worker.adopt_live_policy(&sup, "parent", &mut request);
        assert_eq!(request.auto_approve_commands, Some(false), "no flip yet");

        sup.with_handle("parent", &mut |h| h.trust.set_commands_policy(true));
        worker.adopt_live_policy(&sup, "parent", &mut request);
        assert_eq!(request.auto_approve_commands, Some(true), "the flip carries");

        sup.with_handle("parent", &mut |h| h.trust.set_commands_policy(false));
        worker.adopt_live_policy(&sup, "parent", &mut request);
        assert_eq!(request.auto_approve_commands, Some(false), "and so does flipping back");

        // The parent's Run has ended: the last value read stays.
        sup.with_handle("parent", &mut |h| h.trust.set_commands_policy(true));
        worker.adopt_live_policy(&sup, "parent", &mut request);
        sup.runs.lock().unwrap().clear();
        worker.adopt_live_policy(&sup, "parent", &mut request);
        assert_eq!(request.auto_approve_commands, Some(true));
    }

    #[test]
    fn a_shell_notification_never_borrows_the_live_rung() {
        let mut original = test_request("/tmp/workers", &[]);
        original.auto_approve_commands = Some(true);
        let sup = FakeSupervisor::for_request("parent", &original);
        sup.with_handle("parent", &mut |h| h.trust.set_commands_policy(true));
        let shell = Followup::Observer("shell".into());
        let mut request = shell.prepare_request("parent", original);
        shell.adopt_live_policy(&sup, "parent", &mut request);
        assert_eq!(request.auto_approve_commands, Some(false));
    }
}
