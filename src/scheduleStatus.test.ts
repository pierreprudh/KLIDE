import { beforeEach, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { listSchedules, type Schedule } from "./agent/schedules";
import { publishKlideConvo, settleKlideConvo } from "./klideConvos";
import { notify } from "./toast";
import { watchScheduleStatus } from "./scheduleStatus";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("./agent/schedules", () => ({ listSchedules: vi.fn() }));
vi.mock("./klideConvos", () => ({ getKlideConvos: () => [], publishKlideConvo: vi.fn(), settleKlideConvo: vi.fn() }));
vi.mock("./conversationNavigation", () => ({ canOpenConversation: () => false, openConversation: vi.fn() }));
vi.mock("./toast", () => ({ notify: vi.fn() }));

const running: Schedule = {
  id: "schedule", revision: 1, target: { kind: "local" }, name: "Review", runId: "conversation", activeRunId: "conversation", mode: "plan", text: "Review changes", dueAt: 1,
  intervalMs: null, status: "running", error: null,
  provider: "codex", model: "test", workspaceRoot: "/tmp/workspace",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listen).mockResolvedValue(() => {});
  vi.mocked(listSchedules).mockResolvedValue([]);
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
