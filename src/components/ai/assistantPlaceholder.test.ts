import { describe, expect, it } from "vitest";
import { assistantPlaceholder } from "./assistantPlaceholder";
import type { Msg } from "./types";

const empty: Msg = { role: "assistant", content: "", provider: "opencode" };

describe("assistant placeholder activity", () => {
  it("does not restart an old empty response when a follow-up starts", () => {
    const messages: Msg[] = [{ role: "user", content: "benchmark" }, empty, { role: "user", content: "so" }, { ...empty, delegateHeadless: true }];
    expect(messages.map((m, i) => assistantPlaceholder(m, true, i === 3))).toEqual([null, "hidden", null, "working"]);
  });

  it("keeps the current placeholder active above a queued follow-up", () => {
    expect(assistantPlaceholder(empty, true, true)).toBe("working");
  });

  it("hides a settled empty response", () => {
    expect(assistantPlaceholder(empty, false, true)).toBe("hidden");
  });

  it.each([
    { ...empty, content: "Answer" },
    { ...empty, thinking: "Thinking" },
    { ...empty, toolCalls: [{ name: "bash", args: {} }] },
    { ...empty, subagent: "explorer" },
    { ...empty, delegateConsole: true },
  ] satisfies Msg[])("preserves non-placeholder surfaces", (m) => {
    expect(assistantPlaceholder(m, true, false)).toBeNull();
  });
});
