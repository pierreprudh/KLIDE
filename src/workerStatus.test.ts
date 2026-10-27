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
vi.mock("./agent/client", () => ({ resolvePermission: async (input: unknown) => { answers.push(input); } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

import { applyWorkerStatus, hasLiveWorker, resetWorkerStatus, workerTransition, type WorkerStatus } from "./workerStatus";

const status = (state: WorkerStatus["state"], extra: Partial<WorkerStatus> = {}): WorkerStatus => ({
  parentId: "convo-1", runId: "sub_convo-1_c1", label: "Claude Code", role: "implementer", state, ...extra,
});

afterEach(() => { resetWorkerStatus(); toasts.length = 0; dismissed.length = 0; answers.length = 0; });

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
});
