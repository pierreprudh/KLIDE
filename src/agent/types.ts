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
  | "lmstudio"
  | "llamacpp"
  | "vllm"
  | "claude-code"
  | "codex"
  | "opencode"
  | "gemini-cli"
  | "anthropic"
  | "openai"
  | "gemini"
  | "mistral"
  | "xai";

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
  | { behavior: "allow"; scope: "once" | "run" | "project" | "user" }
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
  | { behavior: "reject"; message?: string };

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
  | { type: "run_error"; runId: string; error: AgentError; ts: number };

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

export type StartAgentRunInput = {
  workspaceRoot: string | null;
  mode: AgentMode;
  provider: ProviderId;
  model: string;
  text: string;
  attachments: AgentAttachment[];
  context?: AgentContextSnapshot;
  systemPrompt?: string;
};

