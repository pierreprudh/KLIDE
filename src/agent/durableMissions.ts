import { invoke } from "@tauri-apps/api/core";
import {
  createMission,
  createMissionTask,
  EMPTY_MISSION_STATE,
  missionReducer,
  type MissionState,
} from "./missionHarness";
import type { PlannedTask } from "./planner";
import { parseValidationSummary } from "./validationContracts";

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

/**
 * The one PlannedTask → task-Markdown mapping. The console persists a planned
 * board through this (plan-time create and per-task save alike); do not
 * hand-write the field list at call sites — it drifted three ways before.
 * Acceptance criteria are never persisted empty: an unspecified task falls
 * back to its description (or a satisfies-the-title criterion) so approval
 * always freezes something falsifiable into the file.
 */
export function plannedTaskToSpecInput(task: PlannedTask): SaveDurableMissionTaskInput {
  return {
    id: task.taskId,
    title: task.title,
    bodyMarkdown: task.description ?? "",
    phase: task.phase,
    mode: task.mode,
    risk: task.risk,
    writesFiles: task.writesFiles,
    dependencies: task.dependsOn ?? [],
    acceptanceCriteria: task.acceptanceCriteria?.length
      ? task.acceptanceCriteria
      : [task.description ?? `The task outcome satisfies: ${task.title}`],
    needsRepoWideContext: task.needsRepoWideContext === true,
    needsStrongReasoning: task.needsStrongReasoning === true,
    needsDelegateCli: task.needsDelegateCli === true,
    needsVisualReview: task.needsVisualReview === true,
  };
}

/**
 * The inverse: authored task Markdown → the board's PlannedTask shape, used
 * when the console reopens a persisted Mission. Empty-ish spec fields become
 * `undefined` (not "" / [] / false) so the planned board matches what the
 * planner itself would have produced.
 */
export function specToPlannedTask(spec: DurableMissionTaskSpec): PlannedTask {
  return {
    taskId: spec.id,
    title: spec.title,
    description: spec.bodyMarkdown || undefined,
    acceptanceCriteria: spec.acceptanceCriteria,
    phase: spec.phase,
    mode: spec.mode,
    risk: spec.risk,
    writesFiles: spec.writesFiles,
    dependsOn: spec.dependencies.length ? spec.dependencies : undefined,
    needsRepoWideContext: spec.needsRepoWideContext || undefined,
    needsStrongReasoning: spec.needsStrongReasoning || undefined,
    needsDelegateCli: spec.needsDelegateCli || undefined,
    needsVisualReview: spec.needsVisualReview || undefined,
  };
}

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
  | { type: "attempt_settled"; taskId: string; runId: string; exitCode: number; signal?: string }
  | {
      type: "attempt_validation_recorded";
      taskId: string;
      runId: string;
      accepted: boolean;
      /** Raw `AgentValidationSummary` wire value, straight off the durable
       *  log. Typed `unknown` so nothing can read it without going through
       *  `parseValidationSummary` in the fold below. */
      validation: unknown;
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

/**
 * The mission's standing terminal outcome, if its event log currently ends in
 * one: the latest `mission_completed` / `mission_parked` line, unless a later
 * `attempt_attached` shows the mission was driven past it — a parked mission
 * that was retried is live again, not parked. Both console effects (reopen
 * state and the one-time announcement) must read the log the same way, so the
 * reading lives here rather than twice in the component.
 */
/** Emitted once per workspace activation for each Mission directory that
 *  would not load or repair (`missions:unreadable`). Such a Mission is off the
 *  board and its id cannot be reused, so the operator must hear about it. */
export type UnreadableMission = { dir: string; error: string };
export const MISSIONS_UNREADABLE_EVENT = "missions:unreadable";

export function terminalOutcome(
  events: DurableMissionEventLine[],
): DurableMissionEventLine | null {
  let terminal: DurableMissionEventLine | null = null;
  for (const line of events) {
    if (line.event.type !== "mission_completed" && line.event.type !== "mission_parked") continue;
    if (!terminal || line.seq > terminal.seq) terminal = line;
  }
  if (!terminal) return null;
  const continued = events.some(
    (line) => line.seq > terminal.seq && line.event.type === "attempt_attached",
  );
  return continued ? null : terminal;
}

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
    // Exhaustive on purpose. This chain used to be an if/else that handled six
    // of the eleven Rust variants and fell off the end for the rest, so a new
    // `MissionEvent` in Rust reached the operator as nothing at all. The
    // `never` assignment below turns that into a tsc error instead; the
    // no-op cases are spelled out so "ignored" is a decision on the record
    // rather than an omission.
    switch (event.type) {
      // The mission and its tasks come from `mission.md` / `tasks/*.md`, which
      // Rust rewrites on every change — those documents are the authority for
      // identity and shape, so their creation events add nothing to replay.
      case "mission_created":
      case "task_created":
      case "task_updated":
        break;
      // Mission status is derived from task statuses by `deriveMissionStatus`,
      // so the terminal mission events carry no state the fold doesn't already
      // hold. Rust still needs them on disk: they're what `resume` reads to
      // decide whether a mission is finished.
      case "mission_completed":
      case "mission_parked":
        break;
      case "plan_approved":
        state = missionReducer(state, {
          type: "mission_plan_approved",
          missionId: line.missionId,
          ts: line.ts,
        });
        break;
      case "attempt_attached":
        state = missionReducer(state, {
          type: "task_run_attached",
          taskId: event.taskId,
          runId: event.runId,
          ts: line.ts,
        });
        break;
      case "attempt_dispatch_failed":
        state = missionReducer(state, {
          type: "task_attempt_dispatch_failed",
          taskId: event.taskId,
          runId: event.runId,
          message: event.message,
          ts: line.ts,
        });
        break;
      case "attempt_interrupted":
        state = missionReducer(state, {
          type: "task_attempt_interrupted",
          taskId: event.taskId,
          runId: event.runId,
          reason: event.reason,
          ts: line.ts,
        });
        break;
      case "attempt_settled":
        state = missionReducer(state, {
          type: "task_attempt_settled",
          taskId: event.taskId,
          runId: event.runId,
          exitCode: event.exitCode,
          signal: event.signal,
          ts: line.ts,
        });
        break;
      case "attempt_validation_recorded":
        state = missionReducer(state, {
          type: "task_attempt_validated",
          taskId: event.taskId,
          runId: event.runId,
          accepted: event.accepted,
          validation: parseValidationSummary(event.validation),
          ts: line.ts,
        });
        break;
      default: {
        const unhandled: never = event;
        throw new Error(`unhandled mission event: ${JSON.stringify(unhandled)}`);
      }
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

/** Ask the Rust supervisor to run one Task next — the operator's retry and
 *  "run this now". It is a request, not a dispatch: Rust refuses it while any
 *  attempt of the Mission is running or awaiting review, and the supervisor
 *  stays the only thing that starts a Run (ADR-0002). */
export async function requestDurableMissionTask(
  workspaceRoot: string,
  missionId: string,
  taskId: string
): Promise<DurableMissionBundle> {
  return invoke<DurableMissionBundle>("mission_request_task", {
    workspaceRoot,
    missionId,
    taskId,
  });
}

export async function reviewDurableMissionAttempt(
  workspaceRoot: string,
  missionId: string,
  input: { taskId: string; runId: string; accepted: boolean; note?: string }
): Promise<DurableMissionBundle> {
  return invoke<DurableMissionBundle>("mission_review_attempt", {
    workspaceRoot,
    missionId,
    input,
  });
}
