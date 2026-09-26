import { describe, expect, it } from "vitest";
import {
  createMission,
  createMissionTask,
  deriveMissionStatus,
  EMPTY_MISSION_STATE,
  inspectMission,
  missionReducer,
  readyMissionTaskIds,
  taskDependenciesAccepted,
  type MissionAttemptValidation,
  type MissionState,
  type MissionTask,
} from "./missionHarness";
import {
  compileDurableMissionBundle,
  type DurableMissionEvent,
  type DurableMissionTaskSpec,
} from "./durableMissions";
import readiness from "./fixtures/missionReadiness.json";

// `missionReducer` is the TypeScript projection of the Rust-owned Mission event
// log — the second fold of the same log (Rust's `fold_runtime` is the first).
// It decides what the operator sees for every task and attempt, and it had no
// tests while the compiler feeding it had five.
//
// The invariants under test are ADR-0002's, restated from the TypeScript side:
//   2. one Task owns many attempts and at most one accepted Run
//   3. a dependency is satisfied only by an accepted Run, never by process exit
//   6. rejected, failed and interrupted attempts require explicit retry
//  10. a Delegate process exit is settlement evidence, never acceptance

const MISSION = "mission-1";
const T = 1_000;

function validation(overrides: Partial<MissionAttemptValidation> = {}): MissionAttemptValidation {
  return {
    status: "passed",
    checks: [],
    filesChanged: 1,
    commandsRun: 1,
    commandsFailed: 0,
    diffReviews: 1,
    permissionsApproved: 0,
    permissionsDenied: 0,
    warnings: [],
    ...overrides,
  };
}

/** A mission with `inspect` and `implement`, the latter depending on the former. */
function twoTaskMission(opts: { approved?: boolean } = {}): MissionState {
  let state = missionReducer(EMPTY_MISSION_STATE, {
    type: "mission_created",
    mission: createMission({ id: MISSION, title: "Ship it", intent: "…", mode: "goal", nowMs: T }),
  });
  for (const [id, dependencies] of [["inspect", []], ["implement", ["inspect"]]] as const) {
    state = missionReducer(state, {
      type: "task_added",
      task: createMissionTask({
        missionId: MISSION,
        id,
        title: id,
        dependencies: [...dependencies],
        nowMs: T,
      }),
    });
  }
  if (opts.approved !== false) {
    state = missionReducer(state, { type: "mission_plan_approved", missionId: MISSION, ts: T });
  }
  return state;
}

const task = (state: MissionState, id: string): MissionTask => {
  const found = state.tasks[id];
  if (!found) throw new Error(`no task ${id}`);
  return found;
};

describe("mission and task creation", () => {
  it("makes the created mission active and starts it as a draft with no tasks", () => {
    const state = missionReducer(EMPTY_MISSION_STATE, {
      type: "mission_created",
      mission: createMission({ id: MISSION, title: "Ship it", intent: "…", nowMs: T }),
    });
    expect(state.activeMissionId).toBe(MISSION);
    expect(state.missions[MISSION]).toMatchObject({ status: "draft", taskIds: [], approvedAtMs: null });
  });

  it("moves a draft mission to planning when its first task lands", () => {
    const state = twoTaskMission({ approved: false });
    expect(state.missions[MISSION].taskIds).toEqual(["inspect", "implement"]);
    expect(state.missions[MISSION].status).toBe("planning");
  });

  it("ignores a task whose mission it has never seen", () => {
    const state = missionReducer(EMPTY_MISSION_STATE, {
      type: "task_added",
      task: createMissionTask({ missionId: "ghost", id: "orphan", title: "orphan", nowMs: T }),
    });
    expect(state).toEqual(EMPTY_MISSION_STATE);
  });
});

describe("approval projects readiness", () => {
  it("marks dependency-free tasks ready and dependent ones blocked", () => {
    const state = twoTaskMission();
    expect(task(state, "inspect").status).toBe("ready");
    expect(task(state, "implement").status).toBe("blocked");
    expect(state.missions[MISSION].status).toBe("dispatching");
    expect(state.missions[MISSION].approvedAtMs).toBe(T);
  });

  it("keeps the first approval timestamp when approval is replayed", () => {
    const once = twoTaskMission();
    const twice = missionReducer(once, { type: "mission_plan_approved", missionId: MISSION, ts: T + 9_000 });
    expect(twice.missions[MISSION].approvedAtMs).toBe(T);
  });

  it("reports no ready tasks before approval", () => {
    expect(readyMissionTaskIds(twoTaskMission({ approved: false }), MISSION)).toEqual([]);
  });

  it("reports only the unblocked task after approval", () => {
    expect(readyMissionTaskIds(twoTaskMission(), MISSION)).toEqual(["inspect"]);
  });
});

describe("attempt lifecycle", () => {
  it("attaching a Run puts the task in running with one attempt", () => {
    const state = missionReducer(twoTaskMission(), {
      type: "task_run_attached",
      taskId: "inspect",
      runId: "run-a",
      ts: T + 1,
    });
    expect(task(state, "inspect").status).toBe("running");
    expect(task(state, "inspect").attempts).toEqual([
      { runId: "run-a", status: "running", attachedMs: T + 1, settledMs: null, validation: null },
    ]);
    expect(state.missions[MISSION].status).toBe("running");
  });

  it("settling moves the attempt to review, not to done — exit is not acceptance", () => {
    // ADR-0002 invariant 10.
    let state = twoTaskMission();
    state = missionReducer(state, { type: "task_run_attached", taskId: "inspect", runId: "run-a", ts: T + 1 });
    state = missionReducer(state, {
      type: "task_attempt_settled",
      taskId: "inspect",
      runId: "run-a",
      exitCode: 0,
      ts: T + 2,
    });
    expect(task(state, "inspect").status).toBe("review");
    expect(task(state, "inspect").acceptedRunId).toBeNull();
    expect(task(state, "inspect").attempts[0]).toMatchObject({ status: "review", exitCode: 0, settledMs: T + 2 });
    expect(state.missions[MISSION].status).toBe("reviewing");
    // And the downstream task is still blocked.
    expect(task(state, "implement").status).toBe("blocked");
  });

  it("acceptance records the accepted Run and unblocks the dependent task", () => {
    // ADR-0002 invariant 3.
    let state = twoTaskMission();
    state = missionReducer(state, { type: "task_run_attached", taskId: "inspect", runId: "run-a", ts: T + 1 });
    state = missionReducer(state, {
      type: "task_attempt_settled", taskId: "inspect", runId: "run-a", exitCode: 0, ts: T + 2,
    });
    state = missionReducer(state, {
      type: "task_attempt_validated",
      taskId: "inspect",
      runId: "run-a",
      accepted: true,
      validation: validation(),
      ts: T + 3,
    });
    expect(task(state, "inspect").status).toBe("done");
    expect(task(state, "inspect").acceptedRunId).toBe("run-a");
    expect(task(state, "implement").status).toBe("ready");
    expect(readyMissionTaskIds(state, MISSION)).toEqual(["implement"]);
  });

  it("rejection fails the task, keeps acceptedRunId null, and leaves dependents blocked", () => {
    // ADR-0002 invariant 6 — no automatic retry, and no accidental unblocking.
    let state = twoTaskMission();
    state = missionReducer(state, { type: "task_run_attached", taskId: "inspect", runId: "run-a", ts: T + 1 });
    state = missionReducer(state, {
      type: "task_attempt_validated",
      taskId: "inspect",
      runId: "run-a",
      accepted: false,
      validation: validation({ status: "failed" }),
      ts: T + 2,
    });
    expect(task(state, "inspect").status).toBe("failed");
    expect(task(state, "inspect").acceptedRunId).toBeNull();
    expect(task(state, "inspect").attempts[0]).toMatchObject({ status: "rejected" });
    expect(task(state, "implement").status).toBe("blocked");
    expect(state.missions[MISSION].status).toBe("failed");
  });

  it("an interrupted attempt parks rather than failing", () => {
    // A restart killed the Run before it settled: nothing was wrong with the
    // work, so it must not read as a validation failure.
    let state = twoTaskMission();
    state = missionReducer(state, { type: "task_run_attached", taskId: "inspect", runId: "run-a", ts: T + 1 });
    state = missionReducer(state, {
      type: "task_attempt_interrupted",
      taskId: "inspect",
      runId: "run-a",
      reason: "process restart",
      ts: T + 2,
    });
    expect(task(state, "inspect").status).toBe("interrupted");
    expect(task(state, "inspect").attempts[0]).toMatchObject({
      status: "interrupted",
      message: "process restart",
      settledMs: T + 2,
    });
    expect(state.missions[MISSION].status).toBe("waiting");
  });

  it("a dispatch failure fails the task and names the reason", () => {
    let state = twoTaskMission();
    state = missionReducer(state, {
      type: "task_attempt_dispatch_failed",
      taskId: "inspect",
      runId: "run-a",
      message: "provider unavailable",
      ts: T + 1,
    });
    expect(task(state, "inspect").status).toBe("failed");
    expect(task(state, "inspect").attempts[0]).toMatchObject({
      status: "dispatch-failed",
      message: "provider unavailable",
    });
  });
});

describe("many attempts, at most one accepted", () => {
  // ADR-0002 invariant 2, and the reason Task id and Run id are never the same
  // lifecycle object.
  it("keeps a rejected attempt in history when a retry is accepted", () => {
    let state = twoTaskMission();
    state = missionReducer(state, { type: "task_run_attached", taskId: "inspect", runId: "run-a", ts: T + 1 });
    state = missionReducer(state, {
      type: "task_attempt_validated", taskId: "inspect", runId: "run-a",
      accepted: false, validation: validation({ status: "failed" }), ts: T + 2,
    });
    state = missionReducer(state, { type: "task_run_attached", taskId: "inspect", runId: "run-b", ts: T + 3 });
    state = missionReducer(state, {
      type: "task_attempt_validated", taskId: "inspect", runId: "run-b",
      accepted: true, validation: validation(), ts: T + 4,
    });

    const attempts = task(state, "inspect").attempts;
    expect(attempts.map((a) => [a.runId, a.status])).toEqual([
      ["run-a", "rejected"],
      ["run-b", "accepted"],
    ]);
    expect(attempts.filter((a) => a.status === "accepted")).toHaveLength(1);
    expect(task(state, "inspect").acceptedRunId).toBe("run-b");
    expect(task(state, "inspect").status).toBe("done");
  });

  it("re-attaching the same runId updates that attempt instead of duplicating it", () => {
    let state = twoTaskMission();
    state = missionReducer(state, { type: "task_run_attached", taskId: "inspect", runId: "run-a", ts: T + 1 });
    state = missionReducer(state, { type: "task_run_attached", taskId: "inspect", runId: "run-a", ts: T + 5 });
    expect(task(state, "inspect").attempts).toHaveLength(1);
    // The original attach time survives — it is when the Run actually started.
    expect(task(state, "inspect").attempts[0].attachedMs).toBe(T + 1);
  });

  it("does not let a later attempt clear an already-accepted Run", () => {
    let state = twoTaskMission();
    state = missionReducer(state, { type: "task_run_attached", taskId: "inspect", runId: "run-a", ts: T + 1 });
    state = missionReducer(state, {
      type: "task_attempt_validated", taskId: "inspect", runId: "run-a",
      accepted: true, validation: validation(), ts: T + 2,
    });
    state = missionReducer(state, {
      type: "task_attempt_validated", taskId: "inspect", runId: "run-b",
      accepted: false, validation: validation({ status: "failed" }), ts: T + 3,
    });
    expect(task(state, "inspect").acceptedRunId).toBe("run-a");
  });

  it("hides a task with a live attempt from the ready list", () => {
    let state = twoTaskMission();
    state = missionReducer(state, { type: "task_run_attached", taskId: "inspect", runId: "run-a", ts: T + 1 });
    expect(readyMissionTaskIds(state, MISSION)).toEqual([]);
  });

  it("hides a task whose attempt is awaiting review from the ready list", () => {
    let state = twoTaskMission();
    state = missionReducer(state, { type: "task_run_attached", taskId: "inspect", runId: "run-a", ts: T + 1 });
    state = missionReducer(state, {
      type: "task_attempt_settled", taskId: "inspect", runId: "run-a", exitCode: 0, ts: T + 2,
    });
    expect(readyMissionTaskIds(state, MISSION)).toEqual([]);
  });

  it("offers a rejected task again — but only for an explicit retry", () => {
    let state = twoTaskMission();
    state = missionReducer(state, { type: "task_run_attached", taskId: "inspect", runId: "run-a", ts: T + 1 });
    state = missionReducer(state, {
      type: "task_attempt_validated", taskId: "inspect", runId: "run-a",
      accepted: false, validation: validation({ status: "failed" }), ts: T + 2,
    });
    // No live or reviewing attempt remains, so the task is retryable. Nothing in
    // the projection dispatches it — that decision is Rust's.
    expect(readyMissionTaskIds(state, MISSION)).toEqual(["inspect"]);
  });
});

describe("taskDependenciesAccepted", () => {
  it("is satisfied only by an accepted Run", () => {
    const inspect = { ...createMissionTask({ missionId: MISSION, id: "inspect", title: "i", nowMs: T }) };
    const implement = createMissionTask({
      missionId: MISSION, id: "implement", title: "x", dependencies: ["inspect"], nowMs: T,
    });
    expect(taskDependenciesAccepted(implement, { inspect, implement })).toBe(false);
    const accepted = { ...inspect, acceptedRunId: "run-a" };
    expect(taskDependenciesAccepted(implement, { inspect: accepted, implement })).toBe(true);
  });

  it("treats a dependency on an unknown task as unsatisfied", () => {
    // NOTE: Rust's `task_is_ready` *errors* on a missing dependency
    // (missions.rs:697) where this returns false, so the task parks silently
    // instead of reporting a broken plan. Pinned here so the divergence is
    // visible rather than accidental; Rust is the authority that gates dispatch.
    const orphan = createMissionTask({
      missionId: MISSION, id: "orphan", title: "o", dependencies: ["ghost"], nowMs: T,
    });
    expect(taskDependenciesAccepted(orphan, { orphan })).toBe(false);
  });

  it("is trivially satisfied with no dependencies", () => {
    const free = createMissionTask({ missionId: MISSION, id: "free", title: "f", nowMs: T });
    expect(taskDependenciesAccepted(free, { free })).toBe(true);
  });
});

describe("deriveMissionStatus precedence", () => {
  const mission = createMission({ id: MISSION, title: "m", intent: "…", nowMs: T });
  const withTasks = (...statuses: MissionTask["status"][]) => {
    const tasksById: Record<string, MissionTask> = {};
    const taskIds: string[] = [];
    statuses.forEach((status, index) => {
      const id = `t${index}`;
      taskIds.push(id);
      tasksById[id] = { ...createMissionTask({ missionId: MISSION, id, title: id, nowMs: T }), status };
    });
    return { mission: { ...mission, taskIds }, tasksById };
  };

  it("keeps the mission's own status when it has no tasks", () => {
    expect(deriveMissionStatus(mission, {})).toBe("draft");
  });

  it("ranks failed above everything else", () => {
    const { mission: m, tasksById } = withTasks("failed", "running", "done");
    expect(deriveMissionStatus(m, tasksById)).toBe("failed");
  });

  it("ranks running above reviewing", () => {
    const { mission: m, tasksById } = withTasks("running", "review");
    expect(deriveMissionStatus(m, tasksById)).toBe("running");
  });

  it("reports reviewing when work awaits the operator", () => {
    const { mission: m, tasksById } = withTasks("review", "blocked");
    expect(deriveMissionStatus(m, tasksById)).toBe("reviewing");
  });

  it("reports waiting for an interrupted task — parked, not failed", () => {
    const { mission: m, tasksById } = withTasks("interrupted", "blocked");
    expect(deriveMissionStatus(m, tasksById)).toBe("waiting");
  });

  it("reports done only when every task is done", () => {
    const all = withTasks("done", "done");
    expect(deriveMissionStatus(all.mission, all.tasksById)).toBe("done");
    const partial = withTasks("done", "ready");
    expect(deriveMissionStatus(partial.mission, partial.tasksById)).toBe("dispatching");
  });

  it("reports waiting when the remainder is blocked behind dependencies", () => {
    const { mission: m, tasksById } = withTasks("done", "blocked");
    expect(deriveMissionStatus(m, tasksById)).toBe("waiting");
  });

  it("ignores task ids the state does not hold", () => {
    expect(deriveMissionStatus({ ...mission, taskIds: ["ghost"] }, {})).toBe("draft");
  });
});

describe("unknown ids are no-ops", () => {
  it("ignores an attempt for a task it has never seen", () => {
    const before = twoTaskMission();
    const after = missionReducer(before, {
      type: "task_run_attached", taskId: "ghost", runId: "run-a", ts: T + 1,
    });
    expect(after).toBe(before);
  });

  it("ignores approval of a mission it has never seen", () => {
    const before = twoTaskMission();
    expect(missionReducer(before, { type: "mission_plan_approved", missionId: "ghost", ts: T })).toBe(before);
  });

  it("returns null when inspecting a mission it has never seen", () => {
    expect(inspectMission(twoTaskMission(), "ghost")).toBeNull();
  });

  it("reports no ready tasks for a mission it has never seen", () => {
    expect(readyMissionTaskIds(twoTaskMission(), "ghost")).toEqual([]);
  });
});

describe("inspectMission progress", () => {
  it("counts each task once, in the mission's task order", () => {
    let state = twoTaskMission();
    state = missionReducer(state, { type: "task_run_attached", taskId: "inspect", runId: "run-a", ts: T + 1 });
    const inspection = inspectMission(state, MISSION);
    expect(inspection?.tasks.map((t) => t.id)).toEqual(["inspect", "implement"]);
    expect(inspection?.progress).toEqual({
      total: 2,
      done: 0,
      ready: 0,
      running: 1,
      blocked: 1,
      failed: 0,
    });
  });
});

// The same table Rust's `operator_readiness_matches_the_shared_frontend_fixture`
// reads, so the Run button and `mission_request_task` cannot drift apart.
describe("operator readiness, shared with Rust", () => {
  const spec = (id: string, dependencies: string[]): DurableMissionTaskSpec => ({
    schemaVersion: 1,
    id,
    missionId: MISSION,
    title: `Task ${id}`,
    bodyMarkdown: "",
    phase: "Build",
    mode: "goal",
    risk: "low",
    writesFiles: false,
    dependencies,
    acceptanceCriteria: [],
    needsRepoWideContext: false,
    needsStrongReasoning: false,
    needsDelegateCli: false,
    needsVisualReview: false,
    createdMs: 1,
    updatedMs: 1,
  });

  for (const scenario of readiness.scenarios) {
    it(scenario.name, () => {
      const state = compileDurableMissionBundle({
        mission: {
          schemaVersion: 1,
          id: MISSION,
          title: "Shared readiness",
          intent: "Pin one gate across both halves.",
          mode: "goal",
          taskIds: readiness.tasks.map((task) => task.id),
          createdMs: 1,
          updatedMs: 1,
        },
        tasks: readiness.tasks.map((task) => spec(task.id, task.dependencies)),
        events: scenario.events.map((event, seq) => ({
          schemaVersion: 1,
          missionId: MISSION,
          seq,
          ts: T + seq,
          event: event as DurableMissionEvent,
        })),
      });
      expect(readyMissionTaskIds(state, MISSION)).toEqual(scenario.requestable);
    });
  }
});
