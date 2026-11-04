import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { createSchedule, localScheduleTime, mergeScheduleRows, type Schedule } from "./schedules";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue({}), Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

it("saves the same execution settings as Send, with an absolute due time and repeat interval", async () => {
  await createSchedule({
    runId: "conversation", workspaceRoot: "/tmp/workspace", text: "/goal Check the build", mode: "goal",
    provider: "codex", model: "test-model", attachments: [{ path: "README.md", content: "context" }],
    goal: { objective: "Check the build" }, maxTurns: 12, requireDiffReview: true,
  }, 1_900_000_000_000, 86_400_000);
  expect(invoke).toHaveBeenCalledWith("agent_schedule_create", expect.objectContaining({
    dueAt: 1_900_000_000_000, intervalMs: 86_400_000,
    target: { kind: "local" },
    request: expect.objectContaining({
      runId: "conversation", initialText: "/goal Check the build", provider: "codex", model: "test-model",
      goal: { objective: "Check the build" }, maxTurns: 12, requireDiffReview: true,
      attachments: [{ path: "README.md", content: "context" }],
    }),
  }));
});

it("keeps the service's newest state when a desktop read completes late", () => {
  const newest = { id: "schedule", revision: 8, status: "running" } as Schedule;
  const older = { id: "schedule", revision: 7, status: "pending" } as Schedule;
  expect(mergeScheduleRows([newest], [older])).toEqual([newest]);
  expect(mergeScheduleRows([older], [newest])).toEqual([newest]);
});

it("keeps the user's local wall-clock time in the datetime input", () => {
  const local = new Date(2026, 10, 4, 9, 15);
  expect(localScheduleTime(local)).toBe("2026-11-04T09:15");
  expect(new Date(localScheduleTime(local)).getTime()).toBe(local.getTime());
});
