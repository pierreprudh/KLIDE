import { describe, expect, it } from "vitest";
import {
  attemptCheckoutOf,
  compileDurableMissionBundle,
  missionBranchOf,
  plannedTaskToSpecInput,
  specToPlannedTask,
  terminalOutcome,
  type DurableMissionBundle,
  type DurableMissionTaskSpec,
} from "./durableMissions";
import { readyMissionTaskIds } from "./missionHarness";
import type { PlannedTask } from "./planner";

const validation = {
  status: "skipped",
  checks: [],
  filesChanged: 0,
  commandsRun: 0,
  commandsFailed: 0,
  diffReviews: 0,
  permissionsApproved: 0,
  permissionsDenied: 0,
  warnings: [],
};

function bundle(events: DurableMissionBundle["events"]): DurableMissionBundle {
  return {
    mission: {
      schemaVersion: 1,
      id: "mission-one",
      title: "Ship the tracer bullet",
      intent: "Prove durable acceptance-gated chaining.",
      mode: "goal",
      taskIds: ["inspect", "implement"],
      createdMs: 1,
      updatedMs: 2,
    },
    tasks: [
      {
        schemaVersion: 1,
        id: "inspect",
        missionId: "mission-one",
        title: "Inspect",
        bodyMarkdown: "Inspect the seam.",
        phase: "Understand",
        mode: "plan",
        risk: "low",
        writesFiles: false,
        dependencies: [],
        acceptanceCriteria: ["Seam identified"],
        needsRepoWideContext: false,
        needsStrongReasoning: false,
        needsDelegateCli: false,
        needsVisualReview: false,
        createdMs: 1,
        updatedMs: 1,
      },
      {
        schemaVersion: 1,
        id: "implement",
        missionId: "mission-one",
        title: "Implement",
        bodyMarkdown: "Implement the seam.",
        phase: "Build",
        mode: "goal",
        risk: "medium",
        writesFiles: true,
        dependencies: ["inspect"],
        acceptanceCriteria: ["Validation passes"],
        needsRepoWideContext: false,
        needsStrongReasoning: false,
        needsDelegateCli: false,
        needsVisualReview: false,
        createdMs: 1,
        updatedMs: 1,
      },
    ],
    events,
  };
}

describe("durable Mission projection", () => {
  it("keeps Task identity separate from repeated Run attempts", () => {
    const state = compileDurableMissionBundle(bundle([
      { schemaVersion: 1, missionId: "mission-one", seq: 0, ts: 1, event: { type: "mission_created" } },
      { schemaVersion: 1, missionId: "mission-one", seq: 1, ts: 2, event: { type: "plan_approved" } },
      { schemaVersion: 1, missionId: "mission-one", seq: 2, ts: 3, event: { type: "attempt_attached", taskId: "inspect", runId: "run-a" } },
      { schemaVersion: 1, missionId: "mission-one", seq: 3, ts: 4, event: { type: "attempt_dispatch_failed", taskId: "inspect", runId: "run-a", message: "offline" } },
      { schemaVersion: 1, missionId: "mission-one", seq: 4, ts: 5, event: { type: "attempt_attached", taskId: "inspect", runId: "run-b" } },
    ]));

    expect(state.tasks.inspect.id).toBe("inspect");
    expect(state.tasks.inspect.attempts.map((attempt) => attempt.runId)).toEqual(["run-a", "run-b"]);
    expect(state.tasks.inspect.acceptedRunId).toBeNull();
  });

  it("unlocks a dependency only after validation accepts an attempt", () => {
    const before = compileDurableMissionBundle(bundle([
      { schemaVersion: 1, missionId: "mission-one", seq: 0, ts: 1, event: { type: "plan_approved" } },
      { schemaVersion: 1, missionId: "mission-one", seq: 1, ts: 2, event: { type: "attempt_attached", taskId: "inspect", runId: "run-a" } },
    ]));
    expect(readyMissionTaskIds(before, "mission-one")).toEqual([]);
    expect(before.tasks.implement.status).toBe("blocked");

    const after = compileDurableMissionBundle(bundle([
      { schemaVersion: 1, missionId: "mission-one", seq: 0, ts: 1, event: { type: "plan_approved" } },
      { schemaVersion: 1, missionId: "mission-one", seq: 1, ts: 2, event: { type: "attempt_attached", taskId: "inspect", runId: "run-a" } },
      {
        schemaVersion: 1,
        missionId: "mission-one",
        seq: 2,
        ts: 3,
        event: {
          type: "attempt_validation_recorded",
          taskId: "inspect",
          runId: "run-a",
          accepted: true,
          validation,
        },
      },
    ]));
    expect(after.tasks.inspect.acceptedRunId).toBe("run-a");
    expect(after.tasks.implement.status).toBe("ready");
    expect(readyMissionTaskIds(after, "mission-one")).toEqual(["implement"]);
  });

  it("does not unlock downstream work when a settled attempt is rejected", () => {
    const state = compileDurableMissionBundle(bundle([
      { schemaVersion: 1, missionId: "mission-one", seq: 0, ts: 1, event: { type: "plan_approved" } },
      { schemaVersion: 1, missionId: "mission-one", seq: 1, ts: 2, event: { type: "attempt_attached", taskId: "inspect", runId: "run-a" } },
      {
        schemaVersion: 1,
        missionId: "mission-one",
        seq: 2,
        ts: 3,
        event: {
          type: "attempt_validation_recorded",
          taskId: "inspect",
          runId: "run-a",
          accepted: false,
          validation: { ...validation, status: "unverified" },
        },
      },
    ]));
    expect(state.tasks.inspect.status).toBe("failed");
    expect(state.tasks.implement.status).toBe("blocked");
    expect(readyMissionTaskIds(state, "mission-one")).toEqual(["inspect"]);
  });

  it("keeps a settled Delegate attempt in review until an operator accepts it", () => {
    const reviewing = compileDurableMissionBundle(bundle([
      { schemaVersion: 1, missionId: "mission-one", seq: 0, ts: 1, event: { type: "plan_approved" } },
      { schemaVersion: 1, missionId: "mission-one", seq: 1, ts: 2, event: { type: "attempt_attached", taskId: "inspect", runId: "delegate-a" } },
      {
        schemaVersion: 1,
        missionId: "mission-one",
        seq: 2,
        ts: 3,
        event: {
          type: "attempt_settled",
          taskId: "inspect",
          runId: "delegate-a",
          exitCode: 0,
        },
      },
    ]));

    expect(reviewing.tasks.inspect.status).toBe("review");
    expect(reviewing.tasks.inspect.attempts[0]).toMatchObject({
      runId: "delegate-a",
      status: "review",
      exitCode: 0,
    });
    expect(reviewing.tasks.implement.status).toBe("blocked");
    expect(readyMissionTaskIds(reviewing, "mission-one")).toEqual([]);

    const accepted = compileDurableMissionBundle(bundle([
      { schemaVersion: 1, missionId: "mission-one", seq: 0, ts: 1, event: { type: "plan_approved" } },
      { schemaVersion: 1, missionId: "mission-one", seq: 1, ts: 2, event: { type: "attempt_attached", taskId: "inspect", runId: "delegate-a" } },
      {
        schemaVersion: 1,
        missionId: "mission-one",
        seq: 2,
        ts: 3,
        event: { type: "attempt_settled", taskId: "inspect", runId: "delegate-a", exitCode: 0 },
      },
      {
        schemaVersion: 1,
        missionId: "mission-one",
        seq: 3,
        ts: 4,
        event: {
          type: "attempt_validation_recorded",
          taskId: "inspect",
          runId: "delegate-a",
          accepted: true,
          validation: { ...validation, status: "passed" },
        },
      },
    ]));
    expect(accepted.tasks.inspect.status).toBe("done");
    expect(readyMissionTaskIds(accepted, "mission-one")).toEqual(["implement"]);
  });

  it("projects a restart-interrupted Run as an interrupted, retryable attempt (not a failure)", () => {
    const state = compileDurableMissionBundle(bundle([
      { schemaVersion: 1, missionId: "mission-one", seq: 0, ts: 1, event: { type: "plan_approved" } },
      { schemaVersion: 1, missionId: "mission-one", seq: 1, ts: 2, event: { type: "attempt_attached", taskId: "inspect", runId: "run-orphaned" } },
      {
        schemaVersion: 1,
        missionId: "mission-one",
        seq: 2,
        ts: 3,
        event: {
          type: "attempt_interrupted",
          taskId: "inspect",
          runId: "run-orphaned",
          reason: "Klide restarted before the Harness wrote a Run summary.",
        },
      },
      {
        schemaVersion: 1,
        missionId: "mission-one",
        seq: 3,
        ts: 4,
        event: {
          type: "mission_parked",
          reason: "No unattempted task is ready.",
        },
      },
    ]));

    // Distinct from a validation rejection: the work wasn't judged bad, the
    // process just died. It parks for a one-click retry, so the task and its
    // attempt both read "interrupted" rather than "failed".
    expect(state.tasks.inspect.status).toBe("interrupted");
    expect(state.tasks.inspect.attempts[0]).toMatchObject({
      runId: "run-orphaned",
      status: "interrupted",
      message: "Klide restarted before the Harness wrote a Run summary.",
    });
    // Still retryable, and the interruption must not cascade the mission or its
    // dependents into a failure state.
    expect(readyMissionTaskIds(state, "mission-one")).toEqual(["inspect"]);
    expect(state.tasks.implement.status).toBe("blocked");
    expect(state.missions["mission-one"].status).not.toBe("failed");
  });

  it("folds every event type Rust can emit", () => {
    // All eleven `MissionEvent` variants in one log. The projection's switch is
    // exhaustive, so this is the runtime half of that guarantee: the five
    // document-authoritative / derived-status events are deliberate no-ops and
    // must not throw, and the six that carry state still apply in seq order.
    // `frontend_mirror_matches_mission_event_wire` (Rust) is what keeps this
    // list honest when a twelfth variant lands.
    const state = compileDurableMissionBundle(bundle([
      { schemaVersion: 1, missionId: "mission-one", seq: 0, ts: 1, event: { type: "mission_created" } },
      { schemaVersion: 1, missionId: "mission-one", seq: 1, ts: 2, event: { type: "task_created", taskId: "inspect" } },
      { schemaVersion: 1, missionId: "mission-one", seq: 2, ts: 3, event: { type: "task_updated", taskId: "implement" } },
      { schemaVersion: 1, missionId: "mission-one", seq: 3, ts: 4, event: { type: "plan_approved" } },
      { schemaVersion: 1, missionId: "mission-one", seq: 4, ts: 5, event: { type: "attempt_attached", taskId: "inspect", runId: "run-a" } },
      { schemaVersion: 1, missionId: "mission-one", seq: 5, ts: 6, event: { type: "attempt_dispatch_failed", taskId: "inspect", runId: "run-a", message: "offline" } },
      { schemaVersion: 1, missionId: "mission-one", seq: 6, ts: 7, event: { type: "attempt_attached", taskId: "inspect", runId: "run-b" } },
      { schemaVersion: 1, missionId: "mission-one", seq: 7, ts: 8, event: { type: "attempt_interrupted", taskId: "inspect", runId: "run-b", reason: "restart" } },
      { schemaVersion: 1, missionId: "mission-one", seq: 8, ts: 9, event: { type: "attempt_attached", taskId: "inspect", runId: "run-c" } },
      { schemaVersion: 1, missionId: "mission-one", seq: 9, ts: 10, event: { type: "attempt_settled", taskId: "inspect", runId: "run-c", exitCode: 0 } },
      {
        schemaVersion: 1,
        missionId: "mission-one",
        seq: 10,
        ts: 11,
        event: { type: "attempt_validation_recorded", taskId: "inspect", runId: "run-c", accepted: true, validation },
      },
      { schemaVersion: 1, missionId: "mission-one", seq: 11, ts: 12, event: { type: "mission_completed" } },
      { schemaVersion: 1, missionId: "mission-one", seq: 12, ts: 13, event: { type: "mission_parked", reason: "operator" } },
    ]));

    // Three attempts on one Task — Task id and Run id are different lifecycle
    // objects, and only the accepted attempt gates the dependency.
    expect(state.tasks.inspect.attempts.map((a) => a.runId)).toEqual(["run-a", "run-b", "run-c"]);
    expect(state.tasks.inspect.acceptedRunId).toBe("run-c");
    expect(state.tasks.implement.status).toBe("ready");
  });

  it("projects events in seq order, not array order", () => {
    // Rust appends by `seq`; a reader that trusted array order would apply the
    // acceptance before the attachment and lose the accepted run.
    const state = compileDurableMissionBundle(bundle([
      {
        schemaVersion: 1,
        missionId: "mission-one",
        seq: 2,
        ts: 3,
        event: { type: "attempt_validation_recorded", taskId: "inspect", runId: "run-a", accepted: true, validation },
      },
      { schemaVersion: 1, missionId: "mission-one", seq: 1, ts: 2, event: { type: "attempt_attached", taskId: "inspect", runId: "run-a" } },
      { schemaVersion: 1, missionId: "mission-one", seq: 0, ts: 1, event: { type: "plan_approved" } },
    ]));

    expect(state.tasks.inspect.acceptedRunId).toBe("run-a");
    expect(state.tasks.implement.status).toBe("ready");
  });
});

describe("isolated attempts", () => {
  const events: DurableMissionBundle["events"] = [
    { schemaVersion: 1, missionId: "mission-one", seq: 0, ts: 1, event: { type: "plan_approved" } },
    { schemaVersion: 1, missionId: "mission-one", seq: 1, ts: 2, event: { type: "attempt_attached", taskId: "inspect", runId: "run-a" } },
    {
      schemaVersion: 1, missionId: "mission-one", seq: 2, ts: 3,
      event: {
        type: "attempt_checkout_prepared", taskId: "inspect", runId: "run-a", path: "/repo-worktrees/a",
        branch: "klide/mission-mission-one-inspect-run-a", missionBranch: "klide/mission-mission-one", baseCommit: "c0",
      },
    },
    { schemaVersion: 1, missionId: "mission-one", seq: 3, ts: 4, event: { type: "attempt_integrated", taskId: "inspect", runId: "run-a", missionBranch: "klide/mission-mission-one", commit: "c1" } },
  ];

  it("folds checkout and integration events without moving task status", () => {
    const state = compileDurableMissionBundle(bundle(events));
    expect(state.tasks.inspect.attempts.map((attempt) => attempt.runId)).toEqual(["run-a"]);
  });

  it("names the Mission branch and each attempt's worktree", () => {
    expect(missionBranchOf(events)).toBe("klide/mission-mission-one");
    expect(missionBranchOf(events.slice(0, 2))).toBeNull();
    expect(attemptCheckoutOf(events, "run-a")).toEqual({ path: "/repo-worktrees/a", branch: "klide/mission-mission-one-inspect-run-a" });
    expect(attemptCheckoutOf(events, "run-b")).toBeNull();
  });
});

describe("terminalOutcome", () => {
  const line = (
    seq: number,
    event: DurableMissionBundle["events"][number]["event"],
  ): DurableMissionBundle["events"][number] => (
    { schemaVersion: 1, missionId: "mission-one", seq, ts: seq + 1, event }
  );

  it("returns the latest terminal event", () => {
    const outcome = terminalOutcome([
      line(0, { type: "plan_approved" }),
      line(1, { type: "mission_parked", reason: "dispatch failed" }),
      line(2, { type: "attempt_attached", taskId: "inspect", runId: "run-a" }),
      line(3, { type: "mission_completed" }),
    ]);
    expect(outcome?.seq).toBe(3);
    expect(outcome?.event.type).toBe("mission_completed");
  });

  it("is null while the mission has no terminal event", () => {
    expect(terminalOutcome([
      line(0, { type: "plan_approved" }),
      line(1, { type: "attempt_attached", taskId: "inspect", runId: "run-a" }),
    ])).toBeNull();
  });

  it("treats a mission driven past a park as live again, not parked", () => {
    expect(terminalOutcome([
      line(0, { type: "mission_parked", reason: "dispatch failed" }),
      line(1, { type: "attempt_attached", taskId: "inspect", runId: "run-b" }),
    ])).toBeNull();
  });

  it("reads seq order, not array order", () => {
    const outcome = terminalOutcome([
      line(3, { type: "mission_completed" }),
      line(1, { type: "mission_parked", reason: "budget" }),
      line(0, { type: "plan_approved" }),
    ]);
    expect(outcome?.seq).toBe(3);
    expect(outcome?.event.type).toBe("mission_completed");
  });
});

describe("plannedTaskToSpecInput / specToPlannedTask", () => {
  const fullTask: PlannedTask = {
    taskId: "t4",
    title: "Implement core logic",
    description: "Wire the new module into the existing call sites.",
    acceptanceCriteria: ["Unit tests pass", "No new tsc errors"],
    phase: "Build",
    mode: "goal",
    risk: "high",
    writesFiles: true,
    dependsOn: ["t2", "t3"],
    needsRepoWideContext: true,
    needsStrongReasoning: true,
    needsDelegateCli: true,
    needsVisualReview: true,
  };

  function specFrom(input: ReturnType<typeof plannedTaskToSpecInput>): DurableMissionTaskSpec {
    return { ...input, schemaVersion: 1, missionId: "mission-one", createdMs: 1, updatedMs: 2 };
  }

  it("round-trips a fully specified task", () => {
    expect(specToPlannedTask(specFrom(plannedTaskToSpecInput(fullTask)))).toEqual(fullTask);
  });

  it("round-trips a minimal task, filling only the acceptance-criteria fallback", () => {
    const minimal: PlannedTask = {
      taskId: "t1",
      title: "Map the modules",
      phase: "Understand",
      mode: "plan",
      risk: "low",
      writesFiles: false,
    };
    const spec = specFrom(plannedTaskToSpecInput(minimal));
    // Never persisted empty: with no description either, the criterion falls
    // back to satisfying the title.
    expect(spec.acceptanceCriteria).toEqual(["The task outcome satisfies: Map the modules"]);
    expect(spec.bodyMarkdown).toBe("");
    expect(spec.dependencies).toEqual([]);
    expect(specToPlannedTask(spec)).toEqual({
      ...minimal,
      acceptanceCriteria: spec.acceptanceCriteria,
      description: undefined,
      dependsOn: undefined,
      needsRepoWideContext: undefined,
      needsStrongReasoning: undefined,
      needsDelegateCli: undefined,
      needsVisualReview: undefined,
    });
  });

  it("uses the description as the acceptance criterion when criteria are missing", () => {
    const spec = plannedTaskToSpecInput({ ...fullTask, acceptanceCriteria: undefined });
    expect(spec.acceptanceCriteria).toEqual([fullTask.description]);
  });
});
