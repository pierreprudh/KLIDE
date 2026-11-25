import { beforeEach, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { listSchedules, type Schedule } from "./agent/schedules";
import { publishKlideConvo, settleKlideConvo } from "./klideConvos";
import { notify } from "./toast";
import { watchScheduleStatus } from "./scheduleStatus";
import { ciWatchTake } from "./ipc/ciWatch";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("./agent/schedules", () => ({ listSchedules: vi.fn() }));
vi.mock("./klideConvos", () => ({ getKlideConvos: () => [], publishKlideConvo: vi.fn(), settleKlideConvo: vi.fn() }));
vi.mock("./conversationNavigation", () => ({ canOpenConversation: () => false, openConversation: vi.fn() }));
vi.mock("./toast", () => ({ notify: vi.fn() }));
vi.mock("./ipc/ciWatch", () => ({ ciWatchTake: vi.fn() }));

const running: Schedule = {
  id: "schedule", revision: 1, target: { kind: "local" }, name: "Review", runId: "conversation", activeRunId: "conversation", mode: "plan", text: "Review changes", dueAt: 1,
  intervalMs: null, status: "running", error: null,
  provider: "codex", model: "test", workspaceRoot: "/tmp/workspace",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listen).mockResolvedValue(() => {});
  vi.mocked(listSchedules).mockResolvedValue([]);
  vi.mocked(ciWatchTake).mockResolvedValue([]);
});

it("restores a hidden scheduled Run into the existing attention watcher candidates", async () => {
  vi.mocked(listSchedules).mockResolvedValue([running]);
  const stop = watchScheduleStatus();
  await vi.waitFor(() => expect(publishKlideConvo).toHaveBeenCalledWith(expect.objectContaining({
    id: "conversation", status: "running", provider: "codex", cwd: "/tmp/workspace",
  })));
  stop();
});

it("lets a live failure win over an older restore snapshot", async () => {
  let resolve!: (rows: Schedule[]) => void;
  vi.mocked(listSchedules).mockReturnValue(new Promise(r => { resolve = r; }));
  const stop = watchScheduleStatus();
  await vi.waitFor(() => expect(listSchedules).toHaveBeenCalled());
  const handler = vi.mocked(listen).mock.calls[0][1];
  handler({ event: "schedule:changed", id: 1, payload: { ...running, revision: 2, status: "failed", activeRunId: null, error: "Admission failed" } });
  resolve([running]);
  await new Promise(r => setTimeout(r, 0));
  expect(publishKlideConvo).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledWith(expect.stringContaining("Admission failed"), expect.objectContaining({ tone: "error" }));
  stop();
});

it("says so when a watched scheduled Run finishes", async () => {
  vi.mocked(listSchedules).mockResolvedValue([running]);
  const stop = watchScheduleStatus();
  await vi.waitFor(() => expect(publishKlideConvo).toHaveBeenCalled());
  const handler = vi.mocked(listen).mock.calls[0][1];
  handler({ event: "schedule:changed", id: 1, payload: { ...running, revision: 2, status: "completed", activeRunId: null } });
  expect(settleKlideConvo).toHaveBeenCalledWith("conversation");
  expect(notify).toHaveBeenCalledWith("Scheduled run finished — Review", expect.objectContaining({ tone: "success" }));
  stop();
});

it("reports a live Run failure once, as the settled occurrence", async () => {
  vi.mocked(listSchedules).mockResolvedValue([running]);
  const stop = watchScheduleStatus();
  await vi.waitFor(() => expect(publishKlideConvo).toHaveBeenCalled());
  const handler = vi.mocked(listen).mock.calls[0][1];
  handler({ event: "schedule:changed", id: 1, payload: { ...running, revision: 2, status: "failed", activeRunId: null, error: "boom" } });
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledWith("Scheduled run failed — Review: boom", expect.objectContaining({ tone: "error" }));
  stop();
});

it("takes CI watch firings on load and on each nudge, toasting each once", async () => {
  const fired = {
    key: "k", workspaceRoot: "/tmp/KIDE", prNumber: 573, prTitle: "Canary", prUrl: "u", checks: ["Frontend"],
    provider: "openrouter", model: "m", runId: "run_1", error: null, at: 1, announced: true,
  };
  vi.mocked(ciWatchTake).mockResolvedValueOnce([fired]).mockResolvedValue([]);
  const stop = watchScheduleStatus();
  await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringContaining("#573 Canary"), expect.objectContaining({ action: expect.anything() })));
  const nudge = vi.mocked(listen).mock.calls.find(c => c[0] === "ci-watch:pending")![1] as (e: unknown) => void;
  nudge({ payload: null });
  await vi.waitFor(() => expect(ciWatchTake).toHaveBeenCalledTimes(2));
  expect(notify).toHaveBeenCalledTimes(1);
  stop();
});
