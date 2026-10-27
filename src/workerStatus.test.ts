import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToastOptions } from "./toast";

const toasts: Array<{ id: number; message: string } & ToastOptions> = [];
const dismissed: number[] = [];
const answers: unknown[] = [];
vi.mock("./toast", () => ({
  notify: (message: string, opts: ToastOptions = {}) => { toasts.push({ id: toasts.length + 1, message, ...opts }); return toasts.length; },
  dismissToast: (id: number) => { dismissed.push(id); },
}));
vi.mock("./conversationNavigation", () => ({ canOpenConversation: () => true, openConversation: () => true }));
const recovery = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("./agent/client", () => ({
  resolvePermission: async (input: unknown) => { answers.push(input); },
  listWorkerStatuses: () => recovery.read(),
}));
const events = vi.hoisted(() => ({ deliver: null as null | ((event: { payload: WorkerStatus }) => void) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async (_name: string, fn: typeof events.deliver) => {
  events.deliver = fn;
  return () => { events.deliver = null; };
} }));

import { needsYouNow, resetRunAttention, showConversation } from "./runAttention";
import { applyWorkerStatus, hasLiveWorker, resetWorkerStatus, watchWorkerStatus, workerTransition, type WorkerStatus } from "./workerStatus";

const status = (state: WorkerStatus["state"], extra: Partial<WorkerStatus> = {}): WorkerStatus => ({
  parentId: "convo-1", runId: "sub_convo-1_c1", label: "Claude Code", role: "implementer", state, ...extra,
});

afterEach(() => { resetWorkerStatus(); resetRunAttention(); recovery.read.mockReset(); recovery.read.mockResolvedValue([]); toasts.length = 0; dismissed.length = 0; answers.length = 0; });

describe("workerTransition", () => {
  it("toasts when a worker asks, finishes or fails — once per transition", () => {
    expect(workerTransition("working", status("asking", { detail: "Run sh test.sh" })).toast)
      .toEqual({ message: "Claude Code (implementer) needs your approval — Run sh test.sh", tone: "warn" });
    expect(workerTransition("asking", status("asking")).toast).toBeNull();
    expect(workerTransition("working", status("finished")).toast).toEqual({ message: "Claude Code (implementer) finished", tone: "success" });
    expect(workerTransition("working", status("failed", { detail: "gone" })).toast?.tone).toBe("error");
    expect(workerTransition(undefined, status("working")).toast).toBeNull();
  });
});

describe("applyWorkerStatus", () => {
  it("counts a working or asking worker as live for its parent, and stops on settle", () => {
    applyWorkerStatus(status("working", { provider: "claude-code" }));
    expect(hasLiveWorker("convo-1")).toBe(true);
    applyWorkerStatus(status("asking", { detail: "Edit test.sh", requestId: "perm_1" }));
    expect(hasLiveWorker("convo-1")).toBe(true);
    applyWorkerStatus(status("working"));
    applyWorkerStatus(status("finished"));
    expect(hasLiveWorker("convo-1")).toBe(false);
    expect(toasts.map((t) => t.message)).toEqual([
      "Claude Code (implementer) needs your approval — Edit test.sh",
      "Claude Code (implementer) finished",
    ]);
  });

  it("asks with the worker's mark, Deny / Allow on the request, and goes once answered", () => {
    applyWorkerStatus(status("working", { provider: "claude-code" }));
    applyWorkerStatus(status("asking", { detail: "Edit test.sh", requestId: "perm_1" }));
    const ask = toasts[0];
    expect(ask.provider).toBe("claude-code");
    expect(ask.duration).toBe(0);
    expect(ask.actions?.map((a) => [a.label, !!a.primary])).toEqual([["Deny", false], ["Allow", true]]);
    expect(ask.action?.label).toBe("Open");
    ask.actions![1].run();
    expect(answers).toEqual([{ runId: "sub_convo-1_c1", requestId: "perm_1", decision: { behavior: "allow", scope: "once" } }]);
    // The worker moves on (answered here or on the row): the question goes.
    applyWorkerStatus(status("working"));
    expect(dismissed).toEqual([ask.id]);
  });

  it("raises no approval toast while its conversation is on screen: the row shows the card", () => {
    const release = showConversation("convo-1");
    applyWorkerStatus(status("working", { provider: "claude-code" }));
    applyWorkerStatus(status("asking", { detail: "Edit test.sh", requestId: "perm_1" }));
    expect(toasts).toHaveLength(0);
    applyWorkerStatus(status("finished"));
    expect(toasts.map((t) => t.message)).toEqual(["Claude Code (implementer) finished"]);
    release();
  });
});

describe("worker approval recovery", () => {
  it("requires the full card before allowing access outside the worker folder", () => {
    applyWorkerStatus(status("asking", { requestId: "outside", externalPaths: ["/other/test.sh"] }));
    expect(toasts[0].message).toContain("Outside its working folder");
    expect(toasts[0].actions?.some((a) => a.label === "Allow")).not.toBe(true);
    expect(toasts[0].action?.label).toBe("Open");
  });

  it("restores a worker already asking before this page subscribed", async () => {
    recovery.read.mockResolvedValue([status("asking", { seq: 7, provider: "claude-code", requestId: "parked" })]);
    const stop = watchWorkerStatus();
    try {
      await vi.waitFor(() => expect(hasLiveWorker("convo-1")).toBe(true));
      expect(toasts[0].actions?.map((a) => a.label)).toEqual(["Deny", "Allow"]);
      expect(toasts[0].provider).toBe("claude-code");
    } finally { stop(); }
  });

  it("ignores a recovered approval older than an already delivered resolution", () => {
    applyWorkerStatus(status("working", { seq: 8 }));
    applyWorkerStatus(status("asking", { seq: 7, requestId: "old" }));
    expect(toasts).toHaveLength(0);
  });
});

it("does not resurrect an approval when its snapshot arrives after a live completion", async () => {
  let finishRead!: (statuses: WorkerStatus[]) => void;
  recovery.read.mockImplementation(() => new Promise<WorkerStatus[]>((resolve) => { finishRead = resolve; }));
  const stop = watchWorkerStatus();
  try {
    await vi.waitFor(() => expect(recovery.read).toHaveBeenCalled());
    events.deliver!({ payload: status("finished", { seq: 10 }) });
    finishRead([status("asking", { seq: 7, requestId: "stale" })]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hasLiveWorker("convo-1")).toBe(false);
    expect(needsYouNow("convo-1")).toBe(false);
    expect(toasts.map((t) => t.message)).toEqual(["Claude Code (implementer) finished"]);
  } finally { stop(); }
});

it("ignores a snapshot response after the watcher was stopped", async () => {
  let finishRead!: (statuses: WorkerStatus[]) => void;
  recovery.read.mockImplementation(() => new Promise<WorkerStatus[]>((resolve) => { finishRead = resolve; }));
  const stop = watchWorkerStatus();
  await vi.waitFor(() => expect(recovery.read).toHaveBeenCalled());
  stop();
  finishRead([status("asking", { seq: 7, requestId: "stale" })]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(hasLiveWorker("convo-1")).toBe(false);
  expect(toasts).toHaveLength(0);
});
