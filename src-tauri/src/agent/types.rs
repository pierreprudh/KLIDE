use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentMode {
    Chat,
    Plan,
    Goal,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
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
    /// For image attachments: the MIME type (e.g. "image/png"). Text
    /// attachments leave this `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    /// For image attachments: the full `data:<mime>;base64,…` URI. When set,
    /// the attachment is an image and is NOT folded into the message text;
    /// instead the assembly hangs it on the provider message's neutral
    /// `images` array, which each adapter translates to its own wire shape
    /// (Anthropic image block / OpenAI `image_url` / Ollama `images`). Text
    /// attachments leave this `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_uri: Option<String>,
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
    /// Max tool turns before the run hands back to the user. `None` uses the
    /// harness default; a runaway-loop guard, not a task-size limit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<usize>,
    /// Seconds a `run_command` may run before it's killed. `None` uses the
    /// harness default (180s); a hang guard, not a task limit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_timeout_secs: Option<u64>,
    /// Optional project verification command to run after an accepted edit.
    /// User-configured in Settings → Harness; the edit stays applied, and a
    /// failing check is returned to the model as a not-ok tool result.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub test_after_edit_command: Option<String>,
    /// Backend-populated project approvals. Renderer input is deliberately
    /// ignored: a compromised webview must not be able to mint command trust.
    #[serde(default, skip_deserializing)]
    pub command_allowlist: Vec<String>,
    /// Whether file edits pause for diff review before applying. `None` or
    /// `Some(true)` keeps the default review-every-edit behavior; `Some(false)`
    /// is auto-accept — edits apply without a prompt (still emitted as a diff +
    /// checkpoint so they stay visible and revertable). Safe because every
    /// applied edit writes a rollback checkpoint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub require_diff_review: Option<bool>,
    /// Whether `run_command` may execute without a permission prompt. `None`
    /// or `Some(false)` keeps the normal gate (run-scoped approvals + the
    /// project allowlist); `Some(true)` is the full-auto rung — commands run
    /// as if allowlisted. Network requests keep prompting: this flag trades
    /// away only the command gate, is chosen per conversation, and is never
    /// persisted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_approve_commands: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    /// Durable Mission linkage. A Mission Task is not this Run: each retry or
    /// race member carries the same task id with a fresh run id. The Rust
    /// harness records validation back to the Mission after it settles.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mission_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mission_task_id: Option<String>,
    /// The user's starred models, sent only when the Provider is `auto`. Stars
    /// live in the renderer's storage (`favModels.ts`), so the request carries
    /// the preference while the routing policy stays in Rust
    /// (`agent::routing`). Ignored for a concrete Provider.
    #[serde(default)]
    pub preferred_models: Vec<PreferredModel>,
    /// Backend-populated: how an `auto` request was routed, so the loop can
    /// record the decision on the Transcript right after `RunStarted`. Renderer
    /// input is ignored — the router is the only writer.
    #[serde(default, skip)]
    pub routed: Option<RouteDecision>,
}

/// One starred provider + model pair, as the picker records it.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreferredModel {
    pub provider: String,
    pub model: String,
}

/// The router's evidence for one resolved `auto` request. Travels on the
/// request only between `start_run` and the loop's first emit; the durable
/// form is the `RouteResolved` event.
#[derive(Clone, Debug, PartialEq)]
pub struct RouteDecision {
    pub reason: String,
    pub skipped: Vec<String>,
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
pub struct AgentValidationCheckSummary {
    pub id: String,
    pub label: String,
    pub status: String,
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentValidationSummary {
    pub status: String,
    #[serde(default)]
    pub checks: Vec<AgentValidationCheckSummary>,
    #[serde(default)]
    pub files_changed: u32,
    #[serde(default)]
    pub commands_run: u32,
    #[serde(default)]
    pub commands_failed: u32,
    #[serde(default)]
    pub diff_reviews: u32,
    #[serde(default)]
    pub permissions_approved: u32,
    #[serde(default)]
    pub permissions_denied: u32,
    #[serde(default)]
    pub warnings: Vec<String>,
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
    /// One-line summary of the run's most recent assistant turn — "what it
    /// last did" — for the Mission Control row. Enriched from the transcript
    /// by `write_summary` when absent. `None` before any assistant turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_event: Option<String>,
    /// Name of the linked git worktree the run executed in, when `cwd` is a
    /// linked worktree rather than the repo's main checkout. `None` for runs in
    /// a main working copy (the common case) or outside a git repo. Derived from
    /// `cwd` in `agent_list_runs`, mirroring the delegate board's `worktree`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validation: Option<AgentValidationSummary>,
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
    /// Per-turn cost in USD. Provider-reported when available (OpenRouter
    /// sends the real charged amount), otherwise estimated from the local
    /// pricing table × token counts. `None` for local / subscription /
    /// unknown-price models. Persisted in the transcript, so reopened
    /// conversations and Mission Control show the same cost the live panel did.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub cost_usd: Option<f64>,
}

/// Wall-clock timing for one provider turn, measured in the harness around the
/// provider call itself. `model_ms` is the honest number: it starts when the
/// request goes out and ends when the response lands, so it excludes tool
/// execution and any time the run sat paused waiting for diff review. The
/// frontend used to derive a turn duration by subtracting event timestamps,
/// which folded all of that waiting into the model's time.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnTiming {
    /// Provider request → final response, ms.
    pub model_ms: u64,
    /// Provider request → first streamed token, ms. `None` for a
    /// non-streaming turn (no delta ever arrived).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub ttft_ms: Option<u64>,
}

/// One button on a permission card. `option_id` goes out as `optionId` — the
/// name the frontend mirror got wrong for as long as this was an untyped
/// `serde_json::Value` and nothing read the field.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOption {
    pub option_id: String,
    pub label: String,
    pub behavior: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub scope: Option<String>,
}

/// The payload of `AgentEvent::PermissionRequested`: what the run wants to do,
/// why, and the choices offered. `input` stays open because it is
/// capability-specific — the command gate sends
/// `{command, cwd, externalPaths, matchedAllowRule}`, a network capability
/// sends whatever it declared.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub id: String,
    pub run_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub input: serde_json::Value,
    pub summary: String,
    pub reason: String,
    pub options: Vec<PermissionOption>,
}

impl PermissionRequest {
    /// The command this gate is asking about, when the capability is the
    /// command gate. `None` for network and other capabilities.
    pub fn command(&self) -> Option<&str> {
        self.input.get("command").and_then(|c| c.as_str())
    }

    /// A command-gate request, for tests that only care about the command and
    /// the ids that pair the request with its resolution.
    #[cfg(test)]
    pub fn for_command(id: &str, tool_call_id: &str, command: &str) -> Self {
        Self {
            id: id.to_string(),
            run_id: String::new(),
            tool_call_id: tool_call_id.to_string(),
            tool_name: "run_command".to_string(),
            input: serde_json::json!({ "command": command }),
            summary: format!("run `{command}`"),
            reason: String::new(),
            options: Vec::new(),
        }
    }
}

/// Every `code` the Harness puts on an `AgentError`, declared once.
///
/// `code` stays a `String` on the struct so a transcript written by an older
/// build still deserializes — but nothing in this build should invent a code
/// outside this list. The frontend mirror (`AgentError["code"]` in
/// `src/agent/types.ts`) must list exactly these, and
/// `frontend_mirror_matches_agent_wire` fails the build if it drifts.
pub mod error_code {
    pub const ABORTED: &str = "aborted";
    pub const MAX_TURNS: &str = "max_turns";
    pub const PROVIDER_UNAVAILABLE: &str = "provider_unavailable";
    pub const STEERING_GAVE_UP: &str = "steering_gave_up";

    /// The set the drift test compares against the frontend mirror. Nothing in
    /// the running app iterates it — it exists so the contract has one home.
    #[allow(dead_code)]
    pub const ALL: [&str; 4] = [ABORTED, MAX_TURNS, PROVIDER_UNAVAILABLE, STEERING_GAVE_UP];
}

impl AgentEvent {
    /// When this event happened.
    ///
    /// Every variant carries a `ts`, and extracting it took a 23-arm exhaustive
    /// match — written out twice, in `transcripts::append_event` and
    /// `evidence::event_ts`, so a 24th variant meant editing two matches in two
    /// files and the compiler only told you about whichever it reached first.
    pub fn ts(&self) -> i64 {
        match self {
            AgentEvent::RunStarted { ts, .. }
            | AgentEvent::ContextSnapshot { ts, .. }
            | AgentEvent::UserMessage { ts, .. }
            | AgentEvent::AssistantDelta { ts, .. }
            | AgentEvent::AssistantMessage { ts, .. }
            | AgentEvent::ToolCallStarted { ts, .. }
            | AgentEvent::ToolProgress { ts, .. }
            | AgentEvent::ToolCallFinished { ts, .. }
            | AgentEvent::ObservedToolCall { ts, .. }
            | AgentEvent::ObservedToolResult { ts, .. }
            | AgentEvent::PermissionRequested { ts, .. }
            | AgentEvent::PermissionResolved { ts, .. }
            | AgentEvent::DiffProposed { ts, .. }
            | AgentEvent::DiffResolved { ts, .. }
            | AgentEvent::FileChanged { ts, .. }
            | AgentEvent::ArtifactProduced { ts, .. }
            | AgentEvent::RunResult { ts, .. }
            | AgentEvent::RunError { ts, .. }
            | AgentEvent::ContextCompacted { ts, .. }
            | AgentEvent::UserQuestionRequested { ts, .. }
            | AgentEvent::UserQuestionResolved { ts, .. }
            | AgentEvent::SubagentRequested { ts, .. }
            | AgentEvent::SubagentResolved { ts, .. }
            | AgentEvent::AdvisorRequested { ts, .. }
            | AgentEvent::AdvisorResolved { ts, .. }
            | AgentEvent::SteeringInjected { ts, .. }
            | AgentEvent::RouteResolved { ts, .. } => *ts,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentError {
    /// One of [`error_code::ALL`].
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
    /// Bytes are separate from the readable workbook diff.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary: Option<BinaryWrite>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryWrite {
    pub old_base64: Option<String>,
    pub new_base64: String,
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
        /// Measured provider timing for this turn. `None` on messages the
        /// harness synthesizes itself (turn-limit / give-up notices), which
        /// never made a provider call.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        timing: Option<AgentTurnTiming>,
        ts: i64,
    },
    ToolCallStarted {
        run_id: String,
        tool_call_id: String,
        name: String,
        input: serde_json::Value,
        summary: String,
        /// The Tool's capability at dispatch time, as
        /// [`crate::agent::tools::ToolCapability::wire`].
        ///
        /// Recorded because a Tool's *name* does not tell a later reader what it
        /// did: a workspace-defined command tool is called whatever its author
        /// called it, so `summarize_validation` counted zero commands for it and
        /// reported the run `unverified`. `None` on transcripts written before
        /// this field existed.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        capability: Option<String>,
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
    /// A tool the *delegate CLI* ran itself, reported by its own structured
    /// output stream (`claude -p --output-format stream-json`).
    ///
    /// Separate from [`AgentEvent::ToolCallStarted`] on purpose. That variant
    /// means "Klide dispatched this call under a capability, after whatever
    /// permission policy applied"; this one means "the delegate did this under
    /// its own permission mode, and Klide only watched". Folding the two
    /// together would let an observed `Bash` be counted as a command Klide
    /// verified (`summarize_validation` counts capabilities) and would tell the
    /// user a diff was reviewed when nothing reviewed it.
    ObservedToolCall {
        run_id: String,
        tool_call_id: String,
        /// The delegate that ran it, e.g. `claude-code`.
        provider: String,
        name: String,
        input: serde_json::Value,
        summary: String,
        ts: i64,
    },
    ObservedToolResult {
        run_id: String,
        tool_call_id: String,
        ok: bool,
        content: String,
        ts: i64,
    },
    PermissionRequested {
        run_id: String,
        request: PermissionRequest,
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
    /// A file an approved `run_command` left behind — a deck built by a
    /// script, a PDF from pandoc, a generated report. No write tool ran, so
    /// there is no diff review and no checkpoint behind this: it is the
    /// harness noticing that the workspace gained something, by reading the
    /// dirty set either side of the command.
    ArtifactProduced {
        run_id: String,
        path: String,
        /// Size on disk when the command finished. Zero when the file could
        /// not be stat'd, which is a report worth keeping, not a reason to
        /// drop the event.
        bytes: u64,
        /// The command created the file, rather than rewriting one that was
        /// already there.
        created: bool,
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
    /// A compaction marker written into the transcript when the user compacts
    /// the conversation to free context. On replay, everything BEFORE this
    /// marker collapses into a single system message holding `summary`; events
    /// after it replay verbatim. So the model keeps the gist of old turns plus
    /// the recent exchanges in full, at a fraction of the tokens.
    ContextCompacted {
        run_id: String,
        summary: String,
        ts: i64,
    },
    /// The loop monitor detected the run repeating a tool call without progress
    /// and injected a one-time steering nudge into the model's context. `reason`
    /// is the short human-readable line the transcript shows (the long nudge the
    /// model receives lives only in the provider messages, not here). See
    /// `steering.rs`.
    SteeringInjected {
        run_id: String,
        reason: String,
        ts: i64,
    },
    /// An `auto` request settled on this concrete pair. Emitted once, right
    /// after `RunStarted` (which already carries the resolved provider and
    /// model, so every surface shows what actually runs), and only for runs
    /// that were requested as `auto`. `reason` is why this one; `skipped`
    /// names each candidate ranked above it and what ruled it out — the
    /// decision is auditable from the Transcript, not just its outcome. A
    /// continuation of an `auto` thread reuses its origin and emits nothing:
    /// the pair is locked for the conversation. See `routing.rs`.
    RouteResolved {
        run_id: String,
        provider: String,
        model: String,
        reason: String,
        skipped: Vec<String>,
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
    /// The model called `spawn_subagent` and is paused waiting for a child
    /// subagent run to finish. The frontend runs the named (read-only)
    /// subagent as a nested run and resolves through `agent_resolve_question`
    /// (the spawn shares the question pause's oneshot); the subagent's report
    /// becomes the tool result. A paired `SubagentResolved` is emitted so the
    /// transcript captures both halves.
    SubagentRequested {
        run_id: String,
        request_id: String,
        subagent: String,
        task: String,
        ts: i64,
    },
    SubagentResolved {
        run_id: String,
        request_id: String,
        result: String,
        ts: i64,
    },
    /// The model called `consult_advisor` and is paused waiting for guidance
    /// from a stronger advisor model. Unlike a subagent (a nested *agentic*
    /// run with tools), the advisor is a one-shot consultation: the frontend
    /// asks a bigger model (or a Claude Code session) the executor's question
    /// and resolves through `agent_resolve_question` (shared oneshot) with the
    /// advice, which becomes the tool result. A paired `AdvisorResolved` is
    /// emitted so the transcript captures both halves.
    AdvisorRequested {
        run_id: String,
        request_id: String,
        question: String,
        ts: i64,
    },
    AdvisorResolved {
        run_id: String,
        request_id: String,
        advice: String,
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
    fn renderer_cannot_deserialize_command_approvals() {
        let request: StartRunRequest = serde_json::from_value(serde_json::json!({
            "workspaceRoot": "/tmp/project",
            "mode": "goal",
            "provider": "mock",
            "model": "mock",
            "initialText": "test",
            "commandAllowlist": ["rm -rf important"]
        }))
        .unwrap();
        assert!(
            request.command_allowlist.is_empty(),
            "command trust must be loaded by native code, never supplied over IPC"
        );
    }

    #[test]
    fn agent_usage_serializes_camel_case_and_omits_nones() {
        let u = AgentUsage {
            prompt_tokens: Some(120),
            completion_tokens: None,
            eval_duration_ms: Some(450),
            prompt_eval_duration_ms: None,
            cost_usd: None,
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
                cost_usd: None,
            }),
            timing: None,
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
            timing: None,
            ts: 0,
        };
        let v = serde_json::to_value(&event).expect("serialize");
        assert!(v.get("usage").is_none(), "got: {v}");
    }

    #[test]
    fn assistant_message_carries_turn_timing_as_camel_case() {
        // The panel reads `modelMs` / `ttftMs` off this event to report the
        // provider's own time instead of wall clock. A rename here silently
        // turns both numbers back into estimates.
        let event = AgentEvent::AssistantMessage {
            run_id: "r1".into(),
            message_id: "m1".into(),
            content: vec![],
            usage: None,
            timing: Some(AgentTurnTiming {
                model_ms: 4_200,
                ttft_ms: Some(310),
            }),
            ts: 0,
        };
        let v = serde_json::to_value(&event).expect("serialize");
        assert_eq!(v["timing"]["modelMs"], 4_200);
        assert_eq!(v["timing"]["ttftMs"], 310);

        // Harness-authored messages made no provider call, so the key stays off
        // the wire rather than reporting a zero-length turn.
        let untimed = AgentEvent::AssistantMessage {
            run_id: "r1".into(),
            message_id: "m2".into(),
            content: vec![],
            usage: None,
            timing: None,
            ts: 0,
        };
        let v = serde_json::to_value(&untimed).expect("serialize");
        assert!(v.get("timing").is_none(), "got: {v}");
    }

    /// Read `src/agent/types.ts` — the frontend's hand-written mirror of the
    /// wire types in this file.
    fn frontend_mirror() -> String {
        std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/agent/types.ts"),
        )
        .expect("read src/agent/types.ts")
    }

    /// The body of a `export type X = …;` union in the mirror, as source text.
    fn mirror_union(ts: &str, name: &str) -> String {
        let marker = format!("export type {name} =");
        let start = ts
            .find(&marker)
            .unwrap_or_else(|| panic!("{marker} in src/agent/types.ts"))
            + marker.len();
        // Every declaration in the mirror is top-level, so the next one
        // begins the first `\nexport ` after this union ends.
        let end = ts[start..]
            .find("\nexport ")
            .map(|i| start + i)
            .unwrap_or(ts.len());
        ts[start..end].to_string()
    }

    /// Every double-quoted string in a slice of mirror source.
    fn quoted(src: &str) -> Vec<String> {
        src.split('"')
            .skip(1)
            .step_by(2)
            .map(String::from)
            .collect()
    }

    fn snake_case(variant: &str) -> String {
        let mut out = String::new();
        for (i, ch) in variant.char_indices() {
            if ch.is_ascii_uppercase() {
                if i != 0 {
                    out.push('_');
                }
                out.push(ch.to_ascii_lowercase());
            } else {
                out.push(ch);
            }
        }
        out
    }

    /// The `AgentEvent` variant names declared in *this* file, read from source.
    ///
    /// Reading the source rather than keeping a hand-written list is what makes
    /// this test self-maintaining: a new variant added below shows up here for
    /// free, so the mirror has to gain it too or the build fails.
    fn rust_event_types() -> Vec<String> {
        let rs = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/agent/types.rs"),
        )
        .expect("read src/agent/types.rs");
        let start = rs
            .find("pub enum AgentEvent {")
            .expect("AgentEvent enum in this file");
        let body = &rs[start..];
        let end = body.find("\n}").expect("end of AgentEvent enum");
        body[..end]
            .lines()
            // rustfmt puts each variant at exactly one indent level, and doc
            // comments start with `///`, so this matches variants only.
            .filter_map(|line| line.strip_prefix("    ")?.strip_suffix(" {"))
            .filter(|name| name.starts_with(|c: char| c.is_ascii_uppercase()))
            .map(snake_case)
            .collect()
    }

    #[test]
    fn frontend_mirror_matches_agent_wire() {
        // `AgentEvent` is the only way any surface learns what a Run is doing,
        // and its two halves are typed by hand in two languages. Nothing else
        // checks them: a variant added in Rust and forgotten in TypeScript
        // reaches every consumer as an unhandled `switch` case and silently
        // fails to render. This is the seam that makes that a build failure.
        // Same trick as `delegate::tests::frontend_delegate_ids_match_all`.
        let ts = frontend_mirror();
        let union = mirror_union(&ts, "AgentEvent");
        // The union's members carry other string literals too (inline field
        // unions like `"allow" | "deny"`), so match on the discriminant's
        // `type: "…"` prefix rather than on every quoted string.
        let mut frontend: Vec<String> = union
            .match_indices("type: \"")
            .map(|(i, m)| {
                let rest = &union[i + m.len()..];
                rest[..rest.find('"').expect("closing quote")].to_string()
            })
            .collect();
        frontend.sort();
        frontend.dedup();

        let mut backend = rust_event_types();
        backend.sort();

        assert_eq!(
            backend, frontend,
            "AgentEvent drifted between src-tauri/src/agent/types.rs and \
src/agent/types.ts — update both"
        );
    }

    #[test]
    fn frontend_mirror_matches_error_codes() {
        // The mirror used to declare ten codes: three real, seven invented,
        // and it was missing `steering_gave_up` — which the loop monitor does
        // emit. A closed union that lists codes nobody sends is worse than no
        // union, because it reads as a checked contract.
        let ts = frontend_mirror();
        let start = ts
            .find("export type AgentError = {")
            .expect("AgentError in src/agent/types.ts");
        let body = &ts[start..];
        let end = body
            .find("message:")
            .expect("message field after code union");
        let mut frontend = quoted(&body[..end]);
        frontend.sort();

        let mut backend: Vec<String> = error_code::ALL.iter().map(|c| c.to_string()).collect();
        backend.sort();

        assert_eq!(
            backend, frontend,
            "AgentError.code drifted between error_code::ALL and \
src/agent/types.ts — update both"
        );
    }
}
