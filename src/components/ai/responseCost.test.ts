import { describe, expect, it } from "vitest";
import { responseCosts } from "./responseCost";
import { createFold, foldAgentEvents, foldedToMsgs } from "../../agent/foldEvents";
import { conversationCost } from "./contextBudget";
import type { AgentEvent } from "../../agent/types";

describe("responseCosts", () => {
  it("includes every model call behind the answer on both live folding and replay", () => {
    const events: AgentEvent[] = [
      { type: "user_message", runId: "r", messageId: "u", text: "inspect", attachments: [], ts: 0 },
      { type: "assistant_message", runId: "r", messageId: "a", content: [{ type: "tool_call", toolCallId: "c", name: "read_file", input: {} }], usage: { costUsd: 0.854 }, ts: 1 },
      { type: "tool_call_finished", runId: "r", toolCallId: "c", result: { ok: true, content: "code" }, ts: 2 },
      { type: "assistant_message", runId: "r", messageId: "b", content: [{ type: "text", text: "answer" }], usage: { costUsd: 0.142 }, ts: 3 },
    ];
    const msgs = foldedToMsgs(foldAgentEvents(events));
    const live = createFold();
    for (const event of events) live.apply(event);
    expect(responseCosts(foldedToMsgs(live.rows()))).toEqual(responseCosts(msgs));
    expect(responseCosts(msgs).get(msgs.length - 1)).toEqual({ costUsd: 0.996, calls: 2 });
    expect(responseCosts(msgs).has(1)).toBe(false);
    expect(responseCosts([...msgs, { role: "user", content: "next" }, { role: "assistant", content: "reply", meta: { costUsd: 0.586 } }]).get(msgs.length + 1)).toEqual({ costUsd: 0.586, calls: 1 });
  });

  it("does not double-count totals or mix manual compaction with the next response", () => {
    const msgs = [
      { role: "user" as const, content: "first" },
      { role: "assistant" as const, content: "answer", meta: { costUsd: 0.2 } },
      { role: "system" as const, content: "compact", compaction: { count: 2, summary: "notes", source: "manual" as const, costUsd: 0.1 } },
      { role: "user" as const, content: "next" },
      { role: "system" as const, content: "compact", compaction: { count: 3, summary: "notes", source: "agent" as const, costUsd: 0.03 } },
      { role: "assistant" as const, content: "answer", meta: { costUsd: 0.05 } },
    ];
    expect(responseCosts(msgs).get(1)).toEqual({ costUsd: 0.2, calls: 1 });
    expect(responseCosts(msgs).get(5)).toEqual({ costUsd: 0.08, calls: 2 });
    expect(conversationCost(msgs)).toBeCloseTo(0.38);
  });

  it("preserves a manual compaction's separate charge and layout after replay", () => {
    const msgs = foldedToMsgs(foldAgentEvents([
      { type: "context_compacted", runId: "r", summary: "notes", costUsd: 0.1, manual: true, ts: 0 },
      { type: "user_message", runId: "r", messageId: "u", text: "next", attachments: [], ts: 1 },
      { type: "assistant_message", runId: "r", messageId: "a", content: [{ type: "text", text: "reply" }], usage: { costUsd: 0.05 }, ts: 2 },
    ]));
    expect(msgs[0]).toMatchObject({ compaction: { source: "manual", costUsd: 0.1 } });
    expect(responseCosts(msgs).get(2)).toEqual({ costUsd: 0.05, calls: 1 });
    expect(conversationCost(msgs)).toBeCloseTo(0.15);
  });

  it("leaves unpriced responses unpriced and keeps known costs when a call has no usage", () => {
    expect(responseCosts([{ role: "assistant", content: "local" }]).size).toBe(0);
    const costs = responseCosts([
      { role: "user", content: "go" },
      { role: "assistant", content: "work", meta: { costUsd: 0.2 } },
      { role: "assistant", content: "done" },
    ]);
    expect(costs.get(2)).toEqual({ costUsd: 0.2, calls: 1 });
  });
});
