use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentMode {
    Chat,
    Plan,
    Goal,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRunStatus {
    Queued,
    Running,
    WaitingForPermission,
    WaitingForDiff,
    Paused,
    Done,
    Error,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAttachment {
    pub path: String,
    pub content: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentContextSnapshot {
    pub workspace_root: Option<String>,
    #[serde(default)]
    pub attachments: Vec<AgentAttachment>,
    #[serde(default)]
    pub lens_items: Vec<serde_json::Value>,
    #[serde(default)]
    pub estimated_tokens: usize,
    #[serde(default)]
    pub omitted: Vec<serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRunRequest {
    /// Client-supplied run id. When present, the harness keys the transcript,
    /// supervisor handle, and events under this id instead of minting its own —
    /// so the AI panel's conversation id, the on-disk transcript, and the
    /// Mission Control row all share one id. Falls back to a fresh id when
    /// absent (older callers, delegate spawns).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub workspace_root: Option<String>,
    pub mode: AgentMode,
    pub provider: String,
    pub model: String,
    pub initial_text: String,
    #[serde(default)]
    pub attachments: Vec<AgentAttachment>,
    pub context: Option<AgentContextSnapshot>,
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub disabled_tools: Vec<String>,
    /// Context window (num_ctx) for local models — the frontend resolves each
    /// model's real trained window (or a user override) and passes it here.
    /// `None` lets the provider adapter fall back to its default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub num_ctx: Option<usize>,
    /// Reply budget (num_predict) for local models. `None` keeps the provider
    /// default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub num_predict: Option<usize>,
    /// Reflection/thinking preference for models that support it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reflection_level: Option<String>,
    /// Max read-only tool calls to run concurrently within one turn. `None`
    /// or `Some(1)` keeps execution sequential.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_parallel_tools: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRunResponse {
    pub run_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitUserTurnRequest {
    pub run_id: String,
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<AgentAttachment>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDecisionRequest {
    pub run_id: String,
    pub request_id: String,
    pub decision: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffDecisionRequest {
    pub run_id: String,
    pub proposal_id: String,
    pub decision: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunSummary {
    pub id: String,
    pub path: String,
    pub source: String,
    pub title: String,
    pub status: String,
    pub provider: String,
    pub model: String,
    pub cwd: Option<String>,
    pub project: Option<String>,
    pub git_branch: Option<String>,
    pub created_ms: i64,
    pub updated_ms: i64,
    pub message_count: u32,
    /// Sum of `assistant_message.usage.promptTokens` across the run.
    /// 0 when the provider never reported usage.
    #[serde(default)]
    pub input_tokens: i64,
    /// Sum of `assistant_message.usage.completionTokens` across the run.
    #[serde(default)]
    pub output_tokens: i64,
    /// Count of unique paths in `file_changed` events. 0 when the run
    /// didn't touch any files (or the events haven't been written yet —
    /// see `write_summary` for the lazy-enrich behaviour).
    #[serde(default)]
    pub files_touched: u32,
    /// Estimated run cost in USD, computed from `model` + token totals via
    /// `crate::pricing::cost_for_run`. `None` for local / subscription /
    /// passthrough / unknown models.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AgentContentBlock {
    Text {
        text: String,
    },
    Thinking {
        text: String,
    },
    ToolCall {
        tool_call_id: String,
        name: String,
        input: serde_json::Value,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub ok: bool,
    pub content: String,
    pub metadata: Option<serde_json::Value>,
}

/// Real token accounting reported by the provider (Ollama eval counts,
/// OpenAI/Anthropic usage blocks). All fields optional — adapters fill
/// what their wire format exposes; the UI falls back to estimates when
/// absent. Mirrors `crate::AiUsage` but lives in the agent protocol so the
/// frontend can decode it without depending on a private provider type.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub prompt_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub completion_tokens: Option<u64>,
    /// Time spent generating the completion, ms (Ollama eval_duration).
    /// The frontend prefers this over wall-clock when computing tok/s.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub eval_duration_ms: Option<u64>,
    /// Time spent processing the prompt, ms (Ollama prompt_eval_duration).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub prompt_eval_duration_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentError {
    pub code: String,
    pub message: String,
    pub detail: Option<String>,
    pub retryable: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffProposal {
    pub id: String,
    pub run_id: String,
    pub tool_call_id: String,
    pub path: String,
    pub old_content: String,
    pub new_content: String,
    pub old_hash: String,
    pub new_hash: String,
    pub unified_diff: String,
    pub is_create: bool,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AgentEvent {
    RunStarted {
        run_id: String,
        cwd: Option<String>,
        mode: AgentMode,
        provider: String,
        model: String,
        ts: i64,
    },
    ContextSnapshot {
        run_id: String,
        snapshot: AgentContextSnapshot,
        ts: i64,
    },
    UserMessage {
        run_id: String,
        message_id: String,
        text: String,
        attachments: Vec<AgentAttachment>,
        ts: i64,
    },
    AssistantDelta {
        run_id: String,
        message_id: String,
        text: String,
        thinking: Option<String>,
        ts: i64,
    },
    AssistantMessage {
        run_id: String,
        message_id: String,
        content: Vec<AgentContentBlock>,
        /// Real provider-reported token accounting for this turn. The UI
        /// uses `completion_tokens` to replace the rough length/4 estimate
        /// and `eval_duration_ms` to compute an honest tok/s instead of
        /// wall-clock decode.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        usage: Option<AgentUsage>,
        ts: i64,
    },
    ToolCallStarted {
        run_id: String,
        tool_call_id: String,
        name: String,
        input: serde_json::Value,
        summary: String,
        ts: i64,
    },
    ToolProgress {
        run_id: String,
        tool_call_id: String,
        message: String,
        ts: i64,
    },
    ToolCallFinished {
        run_id: String,
        tool_call_id: String,
        result: ToolResult,
        ts: i64,
    },
    PermissionRequested {
        run_id: String,
        request: serde_json::Value,
        ts: i64,
    },
    PermissionResolved {
        run_id: String,
        request_id: String,
        decision: serde_json::Value,
        ts: i64,
    },
    DiffProposed {
        run_id: String,
        proposal: DiffProposal,
        ts: i64,
    },
    DiffResolved {
        run_id: String,
        proposal_id: String,
        decision: serde_json::Value,
        ts: i64,
    },
    FileChanged {
        run_id: String,
        path: String,
        old_hash: String,
        new_hash: String,
        ts: i64,
    },
    RunResult {
        run_id: String,
        result: serde_json::Value,
        ts: i64,
    },
    RunError {
        run_id: String,
        error: AgentError,
        ts: i64,
    },
    /// The model called `userAnswerQuestion` and is paused waiting for the
    /// user's typed reply. The frontend renders an inline Q&A card; the
    /// answer comes back through `agent_resolve_question`, which unblocks
    /// the run and emits a paired `UserQuestionResolved` so the transcript
    /// captures both halves of the exchange.
    UserQuestionRequested {
        run_id: String,
        request_id: String,
        question: String,
        ts: i64,
    },
    UserQuestionResolved {
        run_id: String,
        request_id: String,
        answer: String,
        ts: i64,
    },
}

#[cfg(test)]
mod tests {
    //! Serde round-trips for the new wire types. These are tiny but they
    //! catch the easy regressions: a field renamed to snake_case would
    //! break the frontend's camelCase decoder, and dropping `default` on
    //! an Option would break transcripts written by older builds.
    use super::*;

    #[test]
    fn agent_usage_serializes_camel_case_and_omits_nones() {
        let u = AgentUsage {
            prompt_tokens: Some(120),
            completion_tokens: None,
            eval_duration_ms: Some(450),
            prompt_eval_duration_ms: None,
        };
        let v = serde_json::to_value(&u).expect("serialize");
        assert_eq!(v["promptTokens"], 120);
        assert_eq!(v["evalDurationMs"], 450);
        // None fields must not appear on the wire — keeps the channel
        // shape stable for older frontend builds that ignore unknown
        // keys but log warnings on unexpected ones.
        assert!(v.get("completionTokens").is_none());
        assert!(v.get("promptEvalDurationMs").is_none());
    }

    #[test]
    fn agent_usage_deserializes_missing_fields_as_none() {
        // Old transcripts (pre-usage) won't have the block; the
        // `#[serde(default)]` on every field lets them decode cleanly
        // into `AgentUsage { .., None, None, None, None }`.
        let v = serde_json::json!({});
        let u: AgentUsage = serde_json::from_value(v).expect("deserialize empty");
        assert!(u.prompt_tokens.is_none());
        assert!(u.completion_tokens.is_none());
        assert!(u.eval_duration_ms.is_none());
        assert!(u.prompt_eval_duration_ms.is_none());
    }

    #[test]
    fn assistant_message_with_usage_round_trips() {
        // The full event must serialize usage as camelCase and survive
        // a deserialize round-trip. Catches accidental field renames
        // that would otherwise only surface in the running app.
        let event = AgentEvent::AssistantMessage {
            run_id: "r1".into(),
            message_id: "m1".into(),
            content: vec![AgentContentBlock::Text { text: "hi".into() }],
            usage: Some(AgentUsage {
                prompt_tokens: Some(10),
                completion_tokens: Some(5),
                eval_duration_ms: Some(200),
                prompt_eval_duration_ms: None,
            }),
            ts: 1_700_000_000,
        };
        let v = serde_json::to_value(&event).expect("serialize event");
        assert_eq!(v["type"], "assistant_message");
        assert_eq!(v["usage"]["completionTokens"], 5);
        assert_eq!(v["usage"]["evalDurationMs"], 200);
        let back: AgentEvent = serde_json::from_value(v).expect("deserialize event");
        match back {
            AgentEvent::AssistantMessage { usage, .. } => {
                assert_eq!(usage.and_then(|u| u.completion_tokens), Some(5));
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn assistant_message_without_usage_omits_field() {
        // The new field is optional. When the provider doesn't report
        // usage (subscription CLIs, old transcripts), the event must
        // not carry a `"usage": null` key on the wire.
        let event = AgentEvent::AssistantMessage {
            run_id: "r1".into(),
            message_id: "m1".into(),
            content: vec![],
            usage: None,
            ts: 0,
        };
        let v = serde_json::to_value(&event).expect("serialize");
        assert!(v.get("usage").is_none(), "got: {v}");
    }
}
