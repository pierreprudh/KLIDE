import { describe, expect, it } from "vitest";
import { appendMissionReports, missionReportSummary } from "./missionReports";
import type { DurableMissionBundle } from "../../agent/durableMissions";

const completed: DurableMissionBundle = {
  mission: { schemaVersion: 1, id: "m", title: "Read files", intent: "Report", mode: "goal", taskIds: [], coordinatorRunId: "planner", createdMs: 1, updatedMs: 1 },
  tasks: [],
  events: [{ schemaVersion: 1, missionId: "m", seq: 0, ts: 2, event: { type: "mission_completed" } }],
  report: { markdown: "## Mission completed\nApp: klide", completedMs: 2 },
};
describe("Mission report delivery", () => {
  it("delivers once and survives reopening the planning chat", () => {
    const delivered = appendMissionReports([], [completed], "planner");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ role: "assistant", missionReportId: "m", ts: 2 });
    expect(appendMissionReports(delivered, [completed], "planner")).toBe(delivered);
    const rehydrated = [{ role: "assistant" as const, content: completed.report!.markdown }];
    const recovered = appendMissionReports(rehydrated, [completed], "planner");
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ missionReportId: "m" });
    expect(appendMissionReports(recovered, [completed], "planner")).toBe(recovered);
  });
  it("summarizes answers in a message while keeping evidence in the panel", () => {
    const summary = missionReportSummary("## Mission completed: Read files\n\n### Package\n\nApp name: klide\n\nWorker: `worker-1`\n\nVerification: passed\n\n### README\n\nHeading: # Klide\n\nWorker: `worker-2`");
    expect(summary).toContain("App name: klide");
    expect(summary).toContain("Heading: # Klide");
    expect(summary).not.toContain("Worker:");
    expect(summary).not.toContain("Verification:");
    expect(summary).toContain("Mission side panel");
  });
  it("does not deliver another chat's report, parked work, or a report saved before completion", () => {
    expect(appendMissionReports([], [completed], "other")).toEqual([]);
    expect(appendMissionReports([], [{ ...completed, events: [] }], "planner")).toEqual([]);
    const parked = { ...completed, events: [...completed.events, { ...completed.events[0], seq: 1, event: { type: "mission_parked" as const, reason: "Retry" } }] };
    expect(appendMissionReports([], [parked], "planner")).toEqual([]);
  });
});
