use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentMode {
    Chat,
    Plan,
    Goal,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
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
    pub workspace_root: Option<String>,
    pub mode: AgentMode,
    pub provider: String,
    pub model: String,
    pub initial_text: String,
    #[serde(default)]
    pub attachments: Vec<AgentAttachment>,
    pub context: Option<AgentContextSnapshot>,
    pub system_prompt: Option<String>,
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentError {
    pub code: String,
    pub message: String,
    pub detail: Option<String>,
    pub retryable: bool,
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
    PermissionResolved {
        run_id: String,
        request_id: String,
        decision: serde_json::Value,
        ts: i64,
    },
    DiffResolved {
        run_id: String,
        proposal_id: String,
        decision: serde_json::Value,
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
}
