import type { AgentMode } from "./types";
import type { WorkerAssignment } from "./routingPolicy";

export type MissionStatus =
  | "draft"
  | "planning"
  | "awaiting-approval"
  | "dispatching"
  | "running"
  | "waiting"
  | "reviewing"
  | "done"
  | "failed"
  | "cancelled";

export type MissionTaskStatus =
  | "queued"
  | "ready"
  | "blocked"
  | "assigned"
  | "running"
  | "validating"
  | "waiting"
  | "review"
  | "done"
  // A restart killed the Run before it settled. Distinct from `failed`
  // (a validation rejection): nothing was wrong with the work, so it parks
  // for a one-click retry rather than reading as a failure.
  | "interrupted"
  | "failed"
  | "cancelled";

export type MissionTaskAttemptStatus =
  | "running"
  | "dispatch-failed"
  | "interrupted"
  | "accepted"
  | "rejected";

export type MissionAttemptValidation = {
  status: string;
  checks: Array<{
    id: string;
    label: string;
    status: string;
    required: boolean;
    evidence?: string;
  }>;
  filesChanged: number;
  commandsRun: number;
  commandsFailed: number;
  diffReviews: number;
  permissionsApproved: number;
  permissionsDenied: number;
  warnings: string[];
};

/** A Task is the durable unit of intent; Runs are replaceable attempts. */
export type MissionTaskAttempt = {
  runId: string;
  status: MissionTaskAttemptStatus;
  attachedMs: number;
  settledMs: number | null;
  validation: MissionAttemptValidation | null;
  message?: string;
};

export type MissionTask = {
  id: string;
  missionId: string;
  title: string;
  description?: string;
  acceptanceCriteria: string[];
  status: MissionTaskStatus;
  risk: "low" | "medium" | "high";
  dependencies: string[];
  attempts: MissionTaskAttempt[];
  /** The attempt whose validation accepted this Task. Dependencies gate on this. */
  acceptedRunId: string | null;
  assignmentId: string | null;
  validationContractId: string | null;
  createdMs: number;
  updatedMs: number;
};

export type Mission = {
  id: string;
  title: string;
  intent: string;
  mode: Extract<AgentMode, "plan" | "goal">;
  status: MissionStatus;
  orchestratorRunId: string | null;
  budgetId: string | null;
  taskIds: string[];
  approvedAtMs: number | null;
  createdMs: number;
  updatedMs: number;
};

export type MissionState = {
  missions: Record<string, Mission>;
  tasks: Record<string, MissionTask>;
  assignments: Record<string, WorkerAssignment>;
  activeMissionId: string | null;
};

export type MissionAction =
  | { type: "mission_created"; mission: Mission }
  | { type: "mission_updated"; missionId: string; patch: Partial<Omit<Mission, "id" | "createdMs">>; ts: number }
  | { type: "mission_activated"; missionId: string | null }
  | { type: "mission_plan_approved"; missionId: string; ts: number }
  | { type: "task_added"; task: MissionTask }
  | { type: "task_updated"; taskId: string; patch: Partial<Omit<MissionTask, "id" | "missionId" | "createdMs">>; ts: number }
  | { type: "task_assigned"; taskId: string; assignment: WorkerAssignment; validationContractId?: string; ts: number }
  | { type: "task_run_attached"; taskId: string; runId: string; ts: number }
  | { type: "task_attempt_dispatch_failed"; taskId: string; runId: string; message: string; ts: number }
  | { type: "task_attempt_interrupted"; taskId: string; runId: string; reason: string; ts: number }
  | { type: "task_attempt_validated"; taskId: string; runId: string; accepted: boolean; validation: MissionAttemptValidation; ts: number }
  | { type: "task_status_changed"; taskId: string; status: MissionTaskStatus; ts: number }
  | { type: "mission_status_derived"; missionId: string; ts: number };

export type MissionInspection = {
  mission: Mission;
  tasks: MissionTask[];
  assignments: WorkerAssignment[];
  progress: {
    total: number;
    done: number;
    ready: number;
    running: number;
    blocked: number;
    failed: number;
  };
};

export const EMPTY_MISSION_STATE: MissionState = {
  missions: {},
  tasks: {},
  assignments: {},
  activeMissionId: null,
};

export function createMission(input: {
  title: string;
  intent: string;
  mode?: Extract<AgentMode, "plan" | "goal">;
  id?: string;
  budgetId?: string | null;
  orchestratorRunId?: string | null;
  nowMs?: number;
}): Mission {
  const nowMs = input.nowMs ?? Date.now();
  return {
    id: input.id ?? makeId("mission"),
    title: input.title,
    intent: input.intent,
    mode: input.mode ?? "plan",
    status: "draft",
    orchestratorRunId: input.orchestratorRunId ?? null,
    budgetId: input.budgetId ?? null,
    taskIds: [],
    approvedAtMs: null,
    createdMs: nowMs,
    updatedMs: nowMs,
  };
}

export function createMissionTask(input: {
  missionId: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  risk?: "low" | "medium" | "high";
  dependencies?: string[];
  id?: string;
  nowMs?: number;
}): MissionTask {
  const nowMs = input.nowMs ?? Date.now();
  return {
    id: input.id ?? makeId("task"),
    missionId: input.missionId,
    title: input.title,
    description: input.description,
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    status: "queued",
    risk: input.risk ?? "medium",
    dependencies: input.dependencies ?? [],
    attempts: [],
    acceptedRunId: null,
    assignmentId: null,
    validationContractId: null,
    createdMs: nowMs,
    updatedMs: nowMs,
  };
}

export function missionReducer(
  state: MissionState = EMPTY_MISSION_STATE,
  action: MissionAction
): MissionState {
  if (action.type === "mission_created") {
    return {
      ...state,
      missions: { ...state.missions, [action.mission.id]: action.mission },
      activeMissionId: action.mission.id,
    };
  }

  if (action.type === "mission_activated") {
    return { ...state, activeMissionId: action.missionId };
  }

  if (action.type === "mission_plan_approved") {
    const mission = state.missions[action.missionId];
    if (!mission) return state;
    const tasks = projectTaskReadiness(mission, state.tasks);
    return {
      ...state,
      tasks,
      missions: {
        ...state.missions,
        [mission.id]: {
          ...mission,
          approvedAtMs: mission.approvedAtMs ?? action.ts,
          status: "dispatching",
          updatedMs: action.ts,
        },
      },
    };
  }

  if (action.type === "mission_updated") {
    const mission = state.missions[action.missionId];
    if (!mission) return state;
    return {
      ...state,
      missions: {
        ...state.missions,
        [mission.id]: { ...mission, ...action.patch, updatedMs: action.ts },
      },
    };
  }

  if (action.type === "task_added") {
    const mission = state.missions[action.task.missionId];
    if (!mission) return state;
    return {
      ...state,
      missions: {
        ...state.missions,
        [mission.id]: {
          ...mission,
          taskIds: [...mission.taskIds, action.task.id],
          status: mission.status === "draft" ? "planning" : mission.status,
          updatedMs: action.task.updatedMs,
        },
      },
      tasks: { ...state.tasks, [action.task.id]: action.task },
    };
  }

  if (action.type === "task_updated") {
    const task = state.tasks[action.taskId];
    if (!task) return state;
    return {
      ...state,
      tasks: {
        ...state.tasks,
        [task.id]: { ...task, ...action.patch, updatedMs: action.ts },
      },
    };
  }

  if (action.type === "task_assigned") {
    const task = state.tasks[action.taskId];
    if (!task) return state;
    const assignmentId = assignmentKey(action.assignment);
    return {
      ...state,
      assignments: {
        ...state.assignments,
        [assignmentId]: action.assignment,
      },
      tasks: {
        ...state.tasks,
        [task.id]: {
          ...task,
          assignmentId,
          validationContractId: action.validationContractId ?? task.validationContractId,
          status: "assigned",
          updatedMs: action.ts,
        },
      },
    };
  }

  if (action.type === "task_run_attached") {
    return updateTaskAttempt(state, action.taskId, action.runId, action.ts, {
      kind: "attached",
    });
  }

  if (action.type === "task_attempt_dispatch_failed") {
    return updateTaskAttempt(state, action.taskId, action.runId, action.ts, {
      kind: "dispatch-failed",
      message: action.message,
    });
  }

  if (action.type === "task_attempt_interrupted") {
    return updateTaskAttempt(state, action.taskId, action.runId, action.ts, {
      kind: "interrupted",
      message: action.reason,
    });
  }

  if (action.type === "task_attempt_validated") {
    return updateTaskAttempt(state, action.taskId, action.runId, action.ts, {
      kind: "validated",
      accepted: action.accepted,
      validation: action.validation,
    });
  }

  if (action.type === "task_status_changed") {
    return updateTaskStatus(state, action.taskId, action.status, action.ts);
  }

  const mission = state.missions[action.missionId];
  if (!mission) return state;
  return {
    ...state,
    missions: {
      ...state.missions,
      [mission.id]: {
        ...mission,
        status: deriveMissionStatus(mission, state.tasks),
        updatedMs: action.ts,
      },
    },
  };
}

export function deriveMissionStatus(
  mission: Mission,
  tasksById: Record<string, MissionTask>
): MissionStatus {
  const tasks = mission.taskIds.map((taskId) => tasksById[taskId]).filter((task): task is MissionTask => Boolean(task));
  if (tasks.length === 0) return mission.status;
  if (tasks.some((task) => task.status === "failed")) return "failed";
  if (tasks.some((task) => task.status === "running")) return "running";
  if (tasks.some((task) => task.status === "review" || task.status === "validating")) return "reviewing";
  // An interrupted task parks the mission awaiting a retry — surfaced, but not
  // a failure (Rust does not auto-resume it, so it's not "running" either).
  if (tasks.some((task) => task.status === "interrupted")) return "waiting";
  if (tasks.every((task) => task.status === "done")) return "done";
  if (tasks.some((task) => task.status === "ready" || task.status === "assigned")) return "dispatching";
  if (tasks.some((task) => task.status === "waiting" || task.status === "blocked")) return "waiting";
  return mission.status === "draft" ? "planning" : mission.status;
}

export function inspectMission(state: MissionState, missionId: string): MissionInspection | null {
  const mission = state.missions[missionId];
  if (!mission) return null;
  const tasks = mission.taskIds.map((taskId) => state.tasks[taskId]).filter((task): task is MissionTask => Boolean(task));
  const assignments = tasks.flatMap((task) => (task.assignmentId ? [state.assignments[task.assignmentId]] : []));
  return {
    mission,
    tasks,
    assignments: assignments.filter((assignment): assignment is WorkerAssignment => Boolean(assignment)),
    progress: {
      total: tasks.length,
      done: tasks.filter((task) => task.status === "done").length,
      ready: tasks.filter((task) => task.status === "ready").length,
      running: tasks.filter((task) => task.status === "running").length,
      blocked: tasks.filter((task) => task.status === "blocked" || task.status === "waiting").length,
      failed: tasks.filter((task) => task.status === "failed").length,
    },
  };
}

/** A dependency is satisfied only by an accepted attempt, never by process exit. */
export function taskDependenciesAccepted(
  task: MissionTask,
  tasksById: Record<string, MissionTask>
): boolean {
  return task.dependencies.every((dependencyId) => tasksById[dependencyId]?.acceptedRunId != null);
}

export function readyMissionTaskIds(state: MissionState, missionId: string): string[] {
  const mission = state.missions[missionId];
  if (!mission || mission.approvedAtMs === null) return [];
  return mission.taskIds.filter((taskId) => {
    const task = state.tasks[taskId];
    if (!task || task.acceptedRunId !== null) return false;
    if (task.attempts.some((attempt) => attempt.status === "running")) return false;
    return taskDependenciesAccepted(task, state.tasks);
  });
}

function projectTaskReadiness(
  mission: Mission,
  tasksById: Record<string, MissionTask>
): Record<string, MissionTask> {
  const tasks = { ...tasksById };
  for (const taskId of mission.taskIds) {
    const task = tasks[taskId];
    if (!task || (task.status !== "queued" && task.status !== "blocked")) continue;
    tasks[taskId] = {
      ...task,
      status: taskDependenciesAccepted(task, tasksById) ? "ready" : "blocked",
    };
  }
  return tasks;
}

type AttemptUpdate =
  | { kind: "attached" }
  | { kind: "dispatch-failed"; message: string }
  | { kind: "interrupted"; message: string }
  | { kind: "validated"; accepted: boolean; validation: MissionAttemptValidation };

function updateTaskAttempt(
  state: MissionState,
  taskId: string,
  runId: string,
  ts: number,
  update: AttemptUpdate
): MissionState {
  const task = state.tasks[taskId];
  if (!task) return state;
  const existing = task.attempts.find((attempt) => attempt.runId === runId);
  const base: MissionTaskAttempt = existing ?? {
    runId,
    status: "running",
    attachedMs: ts,
    settledMs: null,
    validation: null,
  };
  const attempt: MissionTaskAttempt = update.kind === "attached"
    ? { ...base, status: "running" }
    : update.kind === "dispatch-failed"
      ? { ...base, status: "dispatch-failed", settledMs: ts, message: update.message }
      : update.kind === "interrupted"
        ? { ...base, status: "interrupted", settledMs: ts, message: update.message }
      : {
          ...base,
          status: update.accepted ? "accepted" : "rejected",
          settledMs: ts,
          validation: update.validation,
        };
  const attempts = existing
    ? task.attempts.map((item) => item.runId === runId ? attempt : item)
    : [...task.attempts, attempt];
  const status: MissionTaskStatus = update.kind === "attached"
    ? "running"
    : update.kind === "validated" && update.accepted
      ? "done"
      : update.kind === "interrupted"
        ? "interrupted"
        : "failed";
  const mission = state.missions[task.missionId];
  let tasks: Record<string, MissionTask> = {
    ...state.tasks,
    [task.id]: {
      ...task,
      attempts,
      acceptedRunId: update.kind === "validated" && update.accepted ? runId : task.acceptedRunId,
      status,
      updatedMs: ts,
    },
  };
  if (mission?.approvedAtMs != null && update.kind === "validated" && update.accepted) {
    tasks = projectTaskReadiness(mission, tasks);
  }
  return {
    ...state,
    tasks,
    missions: mission
      ? {
          ...state.missions,
          [mission.id]: {
            ...mission,
            status: deriveMissionStatus(mission, tasks),
            updatedMs: ts,
          },
        }
      : state.missions,
  };
}

function updateTaskStatus(
  state: MissionState,
  taskId: string,
  status: MissionTaskStatus,
  ts: number,
  patch?: Partial<MissionTask>
): MissionState {
  const task = state.tasks[taskId];
  if (!task) return state;
  const mission = state.missions[task.missionId];
  const tasks = {
    ...state.tasks,
    [task.id]: { ...task, ...patch, status, updatedMs: ts },
  };
  return {
    ...state,
    tasks,
    missions: mission
      ? {
          ...state.missions,
          [mission.id]: {
            ...mission,
            status: deriveMissionStatus(mission, tasks),
            updatedMs: ts,
          },
        }
      : state.missions,
  };
}

function assignmentKey(assignment: WorkerAssignment): string {
  return `${assignment.taskId}:${assignment.workerKind}:${assignment.modelTier}`;
}

function makeId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `${prefix}:${crypto.randomUUID()}`;
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}
