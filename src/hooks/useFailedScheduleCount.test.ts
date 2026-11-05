import { describe, expect, it } from "vitest";
import { applyScheduleRow, countFailed } from "./useFailedScheduleCount";

describe("failed schedule count", () => {
  it("counts the latest status of each schedule", () => {
    const statuses = new Map();
    applyScheduleRow(statuses, { id: "a", status: "failed", revision: 1 });
    applyScheduleRow(statuses, { id: "b", status: "pending", revision: 1 });
    expect(countFailed(statuses)).toBe(1);
    applyScheduleRow(statuses, { id: "a", status: "running", revision: 2 });
    expect(countFailed(statuses)).toBe(0);
  });

  it("ignores an event for an older revision", () => {
    const statuses = new Map();
    applyScheduleRow(statuses, { id: "a", status: "completed", revision: 3 });
    expect(applyScheduleRow(statuses, { id: "a", status: "failed", revision: 2 })).toBe(false);
    expect(countFailed(statuses)).toBe(0);
  });
});
