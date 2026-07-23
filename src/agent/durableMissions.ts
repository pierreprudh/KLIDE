import { invoke } from "@tauri-apps/api/core";
import {
  createMission,
  createMissionTask,
  EMPTY_MISSION_STATE,
  missionReducer,
  type MissionAttemptValidation,
  type MissionState,
} from "./missionHarness";

export type DurableMissionMode = "plan" | "goal";
export type DurableMissionRisk = "low" | "medium" | "high";
export type DurableMissionPhase = "Understand" | "Build" | "Verify";
export type DurableMissionWorkerKind = "harness" | "delegate";

export type DurableMissionTaskDispatch = {
  workerKind: DurableMissionWorkerKind;
  provider: string;
  model: string;
  requireDiffReview: boolean;
};

export type DurableMissionSpec = {
  schemaVersion: number;
  id: string;
  title: string;
  intent: string;
  mode: DurableMissionMode;
  taskIds: string[];
  createdMs: number;
  updatedMs: number;
};

export type DurableMissionTaskSpec = {
  schemaVersion: number;
  id: string;
  missionId: string;
  title: string;
  bodyMarkdown: string;
  phase: DurableMissionPhase;
  mode: DurableMissionMode;
  risk: DurableMissionRisk;
  writesFiles: boolean;
  dependencies: string[];
  acceptanceCriteria: string[];
  needsRepoWideContext: boolean;
  needsStrongReasoning: boolean;
  needsDelegateCli: boolean;
  needsVisualReview: boolean;
  dispatch?: DurableMissionTaskDispatch;
  createdMs: number;
  updatedMs: number;
};

export type CreateDurableMissionTaskInput = Omit<
  DurableMissionTaskSpec,
  "schemaVersion" | "missionId" | "createdMs" | "updatedMs"
> & { id?: string };

export type CreateDurableMissionInput = {
  id?: string;
  title: string;
  intent: string;
  mode: DurableMissionMode;
  tasks: CreateDurableMissionTaskInput[];
};

export type SaveDurableMissionTaskInput = Omit<
  DurableMissionTaskSpec,
  "schemaVersion" | "missionId" | "createdMs" | "updatedMs"
>;

export type DurableMissionApprovalInput = {
  tasks: Array<DurableMissionTaskDispatch & { taskId: string }>;
  autoStart: boolean;
};

export type DurableMissionEvent =
  | { type: "mission_created" }
  | { type: "task_created"; taskId: string }
  | { type: "task_updated"; taskId: string }
  | { type: "plan_approved" }
  | { type: "attempt_attached"; taskId: string; runId: string }
  | { type: "attempt_dispatch_failed"; taskId: string; runId: string; message: string }
  | { type: "attempt_interrupted"; taskId: string; runId: string; reason: string }
  | {
      type: "attempt_validation_recorded";
      taskId: string;
      runId: string;
      accepted: boolean;
      validation: MissionAttemptValidation;
    }
  | { type: "mission_completed" }
  | { type: "mission_parked"; reason: string };

export type DurableMissionEventLine = {
  schemaVersion: number;
  missionId: string;
  seq: number;
  ts: number;
  event: DurableMissionEvent;
};

export type DurableMissionBundle = {
  mission: DurableMissionSpec;
  tasks: DurableMissionTaskSpec[];
  events: DurableMissionEventLine[];
};

export type PreparedMissionAttempt = {
  runId: string;
  bundle: DurableMissionBundle;
};

/**
 * Compile authored Markdown + Rust-owned events into the existing headless
 * Mission state. This is a projection only: refreshing from disk is always
 * authoritative, and no UI lifecycle state needs to be persisted separately.
 */
export function compileDurableMissionBundle(bundle: DurableMissionBundle): MissionState {
  const spec = bundle.mission;
  const mission = {
    ...createMission({
      id: spec.id,
      title: spec.title,
      intent: spec.intent,
      mode: spec.mode,
      nowMs: spec.createdMs,
    }),
    updatedMs: spec.updatedMs,
  };
  let state = missionReducer(EMPTY_MISSION_STATE, { type: "mission_created", mission });

  for (const taskSpec of bundle.tasks) {
    const task = {
      ...createMissionTask({
        id: taskSpec.id,
        missionId: taskSpec.missionId,
        title: taskSpec.title,
        description: taskSpec.bodyMarkdown || undefined,
        acceptanceCriteria: taskSpec.acceptanceCriteria,
        risk: taskSpec.risk,
        dependencies: taskSpec.dependencies,
        nowMs: taskSpec.createdMs,
      }),
      updatedMs: taskSpec.updatedMs,
    };
    state = missionReducer(state, { type: "task_added", task });
  }

  for (const line of [...bundle.events].sort((a, b) => a.seq - b.seq)) {
    const event = line.event;
    if (event.type === "plan_approved") {
      state = missionReducer(state, {
        type: "mission_plan_approved",
        missionId: line.missionId,
        ts: line.ts,
      });
    } else if (event.type === "attempt_attached") {
      state = missionReducer(state, {
        type: "task_run_attached",
        taskId: event.taskId,
        runId: event.runId,
        ts: line.ts,
      });
    } else if (event.type === "attempt_dispatch_failed") {
      state = missionReducer(state, {
        type: "task_attempt_dispatch_failed",
        taskId: event.taskId,
        runId: event.runId,
        message: event.message,
        ts: line.ts,
      });
    } else if (event.type === "attempt_interrupted") {
      state = missionReducer(state, {
        type: "task_attempt_interrupted",
        taskId: event.taskId,
        runId: event.runId,
        reason: event.reason,
        ts: line.ts,
      });
    } else if (event.type === "attempt_validation_recorded") {
      state = missionReducer(state, {
        type: "task_attempt_validated",
        taskId: event.taskId,
        runId: event.runId,
        accepted: event.accepted,
        validation: event.validation,
        ts: line.ts,
      });
    }
  }

  return state;
}

export async function createDurableMission(
  workspaceRoot: string,
  input: CreateDurableMissionInput
): Promise<DurableMissionBundle> {
  return invoke<DurableMissionBundle>("mission_create", { workspaceRoot, input });
}

export async function readDurableMission(
  workspaceRoot: string,
  missionId: string
): Promise<DurableMissionBundle> {
  return invoke<DurableMissionBundle>("mission_read", { workspaceRoot, missionId });
}

export async function listDurableMissions(workspaceRoot: string): Promise<DurableMissionBundle[]> {
  return invoke<DurableMissionBundle[]>("mission_list", { workspaceRoot });
}

export async function saveDurableMissionTask(
  workspaceRoot: string,
  missionId: string,
  input: SaveDurableMissionTaskInput
): Promise<DurableMissionBundle> {
  return invoke<DurableMissionBundle>("mission_save_task", { workspaceRoot, missionId, input });
}

export async function approveDurableMission(
  workspaceRoot: string,
  missionId: string,
  input: DurableMissionApprovalInput
): Promise<DurableMissionBundle> {
  return invoke<DurableMissionBundle>("mission_approve", { workspaceRoot, missionId, input });
}

export async function dispatchDurableMissionTask(
  workspaceRoot: string,
  missionId: string,
  taskId: string
): Promise<DurableMissionBundle> {
  return invoke<DurableMissionBundle>("mission_dispatch_task", {
    workspaceRoot,
    missionId,
    taskId,
  });
}

export async function prepareMissionAttempt(
  workspaceRoot: string,
  missionId: string,
  taskId: string
): Promise<PreparedMissionAttempt> {
  return invoke<PreparedMissionAttempt>("mission_prepare_attempt", {
    workspaceRoot,
    missionId,
    taskId,
  });
}

export async function failMissionAttemptDispatch(
  workspaceRoot: string,
  missionId: string,
  taskId: string,
  runId: string,
  message: string
): Promise<DurableMissionBundle> {
  return invoke<DurableMissionBundle>("mission_fail_attempt_dispatch", {
    workspaceRoot,
    missionId,
    taskId,
    runId,
    message,
  });
}

export async function validateMissionAttempt(
  workspaceRoot: string,
  missionId: string,
  taskId: string,
  runId: string
): Promise<DurableMissionBundle> {
  return invoke<DurableMissionBundle>("mission_validate_attempt", {
    workspaceRoot,
    missionId,
    taskId,
    runId,
  });
}

/** The terminal AgentEvent reaches the request channel just before the Harness
 * finishes writing its terminal summary. Retry that tiny handoff window here
 * so callers still treat validation as one durable Rust operation. */
export async function validateMissionAttemptAfterRun(
  workspaceRoot: string,
  missionId: string,
  taskId: string,
  runId: string
): Promise<DurableMissionBundle> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await validateMissionAttempt(workspaceRoot, missionId, taskId, runId);
    } catch (error) {
      lastError = error;
      if (!String(error).includes("has not settled yet")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}

/** Observe the Rust Harness' automatic acceptance write. The poll is only a
 * view reattachment seam; it never decides or mutates Mission state. */
export async function waitForMissionAttemptValidation(
  workspaceRoot: string,
  missionId: string,
  taskId: string,
  runId: string
): Promise<DurableMissionBundle> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const bundle = await readDurableMission(workspaceRoot, missionId);
    const recorded = bundle.events.some((line) =>
      line.event.type === "attempt_validation_recorded"
      && line.event.taskId === taskId
      && line.event.runId === runId
    );
    if (recorded) return bundle;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Rust did not record validation for Run ${runId}.`);
}
