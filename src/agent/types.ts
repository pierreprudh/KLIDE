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
};

export type PermissionOption = {
  id: string;
  label: string;
  behavior: "allow" | "deny" | "ask_later";
  scope?: "once" | "run" | "project" | "user";
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
  | { behavior: "apply" }
  /** `note` is the user's review feedback ("request changes") — the harness
   *  folds it into the rejection tool result so the model revises toward it
   *  instead of abandoning course. */
  | { behavior: "reject"; note?: string; message?: string };

export type AgentRunResult = {
  status: "done" | "cancelled" | "max_turns";
  message?: string;
};

export type AgentError = {
  code:
    | "provider_unavailable"
    | "provider_auth"
    | "provider_rate_limited"
    | "tool_validation"
    | "permission_denied"
    | "workspace_path"
    | "diff_stale"
    | "aborted"
    | "max_turns"
    | "internal";
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
      ts: number;
    }
  | {
      type: "tool_call_started";
      runId: string;
      toolCallId: string;
      name: string;
      input: unknown;
      summary: string;
      ts: number;
    }
  | { type: "tool_progress"; runId: string; toolCallId: string; message: string; ts: number }
  | { type: "tool_call_finished"; runId: string; toolCallId: string; result: ToolResult; ts: number }
  | { type: "permission_requested"; runId: string; request: PermissionRequest; ts: number }
  | { type: "permission_resolved"; runId: string; requestId: string; decision: PermissionDecision; ts: number }
  | { type: "diff_proposed"; runId: string; proposal: DiffProposal; ts: number }
  | { type: "diff_resolved"; runId: string; proposalId: string; decision: DiffDecision; ts: number }
  | { type: "file_changed"; runId: string; path: string; oldHash: string; newHash: string; ts: number }
  | { type: "run_result"; runId: string; result: AgentRunResult; ts: number }
  | { type: "run_error"; runId: string; error: AgentError; ts: number }
  | { type: "user_question_requested"; runId: string; requestId: string; question: string; ts: number }
  | { type: "user_question_resolved"; runId: string; requestId: string; answer: string; ts: number }
  | { type: "subagent_requested"; runId: string; requestId: string; subagent: string; task: string; ts: number }
  | { type: "subagent_resolved"; runId: string; requestId: string; result: string; ts: number }
  | { type: "advisor_requested"; runId: string; requestId: string; question: string; ts: number }
  | { type: "advisor_resolved"; runId: string; requestId: string; advice: string; ts: number };

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
  /** Optional command to run after an accepted edit/create. */
  testAfterEditCommand?: string;
  /** When this run is a spawned sub-agent, the parent run's id. */
  parentId?: string;
  /** Optional durable Mission attempt linkage. Task id and Run id stay distinct. */
  missionId?: string;
  missionTaskId?: string;
};
