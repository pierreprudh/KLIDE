import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  AgentEvent,
  AgentMode,
  CheckpointEntry,
  DiffDecision,
  PermissionDecision,
  ProviderId,
  StartAgentRunInput,
} from "./types";

type StartRunRequest = {
  runId?: string;
  workspaceRoot: string | null;
  mode: AgentMode;
  provider: ProviderId;
  model: string;
  initialText: string;
  attachments: StartAgentRunInput["attachments"];
  context?: StartAgentRunInput["context"];
  systemPrompt?: string;
  disabledTools?: string[];
  numCtx?: number;
  numPredict?: number;
  reflectionLevel?: string;
  maxParallelTools?: number;
  maxTurns?: number;
  commandTimeoutSecs?: number;
  requireDiffReview?: boolean;
  testAfterEditCommand?: string;
  parentId?: string;
};

type StartRunResponse = {
  runId: string;
};

export type AgentRunSession = {
  /** Available immediately — pass it to stopAgentRun to abort. */
  runId: string;
  /** Settles when the run emits run_result or run_error. */
  done: Promise<void>;
};

export async function startAgentRun(
  input: StartAgentRunInput,
  onEvent: (event: AgentEvent) => void
): Promise<AgentRunSession> {
  const onEventChannel = new Channel<AgentEvent>();
  let settle: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  onEventChannel.onmessage = (event) => {
    onEvent(event);
    if (event.type === "run_result" || event.type === "run_error") settle();
  };
  // The Rust command spawns the run loop and returns the id immediately;
  // progress streams through the channel until run_result / run_error.
  const response = await invoke<StartRunResponse>("agent_start_run", {
    request: {
      runId: input.runId,
      workspaceRoot: input.workspaceRoot,
      mode: input.mode,
      provider: input.provider,
      model: input.model,
      initialText: input.text,
      attachments: input.attachments,
      context: input.context,
      systemPrompt: input.systemPrompt,
      disabledTools: input.disabledTools,
      numCtx: input.numCtx,
      numPredict: input.numPredict,
      reflectionLevel: input.reflectionLevel,
      maxParallelTools: input.maxParallelTools,
      maxTurns: input.maxTurns,
      commandTimeoutSecs: input.commandTimeoutSecs,
      requireDiffReview: input.requireDiffReview,
      testAfterEditCommand: input.testAfterEditCommand,
      parentId: input.parentId,
    } satisfies StartRunRequest,
    onEvent: onEventChannel,
  });
  return { runId: response.runId, done };
}

export async function submitAgentUserTurn(input: {
  runId: string;
  text: string;
  attachments?: StartAgentRunInput["attachments"];
}): Promise<void> {
  await invoke("agent_submit_user_turn", { request: input });
}

export async function stopAgentRun(runId: string): Promise<void> {
  await invoke("agent_abort_run", { runId });
}

export async function resolvePermission(input: {
  runId: string;
  requestId: string;
  decision: PermissionDecision;
}): Promise<void> {
  await invoke("agent_resolve_permission", { decision: input });
}

export async function resolveDiff(input: {
  runId: string;
  proposalId: string;
  decision: DiffDecision;
}): Promise<void> {
  await invoke("agent_resolve_diff", { decision: input });
}

export async function resolveUserQuestion(input: {
  runId: string;
  requestId: string;
  answer: string;
}): Promise<void> {
  await invoke("agent_resolve_question", { decision: input });
}

export async function readAgentRunEvents(runId: string): Promise<AgentEvent[]> {
  return invoke<AgentEvent[]>("agent_read_run", { runId });
}

export async function listCheckpoints(runId: string): Promise<CheckpointEntry[]> {
  return invoke<CheckpointEntry[]>("agent_list_checkpoints", { runId });
}

export async function revertCheckpoint(runId: string, toolCallId: string): Promise<void> {
  await invoke("agent_revert_checkpoint", { runId, toolCallId });
}
