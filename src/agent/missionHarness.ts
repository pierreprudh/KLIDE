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
  | "blocked"
  | "assigned"
  | "running"
  | "waiting"
  | "review"
  | "done"
  | "failed"
  | "cancelled";

export type MissionTask = {
  id: string;
  missionId: string;
  title: string;
  description?: string;
  acceptanceCriteria: string[];
  status: MissionTaskStatus;
  risk: "low" | "medium" | "high";
  dependencies: string[];
  runId: string | null;
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
  | { type: "task_added"; task: MissionTask }
  | { type: "task_updated"; taskId: string; patch: Partial<Omit<MissionTask, "id" | "missionId" | "createdMs">>; ts: number }
  | { type: "task_assigned"; taskId: string; assignment: WorkerAssignment; validationContractId?: string; ts: number }
  | { type: "task_run_attached"; taskId: string; runId: string; ts: number }
  | { type: "task_status_changed"; taskId: string; status: MissionTaskStatus; ts: number }
  | { type: "mission_status_derived"; missionId: string; ts: number };

export type MissionInspection = {
  mission: Mission;
  tasks: MissionTask[];
  assignments: WorkerAssignment[];
  progress: {
    total: number;
    done: number;
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
    runId: null,
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
    return updateTaskStatus(state, action.taskId, "running", action.ts, { runId: action.runId });
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
  if (tasks.some((task) => task.status === "waiting" || task.status === "blocked")) return "waiting";
  if (tasks.some((task) => task.status === "review")) return "reviewing";
  if (tasks.some((task) => task.status === "running")) return "running";
  if (tasks.every((task) => task.status === "done")) return "done";
  if (tasks.some((task) => task.status === "assigned")) return "dispatching";
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
      running: tasks.filter((task) => task.status === "running").length,
      blocked: tasks.filter((task) => task.status === "blocked" || task.status === "waiting").length,
      failed: tasks.filter((task) => task.status === "failed").length,
    },
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
