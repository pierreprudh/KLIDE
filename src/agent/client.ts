import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
  missionId?: string;
  missionTaskId?: string;
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
      missionId: input.missionId,
      missionTaskId: input.missionTaskId,
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

/** Wire statuses that mean the run is still going in Rust (worth reattaching). */
const ACTIVE_RUN_STATUSES = new Set([
  "queued",
  "running",
  "waiting_for_permission",
  "waiting_for_diff",
  "paused",
]);

/**
 * Live status of a run, or null if the supervisor isn't tracking it (finished
 * and evicted, or never started this session). Used on panel mount to decide
 * whether to reattach to a still-running harness run.
 */
export async function getAgentRunStatus(runId: string): Promise<string | null> {
  return invoke<string | null>("agent_run_status", { runId });
}

export function isActiveRunStatus(status: string | null): boolean {
  return status !== null && ACTIVE_RUN_STATUSES.has(status);
}

export type RunReattachment = {
  /** Stop listening to the run's global event stream. */
  detach: () => void;
  /** Settles when the run emits run_result / run_error while we're attached. */
  done: Promise<void>;
};

/**
 * Reattach to a run that's still going in Rust after the panel remounted (the
 * request-scoped channel from `startAgentRun` died with the old mount). Follows
 * the global `agent-run:{id}` stream the harness broadcasts for every persisted
 * event, dropping any event already covered by the caller's snapshot
 * (`seq < fromSeq`). Only structural events replay here — token deltas stream
 * on the original channel and are not rebroadcast, so a reattached view shows
 * tool calls and completed messages landing rather than a token animation.
 *
 * Listen is registered before the caller snapshots, and dedup is by absolute
 * `seq`, so no event is lost or double-applied across the snapshot/live seam.
 */
export async function reattachAgentRun(
  runId: string,
  fromSeq: number,
  onEvent: (event: AgentEvent, seq: number) => void
): Promise<RunReattachment> {
  let settle: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const unlisten = await listen<{ seq: number; event: AgentEvent }>(
    `agent-run:${runId}`,
    ({ payload }) => {
      if (payload.seq < fromSeq) return;
      onEvent(payload.event, payload.seq);
      if (payload.event.type === "run_result" || payload.event.type === "run_error") settle();
    }
  );
  return {
    detach: () => {
      void unlisten();
      settle();
    },
    done,
  };
}

export async function listCheckpoints(runId: string): Promise<CheckpointEntry[]> {
  return invoke<CheckpointEntry[]>("agent_list_checkpoints", { runId });
}

export async function revertCheckpoint(runId: string, toolCallId: string): Promise<void> {
  await invoke("agent_revert_checkpoint", { runId, toolCallId });
}

export async function revertRunCheckpoints(runId: string): Promise<{ reverted: number }> {
  return invoke<{ reverted: number }>("agent_revert_run_checkpoints", { runId });
}
