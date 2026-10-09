import { describe, expect, it } from "vitest";
import { parsePlanMissionReceipt } from "./MissionCard";

describe("parsePlanMissionReceipt", () => {
  it("reads a plan receipt and its route", () => {
    const receipt = parsePlanMissionReceipt(JSON.stringify({
      schemaVersion: 1, action: "plan", missionId: "ship-mission-1", title: "Ship /mission",
      route: { workerKind: "harness", provider: "anthropic", model: "claude-sonnet-5-5", requireDiffReview: true },
    }));
    expect(receipt).toEqual({
      missionId: "ship-mission-1", title: "Ship /mission",
      route: { workerKind: "harness", provider: "anthropic", model: "claude-sonnet-5-5", requireDiffReview: true },
    });
  });
  it("is null for other receipts, errors and prose", () => {
    expect(parsePlanMissionReceipt(JSON.stringify({ action: "list", missions: [] }))).toBeNull();
    expect(parsePlanMissionReceipt("Mission orchestration requires Goal mode.")).toBeNull();
    expect(parsePlanMissionReceipt(JSON.stringify({ action: "plan" }))).toBeNull();
  });
  it("drops a malformed route rather than offering it", () => {
    expect(parsePlanMissionReceipt(JSON.stringify({ action: "plan", missionId: "m", title: "t", route: { provider: 1 } }))?.route).toBeUndefined();
  });
});
