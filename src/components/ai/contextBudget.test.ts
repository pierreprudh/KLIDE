import { describe, expect, it } from "vitest";
import {
  canCompactConversation,
  computeContextBudget,
  contextTone,
  conversationCost,
  lastCompactionIndex,
  COMPACT_KEEP_RECENT,
  type ContextBudgetInput,
} from "./contextBudget";
import type { Msg } from "./types";
import { conversationTokenEstimate } from "./contextBudget";
import { foldAgentEvents, foldedToMsgs } from "../../agent/foldEvents";
import type { AgentEvent } from "../../agent/types";
import { messageTokenEstimate } from "./utils";

function user(content: string): Msg {
  return { role: "user", content };
}
function assistant(content: string, costUsd?: number): Msg {
  return { role: "assistant", content, ...(costUsd ? { meta: { costUsd } } : {}) };
}
function compactionMarker(): Msg {
  return {
    role: "system",
    content: "Compacted 8 messages.",
    compaction: { count: 8, summary: "earlier work" },
  };
}

function input(over: Partial<ContextBudgetInput> = {}): ContextBudgetInput {
  return {
    msgs: [],
    draft: "",
    systemPrompt: "",
    skillsPrompt: "",
    projectRules: "",
    lens: [],
    toolSchemaTokens: 0,
    measuredPromptTokens: null,
    measuredUsageTokens: null,
    contextLimit: 1000,
    streaming: false,
    ...over,
  };
}

describe("lastCompactionIndex", () => {
  it("is -1 when nothing has been compacted", () => {
    expect(lastCompactionIndex([user("a"), assistant("b")])).toBe(-1);
  });

  it("finds the newest marker, not the first", () => {
    const msgs = [user("a"), compactionMarker(), user("b"), compactionMarker(), user("c")];
    expect(lastCompactionIndex(msgs)).toBe(3);
  });

  it("ignores a plain system message", () => {
    const msgs: Msg[] = [{ role: "system", content: "note" }, user("a")];
    expect(lastCompactionIndex(msgs)).toBe(-1);
  });
});

describe("computeContextBudget", () => {
  it("counts the request inside a checkpoint once, then adds answers and later requests", () => {
    const events: AgentEvent[] = [
      { type: "user_message", runId: "r", messageId: "u", text: "x".repeat(4000), attachments: [{ path: "rules.md", content: "constraints".repeat(100) }], ts: 0 },
      { type: "context_compacted", runId: "r", summary: "notes", kept: 1, contextTokens: 1600, ts: 1 },
    ];
    const beforeAnswer = foldedToMsgs(foldAgentEvents(events));
    expect(beforeAnswer.map((m) => m.role)).toEqual(["user", "system"]);
    expect(conversationTokenEstimate(beforeAnswer)).toBe(1600);
    events.push({ type: "assistant_message", runId: "r", messageId: "a", content: [{ type: "text", text: "The answer." }], ts: 2 });
    const afterAnswer = foldedToMsgs(foldAgentEvents(events));
    const later = user("One more question");
    expect(conversationTokenEstimate([...afterAnswer, later])).toBe(1600 + messageTokenEstimate(afterAnswer[2]) + messageTokenEstimate(later));
    expect(conversationTokenEstimate(JSON.parse(JSON.stringify(afterAnswer)))).toBe(conversationTokenEstimate(afterAnswer));
  });

  it("does not skip a new request following a compaction between turns", () => {
    const events: AgentEvent[] = [
      { type: "context_compacted", runId: "r", summary: "notes", kept: 0, contextTokens: 700, ts: 0 },
      { type: "user_message", runId: "r", messageId: "u", text: "A new request", attachments: [], ts: 1 },
    ];
    const msgs = foldedToMsgs(foldAgentEvents(events));
    expect(conversationTokenEstimate(msgs)).toBe(700 + messageTokenEstimate(msgs[1]));
  });

  it("counts only from the newest compaction marker onward", () => {
    // The loop this prevents: messages above the marker are still on screen but
    // no longer reach the model. Counting them over-states the window, the
    // over-statement never goes away, and the automatic compaction fires again
    // on the next render — summarising the same conversation forever.
    const older = [user("x".repeat(4000)), assistant("y".repeat(4000))];
    const recent = [compactionMarker(), user("hello")];

    const withHistory = computeContextBudget(input({ msgs: [...older, ...recent] }));
    const recentOnly = computeContextBudget(input({ msgs: recent }));
    expect(withHistory.messageTokens).toBe(recentOnly.messageTokens);
  });

  it("prefers the provider's measured prompt count once a turn settles", () => {
    const msgs = [user("a".repeat(400))];
    const estimated = computeContextBudget(input({ msgs }));
    const measured = computeContextBudget(input({ msgs, measuredPromptTokens: 640 }));
    expect(measured.committedUsed).toBe(640);
    expect(measured.committedUsed).not.toBe(estimated.committedUsed);
  });

  it("ignores the measured count mid-stream, when it describes the previous turn", () => {
    const msgs = [user("a".repeat(400))];
    const streaming = computeContextBudget(
      input({ msgs, measuredPromptTokens: 640, streaming: true })
    );
    const estimated = computeContextBudget(input({ msgs }));
    expect(streaming.committedUsed).toBe(estimated.committedUsed);
  });

  it("counts the draft in `used` but never in `committedUsed`", () => {
    // This is what stops a long unsent draft from arming a paid summarisation.
    const msgs = [user("short")];
    const empty = computeContextBudget(input({ msgs }));
    const typing = computeContextBudget(input({ msgs, draft: "d".repeat(2000) }));
    expect(typing.used).toBeGreaterThan(empty.used);
    expect(typing.committedUsed).toBe(empty.committedUsed);
    expect(typing.rawRatio).toBe(empty.rawRatio);
  });

  it("clamps the display ratio but not the auto-compaction ratio", () => {
    const over = computeContextBudget(
      input({ msgs: [user("a")], measuredPromptTokens: 5000, contextLimit: 1000 })
    );
    expect(over.ratio).toBe(1);
    expect(over.rawRatio).toBeCloseTo(5);
  });

  it("attributes skills and rules once, not twice", () => {
    // They are already inside the assembled system prompt, so the system row
    // subtracts them back out.
    const skillsPrompt = "s".repeat(370);
    const projectRules = "r".repeat(370);
    const b = computeContextBudget(
      input({ systemPrompt: `base${skillsPrompt}${projectRules}`, skillsPrompt, projectRules })
    );
    const rows = Object.fromEntries(b.breakdown.map((r) => [r.id, r.tokens]));
    expect(rows.skills).toBeGreaterThan(0);
    expect(rows.rules).toBeGreaterThan(0);
    // base is 4 chars → 2 tokens at ~3.7 chars/token.
    expect(rows.system).toBeLessThan(5);
  });

  it("drops empty rows and always ends with free space", () => {
    const b = computeContextBudget(input({ msgs: [user("hi")] }));
    expect(b.breakdown.every((r) => r.tokens > 0 || r.id === "free")).toBe(true);
    expect(b.breakdown[b.breakdown.length - 1].id).toBe("free");
    expect(b.breakdown.find((r) => r.id === "skills")).toBeUndefined();
  });

  it("shows provider overhead only when the provider counted more than we did", () => {
    const msgs = [user("a".repeat(100))];
    const under = computeContextBudget(input({ msgs, measuredPromptTokens: 1 }));
    expect(under.breakdown.find((r) => r.id === "measured-extra")).toBeUndefined();

    const over = computeContextBudget(input({ msgs, measuredPromptTokens: 900 }));
    const extra = over.breakdown.find((r) => r.id === "measured-extra");
    expect(extra?.tokens).toBeGreaterThan(0);
  });

  it("never reports negative free space", () => {
    const b = computeContextBudget(
      input({ msgs: [user("a")], measuredPromptTokens: 9999, contextLimit: 100 })
    );
    expect(b.remaining).toBe(0);
  });

  it("survives a zero context limit instead of dividing by it", () => {
    const b = computeContextBudget(input({ msgs: [user("a")], contextLimit: 0 }));
    expect(b.ratio).toBe(0);
    expect(b.rawRatio).toBe(0);
    expect(Number.isFinite(b.ratio)).toBe(true);
  });

  it("keeps `promptUsed` on the usage signal, separate from the prompt count", () => {
    // Two separate provider signals; a provider may report one and not the
    // other, so the tooltip keeps its own number.
    const b = computeContextBudget(
      input({
        msgs: [user("a")],
        measuredPromptTokens: 500,
        measuredUsageTokens: { prompt: 700, completion: 60 },
      })
    );
    expect(b.committedUsed).toBe(500);
    expect(b.promptUsed).toBe(700);
    expect(b.breakdown.find((r) => r.id === "reply")?.tokens).toBe(60);
  });
});

describe("contextTone", () => {
  it("escalates only past the two thresholds", () => {
    expect(contextTone(0)).toBe("var(--accent)");
    expect(contextTone(0.65)).toBe("var(--accent)");
    expect(contextTone(0.66)).toBe("var(--warning)");
    expect(contextTone(0.85)).toBe("var(--warning)");
    expect(contextTone(0.86)).toBe("var(--danger)");
  });
});

describe("canCompactConversation", () => {
  const base = {
    providerDelegatesWork: false,
    streaming: false,
    compacting: false,
    messageCount: COMPACT_KEEP_RECENT + 2,
  };

  it("needs more messages than a compaction would keep", () => {
    expect(canCompactConversation(base)).toBe(true);
    expect(canCompactConversation({ ...base, messageCount: COMPACT_KEEP_RECENT + 1 })).toBe(false);
  });

  it("never offers to compact a delegate conversation", () => {
    // The CLI behind a delegate manages its own context.
    expect(canCompactConversation({ ...base, providerDelegatesWork: true })).toBe(false);
  });

  it("waits for a turn to finish, and never re-enters itself", () => {
    expect(canCompactConversation({ ...base, streaming: true })).toBe(false);
    expect(canCompactConversation({ ...base, compacting: true })).toBe(false);
  });

});

describe("conversationCost", () => {
  it("sums assistant turns and ignores everything else", () => {
    expect(
      conversationCost([user("a"), assistant("b", 0.001), user("c"), assistant("d", 0.002)])
    ).toBeCloseTo(0.003);
  });

  it("is 0 for models with no known price", () => {
    expect(conversationCost([user("a"), assistant("b")])).toBe(0);
  });
});

describe("conversationTokenEstimate", () => {
  it("counts Rust's compacted history estimate including its retained tail", () => {
    const marker = compactionMarker();
    if (marker.role !== "system" || !marker.compaction) throw new Error("marker");
    Object.assign(marker.compaction, { contextTokens: 987 });
    expect(conversationTokenEstimate([user("discarded".repeat(1000)), marker])).toBe(987);
    expect(conversationTokenEstimate([marker, user("new work")])).toBeGreaterThan(987);
    expect(computeContextBudget(input({ msgs: [marker] })).used).toBe(987);
  });

  it("is the number the budget uses, so a caller may memoize it on msgs and pass it in", () => {
    const msgs = [user("a".repeat(400)), compactionMarker(), assistant("b".repeat(800))];
    const estimate = conversationTokenEstimate(msgs);
    expect(estimate).toBeGreaterThan(0);
    expect(computeContextBudget(input({ msgs })).messageTokens).toBe(estimate);
    expect(computeContextBudget(input({ msgs, messageTokens: estimate })).messageTokens).toBe(estimate);
    // Still counts only from the newest compaction marker onward.
    expect(estimate).toBe(conversationTokenEstimate(msgs.slice(1)));
  });
});

describe("breakdown details", () => {
  it("splits Messages by what each token is, summing to the row", () => {
    const msgs: Msg[] = [
      user("a".repeat(370)),
      { role: "assistant", content: "b".repeat(740), thinking: "c".repeat(185), toolCalls: [] },
      { role: "tool", content: "d".repeat(1850), toolName: "read_file" },
    ];
    const row = computeContextBudget(input({ msgs })).breakdown.find((r) => r.id === "messages")!;
    expect(row.details!.map((d) => d.label)).toEqual(["Tool calls and results", "Answers", "Your messages", "Reasoning"]);
    expect(row.details!.reduce((sum, d) => sum + d.tokens, 0)).toBe(row.tokens);
  });

  it("counts a compaction checkpoint as compacted notes", () => {
    const marker = compactionMarker();
    if (marker.role !== "system" || !marker.compaction) throw new Error("marker");
    Object.assign(marker.compaction, { contextTokens: 900 });
    const row = computeContextBudget(input({ msgs: [marker, user("next")] })).breakdown.find((r) => r.id === "messages")!;
    expect(row.details![0]).toEqual({ label: "Compacted notes", tokens: 900 });
  });

  it("lists the largest skills, folds the tail, and gives the preamble the rest", () => {
    const lines = Array.from({ length: 7 }, (_, i) => ({ command: `/s${i}`, line: `- /s${i} — ${"x".repeat(37 * (i + 1))}` }));
    const skillParts = { preamble: "p".repeat(370), lines };
    const skillsPrompt = `${skillParts.preamble}\n${lines.map((l) => l.line).join("\n")}`;
    const row = computeContextBudget(input({ skillsPrompt, systemPrompt: skillsPrompt, skillParts })).breakdown.find((r) => r.id === "skills")!;
    expect(row.details!.map((d) => d.label)).toEqual(["/s6", "/s5", "/s4", "/s3", "/s2", "2 more skills", "How to use skills"]);
    expect(row.details!.reduce((sum, d) => sum + d.tokens, 0)).toBe(row.tokens);
  });
});
