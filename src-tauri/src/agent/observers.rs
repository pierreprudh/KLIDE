//! Completion-triggered conversation turns. This lives in Rust, so changing
//! panels does not stop a watch or lose its notification. Only one loop may
//! write a conversation; start_run's atomic guard arbitrates a simultaneous send.
//!
//! Two things finish behind a conversation's back and deserve a turn of
//! their own: a background shell the Run asked to be told about
//! (`background.rs`), and a worker it dispatched without waiting
//! (`workers.rs`). One watcher serves both; `Followup` only says which
//! registry to ask.
use super::{background, run_is_active, start_run, workers, types::{AgentMode, StartRunRequest}};
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
}

pub(super) fn watch(app: tauri::AppHandle, run_id: String, followup: Followup, mut request: StartRunRequest) {
    request.run_id = Some(run_id.clone());
    request.initial_text.clear();
    request.attachments.clear();
    request.context = None;
    // A notification explains a result. It never inherits full-auto write or
    // command authority from the turn that launched the observer or
    // dispatched the worker.
    request.mode = AgentMode::Plan;
    request.auto_approve_commands = Some(false);
    request.require_diff_review = Some(true);
    request.max_turns = Some(4);
    let task: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> = Box::pin(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
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
                    let _ = done_rx.await;
                    let _ = app.emit("agent-observer-finished", &run_id);
                    return;
                }
                Err(_) if !followup.pending(&run_id) => return,
                // A user turn won the race. It will consume the completion,
                // or the next iteration can wake after that turn finishes.
                Err(error) if error.starts_with("A run is already active for this conversation") => continue,
                Err(error) => {
                    let what = match &followup {
                        Followup::Observer(_) => "Observer finished",
                        Followup::Worker(_) => "Worker reported",
                    };
                    let _ = app.emit("agent-observer-error", serde_json::json!({
                        "runId": run_id, "message": format!("{what}, but its follow-up could not start: {error}")
                    }));
                    // Keep the completion for the next user turn, without a
                    // retry loop hammering a missing provider or failing setup.
                    return;
                }
            }
        }
    });
    tauri::async_runtime::spawn(task);
}
