//! Completion-triggered conversation turns. This lives in Rust, so changing
//! panels does not stop a watch or lose its notification. Only one loop may
//! write a conversation; start_run's atomic guard arbitrates a simultaneous send.
use super::{background, run_is_active, start_run, types::{AgentMode, StartRunRequest}};
use tauri::Emitter;

pub(super) fn watch(app: tauri::AppHandle, run_id: String, shell_id: String, mut request: StartRunRequest) {
    request.run_id = Some(run_id.clone());
    request.initial_text.clear();
    request.attachments.clear();
    request.context = None;
    // A notification explains a result. It never inherits full-auto write or
    // command authority from the turn that launched the observer.
    request.mode = AgentMode::Plan;
    request.auto_approve_commands = Some(false);
    request.require_diff_review = Some(true);
    request.max_turns = Some(4);
    let task: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> = Box::pin(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            match background::notification_state(&run_id, &shell_id) {
                None => return,
                Some(false) => continue,
                Some(true) => {}
            }
            if run_is_active(&app, &run_id) { continue; }
            let (done_tx, done_rx) = tokio::sync::oneshot::channel();
            let channel = tauri::ipc::Channel::new(|_| Ok(()));
            match start_run(app.clone(), request.clone(), channel, Some(done_tx), Some(&shell_id)).await {
                Ok(_) => {
                    let _ = done_rx.await;
                    let _ = app.emit("agent-observer-finished", &run_id);
                    return;
                }
                Err(_) if !background::notification_pending(&run_id, &shell_id) => return,
                // A user turn won the race. It will consume the completion,
                // or the next iteration can wake after that turn finishes.
                Err(error) if error.starts_with("A run is already active for this conversation") => continue,
                Err(error) => {
                    let _ = app.emit("agent-observer-error", serde_json::json!({
                        "runId": run_id, "message": format!("Observer finished, but its follow-up could not start: {error}")
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
