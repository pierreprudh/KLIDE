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
vi.mock("./klideConvos", () => ({ getKlideConvos: () => [{ id: "convo-1", title: "Fix the login", provider: "anthropic" }] }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

import { applyRunAttention, markNeedsYou, needsYouNow, resetRunAttention, showConversation } from "./runAttention";

const ask = { runId: "convo-1", state: "asking" as const, kind: "permission" as const, requestId: "perm_1", summary: "Run npm test" };

afterEach(() => { resetRunAttention(); toasts.length = 0; dismissed.length = 0; answers.length = 0; });

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

  it("a worker asking marks its parent until it stops asking", () => {
    markNeedsYou("parent", "sub_parent_c1", true);
    markNeedsYou("parent", "sub_parent_c2", true);
    markNeedsYou("parent", "sub_parent_c1", false);
    expect(needsYouNow("parent")).toBe(true);
    markNeedsYou("parent", "sub_parent_c2", false);
    expect(needsYouNow("parent")).toBe(false);
  });
});
