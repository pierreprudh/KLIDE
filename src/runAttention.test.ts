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
const rust: { status: string | null; events: unknown[] } = { status: null, events: [] };
vi.mock("./agent/client", () => ({
  resolvePermission: async (input: unknown) => { answers.push(input); },
  getAgentRunStatus: async () => rust.status,
  readAgentRunEvents: async () => rust.events,
}));
vi.mock("./klideConvos", () => ({ getKlideConvos: () => [{ id: "convo-1", title: "Fix the login", provider: "anthropic" }] }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
const live = new Set<string>();
const liveListeners = new Set<() => void>();
vi.mock("./runningConversations", () => ({
  getRunningConversationIds: () => live,
  subscribeRunningConversations: (fn: () => void) => { liveListeners.add(fn); return () => liveListeners.delete(fn); },
}));

import { applyRunAttention, finishedUnseenNow, markNeedsYou, needsYouNow, resetRunAttention, showConversation, watchRunAttention } from "./runAttention";

const ask = { runId: "convo-1", state: "asking" as const, kind: "permission" as const, requestId: "perm_1", summary: "Run npm test" };

afterEach(() => {
  resetRunAttention(); toasts.length = 0; dismissed.length = 0; answers.length = 0;
  live.clear(); rust.status = null; rust.events = [];
});

describe("runAttention", () => {
  it("an approval in a conversation you are not looking at toasts, answerable, and marks the rail", () => {
    applyRunAttention(ask);
    expect(needsYouNow("convo-1")).toBe(true);
    const t = toasts[0];
    expect(t.message).toBe("Fix the login needs your approval — Run npm test");
    expect(t.provider).toBe("anthropic");
    expect(t.actions?.map((a) => a.label)).toEqual(["Deny", "Allow"]);
    t.actions![0].run();
    expect(answers).toEqual([{ runId: "convo-1", requestId: "perm_1", decision: { behavior: "deny" } }]);
    applyRunAttention({ runId: "convo-1", state: "clear" });
    expect(needsYouNow("convo-1")).toBe(false);
    expect(dismissed).toEqual([t.id]);
  });

  it("the conversation on screen shows its own card: no toast, but the rail still knows", () => {
    const release = showConversation("convo-1");
    applyRunAttention(ask);
    expect(toasts).toHaveLength(0);
    expect(needsYouNow("convo-1")).toBe(true);
    release();
  });

  it("a question is opened, not answered, from the toast", () => {
    applyRunAttention({ ...ask, kind: "question", summary: "Which model?" });
    expect(toasts[0].message).toBe("Fix the login asks — Which model?");
    expect(toasts[0].actions).toBeUndefined();
    expect(toasts[0].action?.label).toBe("Open");
  });

  it("a run already parked when the window opened still toasts and marks the rail", async () => {
    live.add("convo-1");
    rust.status = "waiting_for_permission";
    rust.events = [{ type: "permission_requested", runId: "convo-1", request: { id: "perm_9", summary: "› sh test.sh" }, ts: 1 }];
    const stop = watchRunAttention();
    await vi.waitFor(() => expect(needsYouNow("convo-1")).toBe(true));
    expect(toasts[0].message).toBe("Fix the login needs your approval — › sh test.sh");
    stop();
  });

  it("a live run that is just working raises nothing", async () => {
    live.add("convo-1");
    rust.status = "running";
    const stop = watchRunAttention();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(needsYouNow("convo-1")).toBe(false);
    expect(toasts).toHaveLength(0);
    stop();
  });

  it("a worker asking marks its parent until it stops asking", () => {
    markNeedsYou("parent", "sub_parent_c1", true);
    markNeedsYou("parent", "sub_parent_c2", true);
    markNeedsYou("parent", "sub_parent_c1", false);
    expect(needsYouNow("parent")).toBe(true);
    markNeedsYou("parent", "sub_parent_c2", false);
    expect(needsYouNow("parent")).toBe(false);
  });

  it("a run that finishes while you are elsewhere marks the row until you open it", async () => {
    rust.status = "running";
    live.add("convo-1");
    const stop = watchRunAttention();
    live.delete("convo-1");
    for (const fn of liveListeners) fn();
    expect(finishedUnseenNow("convo-1")).toBe(true);
    showConversation("convo-1")();
    expect(finishedUnseenNow("convo-1")).toBe(false);
    stop();
  });

  it("a run that finishes on screen leaves nothing to catch up on", () => {
    rust.status = "running";
    live.add("convo-1");
    const release = showConversation("convo-1");
    const stop = watchRunAttention();
    live.delete("convo-1");
    for (const fn of liveListeners) fn();
    expect(finishedUnseenNow("convo-1")).toBe(false);
    release();
    stop();
  });
});
