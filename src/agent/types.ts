import type { ProjectContextItem, ProjectContextMode } from "../contextTray";

export type AgentMode = "chat" | "plan" | "goal";

export type AgentRunStatus =
  | "queued"
  | "running"
  | "waiting_for_permission"
  | "waiting_for_diff"
  | "paused"
  | "done"
  | "error"
  | "cancelled";

export type ProviderId =
  // The router: not a Provider that serves models, but the id the picker
  // sends when the user leaves the choice to Klide. See `AUTO_PROVIDER` in
  // ./providers.ts and `agent::routing` in Rust.
  | "auto"
  | "ollama"
  | "mlx"
  | "lmstudio"
  | "llamacpp"
  | "vllm"
  | "claude-code"
  | "codex"
  | "opencode"
  | "omp"
  | "anthropic"
  | "openai"
  | "gemini"
  | "mistral"
  | "xai"
  | "deepseek"
  | "openrouter"
  // Self-hosted (custom) OpenAI-compatible endpoints. The id is minted at
  // runtime (`custom:<slug>`); config lives in the Rust custom-provider
  // store, not the static registry. See src/customProviders.ts.
  | `custom:${string}`
  // Runtime-configured CLI agents. They run in the delegate PTY surface using
  // a user-authored command template. See src/customCli.ts.
  | `cli:${string}`;

export type AgentAttachment = {
  path: string;
  content: string;
  /** For image attachments: MIME type (e.g. "image/png"). Text attachments omit it. */
  mime?: string;
  /** For image attachments: the full `data:<mime>;base64,…` URI. When set, this
   *  attachment is an image — the harness sends it to vision-capable models and
   *  the chat renders it, rather than folding it into the message text. */
  dataUri?: string;
};

export type AgentContextPayload = {
  mode: ProjectContextMode;
  items: ProjectContextItem[];
};

export type AgentContextSnapshot = {
  workspaceRoot: string | null;
  attachments: AgentAttachment[];
  lensItems: ProjectContextItem[];
  estimatedTokens: number;
  omitted: Array<{ reason: string; path?: string; count?: number }>;
};

export type AgentContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; toolCallId: string; name: string; input: unknown };

export type ToolResult = {
  ok: boolean;
  content: string;
  metadata?: Record<string, unknown>;
};

/** Real token accounting reported by the provider, carried on
 *  `assistant_message` events. All fields optional — adapters fill what
 *  their wire format exposes; the UI falls back to estimates when absent. */
export type AgentUsage = {
  promptTokens?: number;
  completionTokens?: number;
  /** Time spent generating the completion, ms (Ollama eval_duration).
   *  The live panel uses this to compute an honest tok/s instead of
   *  wall-clock decode. */
  evalDurationMs?: number;
  /** Time spent processing the prompt, ms (Ollama prompt_eval_duration). */
  promptEvalDurationMs?: number;
  /** Per-turn cost in USD. Provider-reported when available (OpenRouter
   *  sends the real charged amount), else estimated from the pricing table.
   *  Absent for local / subscription / unknown-price models. */
  costUsd?: number;
  /** The context window this turn ran in — Ollama's sized `num_ctx`. The
   *  gauge's denominator when present. Absent for hosted providers, whose
   *  window is a fixed property of the model. */
  contextWindow?: number;
};

/** Provider-turn timing measured by the Rust harness around the provider call
 *  itself, carried on `assistant_message`. `modelMs` is the honest duration:
 *  it excludes tool execution and any pause waiting on diff review, both of
 *  which land between one event's `ts` and the next. */
export type AgentTurnTiming = {
  /** Provider request → final response, ms. */
  modelMs: number;
  /** Provider request → first streamed token, ms. Absent when the turn never
   *  streamed a delta (non-streaming providers). */
  ttftMs?: number;
};

export type PermissionOption = {
  /** The wire name is `optionId`, not `id` — see `standard_gate_options` in
   *  `src-tauri/src/agent/mod.rs`. This mirror said `id` for as long as nobody
   *  read the field; the Rust `frontend_mirror_matches_agent_wire` test now
   *  pins the enclosing event, and AiPanel consumes this type directly. */
  optionId: string;
  label: string;
  behavior: "allow" | "deny" | "ask_later";
  scope?: "once" | "run" | "project" | "user";
};

export type QuestionChoices = {
  options: string[];
  moreModelsFrom?: ProviderId;
  /** `dispatch`: the options are workers and the card walks two steps — which
   *  agent, then which of its models — answering with both as one JSON object,
   *  `{"worker":"codex","model":"default"}`. Absent for a plain list. */
  kind?: "dispatch";
  /** For a dispatch: the agent the call already named; the card opens on the
   *  model step with the agent step one link back. */
  preselected?: ProviderId;
};

export type PermissionRequest = {
  id: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  summary: string;
  reason: string;
  options: PermissionOption[];
};

export type PermissionDecision =
  | { behavior: "allow"; scope: "once" | "run" | "project" | "user"; pattern?: string }
  | { behavior: "deny"; message?: string }
  | { behavior: "ask_later" };

export type DiffProposal = {
  id: string;
  runId: string;
  toolCallId: string;
  path: string;
  oldContent: string;
  newContent: string;
  oldHash: string;
  newHash: string;
  unifiedDiff: string;
  isCreate: boolean;
  reason?: string;
};

export type DiffDecision =
  /** `scope: "run"` is "Validate all": apply this edit AND auto-apply every
   *  later edit of the live run (the harness remembers it on the run handle;
   *  the panel flips its rung so later turns follow). */
  | { behavior: "apply"; scope?: "run" }
  /** `note` is the user's review feedback ("request changes") — the harness
   *  folds it into the rejection tool result so the model revises toward it
   *  instead of abandoning course. */
  | { behavior: "reject"; note?: string; message?: string };

export type AgentRunResult = {
  status: "done" | "cancelled" | "max_turns";
  message?: string;
};

/** Mirrors `AgentError` in `src-tauri/src/agent/types.rs`.
 *
 *  `code` lists exactly what the Harness emits — kept honest by the Rust
 *  `frontend_mirror_matches_error_codes` test against `error_code::ALL`. A
 *  transcript written by an older build may still carry a retired code; that
 *  only affects the `!== "aborted"` comparisons, which stay correct. */
export type AgentError = {
  code: "aborted" | "max_turns" | "provider_unavailable" | "steering_gave_up";
  message: string;
  detail?: string;
  retryable: boolean;
};

export type AgentEvent =
  | {
      type: "run_started";
      runId: string;
      cwd: string | null;
      mode: AgentMode;
      provider: ProviderId;
      model: string;
      ts: number;
    }
  | { type: "context_snapshot"; runId: string; snapshot: AgentContextSnapshot; ts: number }
  | {
      type: "user_message";
      runId: string;
      messageId: string;
      text: string;
      attachments: AgentAttachment[];
      ts: number;
    }
  | {
      type: "assistant_delta";
      runId: string;
      messageId: string;
      text: string;
      thinking?: string;
      ts: number;
    }
  | {
      type: "assistant_message";
      runId: string;
      messageId: string;
      content: AgentContentBlock[];
      /** Real provider-reported token accounting for this turn. */
      usage?: AgentUsage;
      /** Measured provider timing for this turn. Absent on messages the
       *  harness authored itself (turn-limit / give-up notices) and on
       *  transcripts written before timing was recorded. */
      timing?: AgentTurnTiming;
      ts: number;
    }
  | {
      type: "tool_call_started";
      runId: string;
      toolCallId: string;
      name: string;
      input: unknown;
      summary: string;
      /** What the Tool *was* at dispatch time — `ToolCapability::wire()` in
       *  Rust. A Tool's name doesn't say what it did: a workspace-defined
       *  command tool carries its author's name, so the Validation contract
       *  used to count zero commands for it. Absent on runs recorded before
       *  the field existed. */
      capability?: string;
      ts: number;
    }
  | { type: "tool_progress"; runId: string; toolCallId: string; message: string; ts: number }
  | { type: "tool_call_finished"; runId: string; toolCallId: string; result: ToolResult; ts: number }
  /** A tool the *delegate CLI* ran on its own, lifted from its structured
   *  output stream. Deliberately not a `tool_call_started`: Klide neither
   *  chose nor gated it — no capability, no permission prompt, no diff review
   *  — so anything rendering or counting these must keep them apart from calls
   *  the harness dispatched. */
  | {
      type: "observed_tool_call";
      runId: string;
      toolCallId: string;
      /** The delegate that ran it, e.g. `claude-code`. */
      provider: string;
      name: string;
      input: unknown;
      summary: string;
      ts: number;
    }
  | { type: "observed_tool_result"; runId: string; toolCallId: string; ok: boolean; content: string; ts: number }
  | { type: "permission_requested"; runId: string; request: PermissionRequest; ts: number }
  | { type: "permission_resolved"; runId: string; requestId: string; decision: PermissionDecision; ts: number }
  | { type: "diff_proposed"; runId: string; proposal: DiffProposal; ts: number }
  | { type: "diff_resolved"; runId: string; proposalId: string; decision: DiffDecision; ts: number }
  | { type: "file_changed"; runId: string; path: string; oldHash: string; newHash: string; ts: number }
  /** A file an approved `run_command` left behind — a deck, a PDF, a generated
   *  report. No write tool ran, so there is no diff and no checkpoint behind
   *  it: the harness read the workspace's dirty set either side of the command
   *  and this is what appeared. */
  | { type: "artifact_produced"; runId: string; path: string; bytes: number; created: boolean; ts: number }
  | { type: "run_result"; runId: string; result: AgentRunResult; ts: number }
  | { type: "run_error"; runId: string; error: AgentError; ts: number }
  /** `choices`, when present, are short answers the card draws as rows; a click
   *  answers with the row's text. `moreModelsFrom` names a provider whose whole
   *  catalogue the card also offers through the model picker. */
  | { type: "user_question_requested"; runId: string; requestId: string; question: string; choices?: QuestionChoices; ts: number }
  | { type: "user_question_resolved"; runId: string; requestId: string; answer: string; ts: number }
  /** `worker` and `branch` are set when the call handed the task to a Delegate
   *  CLI: the worker id, and the worktree branch it edits on (absent when the
   *  project is not a Git repository and it works in the folder directly). */
  | { type: "subagent_requested"; runId: string; requestId: string; subagent: string; task: string; worker?: string; branch?: string; model?: string; ts: number }
  | { type: "subagent_resolved"; runId: string; requestId: string; result: string; ts: number }
  | { type: "advisor_requested"; runId: string; requestId: string; question: string; ts: number }
  | { type: "advisor_resolved"; runId: string; requestId: string; advice: string; ts: number }
  /** The auto-compactor collapsed the older turns into `summary` to free
   *  context. Emitted by the Harness and persisted to the Transcript, so a
   *  replayed Conversation must render the marker where it happened —
   *  otherwise the reloaded transcript looks like an unbroken conversation
   *  that mysteriously forgot its early turns. */
  | { type: "context_compacted"; runId: string; summary: string; ts: number }
  | { type: "steering_injected"; runId: string; reason: string; ts: number }
  /** An `auto` request settled on this pair. Follows `run_started` (which
   *  already carries the resolved provider/model); `skipped` names each
   *  candidate ranked above the pick and why it was ruled out. */
  | { type: "route_resolved"; runId: string; provider: ProviderId; model: string; reason: string; skipped: string[]; ts: number };

export type AgentMessageView = {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  thinking?: string;
  toolName?: string;
  toolCallId?: string;
  attachments?: AgentAttachment[];
};

export type AgentTimelineItem =
  | { type: "tool"; toolCallId: string; name: string; summary: string; status: "running" | "done"; result?: ToolResult }
  | { type: "permission"; request: PermissionRequest; status: "pending" | "resolved" }
  | { type: "diff"; proposal: DiffProposal; status: "pending" | "resolved" }
  | { type: "error"; error: AgentError };

export type AgentRunView = {
  id: string;
  status: AgentRunStatus;
  mode: AgentMode;
  provider: ProviderId;
  model: string;
  messages: AgentMessageView[];
  timeline: AgentTimelineItem[];
  pendingPermission?: PermissionRequest;
  pendingDiff?: DiffProposal;
  context?: AgentContextSnapshot;
  error?: AgentError;
};

export type AgentState = {
  runs: Record<string, AgentRunView>;
  activeRunId: string | null;
};

export type CheckpointEntry = {
  toolCallId: string;
  path: string;
  oldContent: string;
  newContent: string;
  isCreate: boolean;
  workspaceRoot: string;
  ts: number;
};

export type StartAgentRunInput = {
  /** Client-supplied run id. The AI panel passes its conversation id so the
   *  on-disk transcript shares the convo id and Mission Control can dedupe. */
  runId?: string;
  workspaceRoot: string | null;
  mode: AgentMode;
  provider: ProviderId;
  model: string;
  text: string;
  attachments: AgentAttachment[];
  context?: AgentContextSnapshot;
  systemPrompt?: string;
  disabledTools?: string[];
  /** Context window (num_ctx) for local models — resolved per model from the
   *  detected window or a user override. Omit to use the adapter default. */
  numCtx?: number;
  /** Reply budget (num_predict) for local models. Omit to use provider default. */
  numPredict?: number;
  /** Reflection/thinking preference for models that support it. */
  reflectionLevel?: string;
  /** Max read-only tool calls to run concurrently in one turn (1 = sequential). */
  maxParallelTools?: number;
  /** Max tool turns before handing back to the user. Omit for the harness
   *  default; a runaway-loop guard, not a task-size limit. */
  maxTurns?: number;
  /** Seconds a run_command may run before it's killed. Omit for the harness
   *  default (180s). */
  commandTimeoutSecs?: number;
  /** Whether file edits pause for diff review. Omit/true = review every edit;
   *  false = auto-accept (edits apply without a prompt; still checkpointed). */
  requireDiffReview?: boolean;
  /** Whether shell commands skip the permission gate. Omit/false keeps the
   *  normal gate (run-scoped approvals + project allowlist); true is the
   *  full-auto rung — commands run as if allowlisted. Network requests still
   *  prompt. Per-conversation, never persisted. */
  autoApproveCommands?: boolean;
  /** Optional command to run after an accepted edit/create. */
  testAfterEditCommand?: string;
  /** When this run is a spawned sub-agent, the parent run's id. */
  parentId?: string;
  /** The user's starred models, sent when `provider` is `auto` so the Rust
   *  router can prefer them. Stars live in this renderer's storage
   *  (favModels.ts); the policy that reads them lives in Rust. */
  preferredModels?: { provider: string; model: string }[];
  /** Optional durable Mission attempt linkage. Task id and Run id stay distinct. */
  missionId?: string;
  missionTaskId?: string;
};
