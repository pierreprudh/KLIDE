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
    Asking { kind: &'static str, request_id: String, summary: String },
    /// Answered, or the Run ended: nothing is waiting any more.
    Clear,
}

pub fn attention_for(event: &AgentEvent) -> Option<Attention> {
    match event {
        AgentEvent::PermissionRequested { request, .. } => Some(Attention::Asking {
            kind: "permission",
            request_id: request.id.clone(),
            summary: request.summary.clone(),
        }),
        AgentEvent::UserQuestionRequested { request_id, question, .. } => Some(Attention::Asking {
            kind: "question",
            request_id: request_id.clone(),
            summary: question.clone(),
        }),
        AgentEvent::PermissionResolved { .. }
        | AgentEvent::UserQuestionResolved { .. }
        | AgentEvent::RunResult { .. }
        | AgentEvent::RunError { .. } => Some(Attention::Clear),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::types::{AgentError, PermissionRequest};

    #[test]
    fn a_card_or_a_question_asks_and_an_answer_or_an_end_clears() {
        let ask = AgentEvent::PermissionRequested {
            run_id: "c".into(),
            request: PermissionRequest { id: "p1".into(), run_id: "c".into(), tool_call_id: "t".into(), tool_name: "run_command".into(), input: serde_json::json!({}), summary: "Run npm test".into(), reason: String::new(), options: vec![] },
            ts: 0,
        };
        assert_eq!(attention_for(&ask), Some(Attention::Asking { kind: "permission", request_id: "p1".into(), summary: "Run npm test".into() }));
        let json = serde_json::to_value(attention_for(&ask).unwrap()).unwrap();
        assert_eq!(json, serde_json::json!({ "state": "asking", "kind": "permission", "requestId": "p1", "summary": "Run npm test" }));
        let end = AgentEvent::RunError { run_id: "c".into(), error: AgentError { code: "cancelled".into(), message: "x".into(), detail: None, retryable: false }, ts: 0 };
        assert_eq!(attention_for(&end), Some(Attention::Clear));
        assert_eq!(serde_json::to_value(Attention::Clear).unwrap(), serde_json::json!({ "state": "clear" }));
    }
}
