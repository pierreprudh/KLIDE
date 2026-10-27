//! When a Run needs a person — a permission card or a question — and when it
//! no longer does. The run's own `agent-run:{id}` stream already carries this,
//! but only a mounted conversation listens there; the rail and the toast need
//! to know about a conversation you walked away from. `broadcast` (mod.rs)
//! emits these app-wide as `run:attention`. A background worker's asking goes
//! out as `worker:status` instead (workers.rs), naming its parent.

use super::types::AgentEvent;
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "state")]
pub enum Attention {
    /// Waiting on a person: `kind` is "permission" or "question".
    Asking { kind: &'static str, request_id: String, summary: String, #[serde(skip_serializing_if = "Vec::is_empty")] external_paths: Vec<String> },
    /// Answered, or the Run ended: nothing is waiting any more.
    Clear,
}

pub fn attention_for(event: &AgentEvent) -> Option<Attention> {
    match event {
        AgentEvent::PermissionRequested { request, .. } => Some(Attention::Asking {
            kind: "permission",
            request_id: request.id.clone(),
            summary: request.summary.clone(),
            external_paths: external_paths(request),
        }),
        AgentEvent::UserQuestionRequested { request_id, question, .. } => Some(Attention::Asking {
            kind: "question",
            request_id: request_id.clone(),
            summary: question.clone(),
            external_paths: Vec::new(),
        }),
        AgentEvent::PermissionResolved { .. }
        | AgentEvent::UserQuestionResolved { .. }
        | AgentEvent::RunResult { .. }
        | AgentEvent::RunError { .. } => Some(Attention::Clear),
        _ => None,
    }
}

pub(super) fn external_paths(request: &super::types::PermissionRequest) -> Vec<String> {
    request.input.get("externalPaths").and_then(|v| v.as_array())
        .map(|paths| paths.iter().filter_map(|p| p.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

/// Both app-hosted events and the daemon's GUI forwarding path pass here.
/// Keeping classification here prevents host placement changing notifications.
pub(super) fn notifications_for(run_id: &str, seq: u64, event: &AgentEvent) -> Option<(&'static str, serde_json::Value)> {
    if super::workers::identity(run_id).is_some() {
        return super::workers::record_status(run_id, seq, event)
            .map(|status| ("worker:status", serde_json::to_value(status).unwrap()));
    }
    attention_for(event).map(|attention| {
        let mut payload = serde_json::to_value(attention).unwrap();
        payload["runId"] = serde_json::json!(run_id);
        ("run:attention", payload)
    })
}

pub(super) fn emit(app: &tauri::AppHandle, run_id: &str, seq: u64, event: &AgentEvent) {
    use tauri::Emitter;
    if let Some((name, payload)) = notifications_for(run_id, seq, event) {
        let _ = app.emit(name, payload);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::types::{AgentError, PermissionRequest};

    #[test]
    fn forwarded_events_publish_asking_and_clearing_with_their_run_identity() {
        let request = PermissionRequest {
            id: "forwarded-perm".into(), run_id: "remote-run".into(), tool_call_id: "t".into(),
            tool_name: "Edit".into(), input: serde_json::json!({"externalPaths":["/other/test.sh"]}),
            summary: "Edit test.sh".into(), reason: "Outside its working folder".into(), options: vec![],
        };
        let event = AgentEvent::PermissionRequested { run_id: "remote-run".into(), request, ts: 0 };
        let (name, payload) = notifications_for("remote-run", 3, &event).unwrap();
        assert_eq!(name, "run:attention");
        assert_eq!(payload["runId"], "remote-run");
        assert_eq!(payload["externalPaths"], serde_json::json!(["/other/test.sh"]));
        let end = AgentEvent::RunResult { run_id: "remote-run".into(), result: serde_json::json!({}), ts: 1 };
        assert_eq!(notifications_for("remote-run", 4, &end).unwrap().1,
            serde_json::json!({"runId":"remote-run", "state":"clear"}));
    }

    #[test]
    fn worker_snapshot_keeps_the_live_request_provider_and_external_paths_until_settlement() {
        use super::super::{workers, types::AgentMode};
        let child = "notification-worker-child";
        let parent = "notification-worker-parent";
        workers::register(parent, child, "Claude Code", "implementer", None, None);
        let start = AgentEvent::RunStarted { run_id: child.into(), cwd: None,
            mode: AgentMode::Goal, provider: "claude-code".into(), model: "default".into(), ts: 0 };
        assert_eq!(notifications_for(child, 0, &start).unwrap().0, "worker:status");
        let ask = AgentEvent::PermissionRequested { run_id: child.into(), request: PermissionRequest {
            id: "worker-perm".into(), run_id: child.into(), tool_call_id: "t".into(), tool_name: "Edit".into(),
            input: serde_json::json!({"externalPaths":["/other/test.sh"]}), summary: "Edit test.sh".into(),
            reason: String::new(), options: vec![],
        }, ts: 1 };
        let (_, live) = notifications_for(child, 2, &ask).unwrap();
        let snapshot = workers::active_statuses().into_iter().find(|s| s.run_id == child).unwrap();
        assert_eq!(serde_json::to_value(snapshot).unwrap(), live);
        assert_eq!(live["provider"], "claude-code");
        assert_eq!(live["requestId"], "worker-perm");
        assert_eq!(live["externalPaths"], serde_json::json!(["/other/test.sh"]));
        let end = AgentEvent::RunResult { run_id: child.into(), result: serde_json::json!({}), ts: 2 };
        notifications_for(child, 3, &end).unwrap();
        assert!(!workers::active_statuses().iter().any(|s| s.run_id == child));
        assert!(notifications_for(child, 2, &ask).is_none());
        workers::release(parent);
    }

    #[test]
    fn a_card_or_a_question_asks_and_an_answer_or_an_end_clears() {
        let ask = AgentEvent::PermissionRequested {
            run_id: "c".into(),
            request: PermissionRequest { id: "p1".into(), run_id: "c".into(), tool_call_id: "t".into(), tool_name: "run_command".into(), input: serde_json::json!({}), summary: "Run npm test".into(), reason: String::new(), options: vec![] },
            ts: 0,
        };
        assert_eq!(attention_for(&ask), Some(Attention::Asking { kind: "permission", request_id: "p1".into(), summary: "Run npm test".into(), external_paths: vec![] }));
        let json = serde_json::to_value(attention_for(&ask).unwrap()).unwrap();
        assert_eq!(json, serde_json::json!({ "state": "asking", "kind": "permission", "requestId": "p1", "summary": "Run npm test" }));
        let end = AgentEvent::RunError { run_id: "c".into(), error: AgentError { code: "cancelled".into(), message: "x".into(), detail: None, retryable: false }, ts: 0 };
        assert_eq!(attention_for(&end), Some(Attention::Clear));
        assert_eq!(serde_json::to_value(Attention::Clear).unwrap(), serde_json::json!({ "state": "clear" }));
    }
}
