import { describe, expect, it } from "vitest";
import type { Msg } from "./types";
import { rangeAroundMessage, searchConversation } from "./transcriptNavigation";
import { pairToolResults } from "./toolRuns";

function history(turns: number): Msg[] {
  return Array.from({ length: turns }, (_, i): Msg[] => [
    { role: "user", content: `Question ${i}` },
    { role: "assistant", content: "Reading", thinking: `Reason ${i}`, toolCalls: [{ id: `call-${i}`, name: "read_file", args: { path: `file-${i}.ts` } }] },
    { role: "tool", content: `Result ${i}`, toolName: "read_file", toolCallId: `call-${i}` },
    { role: "assistant", content: `Answer ${i}` },
  ]).flat();
}

describe("find in conversation", () => {
  it("finds old messages outside the recent render window with literal, case-insensitive matches", () => {
    const messages = history(100);
    expect(searchConversation(messages, "question 0").map(m => m.index)).toEqual([0]);
    expect(searchConversation([{ role: "assistant", content: "a.b A.B" }], "a.b").map(m => m.offset)).toEqual([0, 4]);
    expect(searchConversation(messages, "  ")).toEqual([]);
  });

  it("finds tool inputs, results, and recorded reasoning without changing the transcript", () => {
    const messages = history(3);
    const before = JSON.stringify(messages);
    const input = searchConversation(messages, "file-1.ts")[0];
    const result = searchConversation(messages, "Result 1")[0];
    expect(input).toMatchObject({ index: 5, field: "read_file" });
    expect(result).toMatchObject({ index: 6, field: "read_file" });
    expect(pairToolResults(messages).claimed.get(result.index)).toBe(input.index);
    expect(searchConversation(messages, "Reason 1", { includeReasoning: true })[0]).toMatchObject({ index: 5, field: "Reasoning" });
    expect(searchConversation([{ role: "assistant", content: "<think>hidden reason</think>Visible" }], "hidden reason", { includeReasoning: true })[0].field).toBe("Reasoning");
    expect(JSON.stringify(messages)).toBe(before);
  });

  it("excludes structured and inline thought process by default, while keeping visible answers searchable", () => {
    const messages: Msg[] = [
      { role: "assistant", content: "Visible answer", thinking: "private reasoning" },
      { role: "assistant", content: "<think>inline reasoning</think>Another answer" },
    ];
    expect(searchConversation(messages, "reasoning")).toEqual([]);
    expect(searchConversation(messages, "answer")).toHaveLength(2);
    expect(searchConversation(messages, "reasoning", { includeReasoning: true }).map(match => match.field)).toEqual(["Reasoning", "Reasoning"]);
    expect(searchConversation(messages, "reasoning", { includeReasoning: false })).toEqual([]);
  });

  it("counts repeated occurrences, excludes hidden wakes, and searches attachment names", () => {
    expect(searchConversation([{ role: "user", content: "find find find" }], "find")).toHaveLength(3);
    expect(searchConversation([{ role: "user", content: "secret", wake: true }], "secret")).toHaveLength(0);
    expect(searchConversation([{ role: "user", content: "", attachments: [{ path: "docs/plan.pdf", content: "base64-secret" }] }], "plan.pdf")[0].field).toBe("Attachment");
    expect(searchConversation([{ role: "user", content: "", attachments: [{ path: "docs/plan.pdf", content: "base64-secret" }] }], "base64-secret")).toHaveLength(0);
  });
});

describe("bounded message reveal", () => {
  it("can reach both ends without mounting intervening history", () => {
    const messages = history(200);
    for (const target of [0, 2, 399, 798, 799]) {
      const range = rangeAroundMessage(messages, target);
      expect(range.start).toBeLessThanOrEqual(target);
      expect(range.end).toBeGreaterThan(target);
      expect(range.end - range.start).toBe(24 * 4);
      expect(range.start % 4).toBe(0);
      expect(range.end % 4).toBe(0);
    }
  });

  it("keeps queued prompts with the active answer and observer exchanges intact", () => {
    const messages: Msg[] = [...history(30),
      { role: "system", content: "Done", observer: { shellId: "shell-1" } },
      { role: "assistant", content: "Follow-up" },
      ...Array.from({ length: 40 }, (): Msg => ({ role: "user", content: "Next", queueState: "queued" })),
    ];
    const range = rangeAroundMessage(messages, messages.length - 1, 1);
    expect(range).toEqual({ start: 120, end: messages.length });
  });

  it("preserves a single huge exchange and handles empty histories", () => {
    const messages: Msg[] = [{ role: "user", content: "Work" }, ...Array.from({ length: 300 }, (): Msg => ({ role: "assistant", content: "Step" }))];
    expect(rangeAroundMessage(messages, 150)).toEqual({ start: 0, end: 301 });
    expect(rangeAroundMessage([], 0)).toEqual({ start: 0, end: 0 });
  });
});
