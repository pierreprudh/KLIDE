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

  it("projects a restart-interrupted Run as a failed retryable attempt", () => {
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

    expect(state.tasks.inspect.status).toBe("failed");
    expect(state.tasks.inspect.attempts[0]).toMatchObject({
      runId: "run-orphaned",
      status: "interrupted",
      message: "Klide restarted before the Harness wrote a Run summary.",
    });
    expect(readyMissionTaskIds(state, "mission-one")).toEqual(["inspect"]);
    expect(state.tasks.implement.status).toBe("blocked");
  });
});
