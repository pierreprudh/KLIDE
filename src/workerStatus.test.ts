import { afterEach, describe, expect, it, vi } from "vitest";

const toasts: Array<{ message: string; tone?: string }> = [];
vi.mock("./toast", () => ({ notify: (message: string, opts: { tone?: string } = {}) => { toasts.push({ message, tone: opts.tone }); return 1; } }));
vi.mock("./conversationNavigation", () => ({ canOpenConversation: () => false, openConversation: () => false }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

import { applyWorkerStatus, hasLiveWorker, resetWorkerStatus, workerTransition, type WorkerStatus } from "./workerStatus";

const status = (state: WorkerStatus["state"], detail?: string): WorkerStatus => ({
  parentId: "convo-1", runId: "sub_convo-1_c1", label: "Claude Code", role: "implementer", state, detail,
});

afterEach(() => { resetWorkerStatus(); toasts.length = 0; });

describe("workerTransition", () => {
  it("toasts when a worker asks, finishes or fails — once per transition", () => {
    expect(workerTransition("working", status("asking", "Run sh test.sh")).toast)
      .toEqual({ message: "Claude Code (implementer) needs your approval: Run sh test.sh", tone: "warn" });
    expect(workerTransition("asking", status("asking")).toast).toBeNull();
    expect(workerTransition("working", status("finished")).toast).toEqual({ message: "Claude Code (implementer) finished", tone: "success" });
    expect(workerTransition("working", status("failed", "gone")).toast?.tone).toBe("error");
    expect(workerTransition(undefined, status("working")).toast).toBeNull();
  });
});

describe("applyWorkerStatus", () => {
  it("counts a working or asking worker as live for its parent, and stops on settle", () => {
    applyWorkerStatus(status("working"));
    expect(hasLiveWorker("convo-1")).toBe(true);
    applyWorkerStatus(status("asking", "Edit test.sh"));
    expect(hasLiveWorker("convo-1")).toBe(true);
    applyWorkerStatus(status("working"));
    applyWorkerStatus(status("finished"));
    expect(hasLiveWorker("convo-1")).toBe(false);
    expect(toasts.map((t) => t.message)).toEqual([
      "Claude Code (implementer) needs your approval: Edit test.sh",
      "Claude Code (implementer) finished",
    ]);
  });
});
