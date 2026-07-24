import { describe, expect, it } from "vitest";
import { compileDurableMissionBundle, type DurableMissionBundle } from "./durableMissions";
import { readyMissionTaskIds } from "./missionHarness";

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
});
