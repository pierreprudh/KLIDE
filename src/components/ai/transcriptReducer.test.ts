import { describe, expect, it } from "vitest";
import {
  locateAssistant,
  appendDelta,
  startToolCall,
  finishToolCall,
  finalizeAssistantMessage,
} from "./transcriptReducer";
import type { Msg } from "./types";
import type { AgentContentBlock, AgentUsage, AgentEvent } from "../../agent/types";

const delegate = {};

function assistantMessage(
  content: AgentContentBlock[],
  usage?: AgentUsage
): Extract<AgentEvent, { type: "assistant_message" }> {
  return { type: "assistant_message", runId: "r", messageId: "m", content, usage, ts: 0 } as Extract<
    AgentEvent,
    { type: "assistant_message" }
  >;
}

describe("locateAssistant", () => {
  it("finds an existing assistant bubble at the cursor", () => {
    const msgs: Msg[] = [{ role: "assistant", content: "hi" }];
    const { msgs: out, index } = locateAssistant(msgs, 0, delegate);
    expect(index).toBe(0);
    expect(out).toBe(msgs); // same ref — no insertion
  });

  it("walks past tool rows to a later assistant bubble (multi-turn tool run)", () => {
    // After a tool_call_started splice, the cursor points at a tool card. The
    // old guard dropped every assistant update from here; walk past it instead.
    const msgs: Msg[] = [
      { role: "assistant", content: "" },
      { role: "tool", content: "Running grep...", toolName: "grep" },
      { role: "assistant", content: "final" },
    ];
    const { index } = locateAssistant(msgs, 1, delegate);
    expect(index).toBe(2);
  });

  it("inserts a fresh assistant bubble when the slot after tools isn't one", () => {
    const msgs: Msg[] = [
      { role: "assistant", content: "" },
      { role: "tool", content: "done", toolName: "grep" },
    ];
    const { msgs: out, index } = locateAssistant(msgs, 1, delegate);
    expect(index).toBe(2);
    expect(out).not.toBe(msgs); // cloned
    expect(out[2]).toMatchObject({ role: "assistant", content: "" });
  });
});

describe("appendDelta", () => {
  it("accumulates content and thinking onto the assistant bubble", () => {
    const msgs: Msg[] = [{ role: "assistant", content: "Hel" }];
    const step1 = appendDelta(msgs, 0, "lo", "", delegate);
    const step2 = appendDelta(step1.msgs, step1.index, " world", "reasoning", delegate);
    const a = step2.msgs[step2.index];
    expect(a).toMatchObject({ role: "assistant", content: "Hello world", thinking: "reasoning" });
  });

  it("does not mutate the input array", () => {
    const msgs: Msg[] = [{ role: "assistant", content: "a" }];
    appendDelta(msgs, 0, "b", "", delegate);
    expect((msgs[0] as { content: string }).content).toBe("a");
  });
});

describe("tool call rows", () => {
  it("startToolCall inserts a Running row after the assistant and advances the cursor", () => {
    const msgs: Msg[] = [{ role: "assistant", content: "" }];
    const { msgs: out, index } = startToolCall(msgs, 0, "read_file", "call-1");
    expect(index).toBe(1);
    expect(out[1]).toMatchObject({ role: "tool", content: "Running read_file...", toolCallId: "call-1" });
  });

  it("finishToolCall matches by id anywhere in the list", () => {
    const msgs: Msg[] = [
      { role: "tool", content: "Running a...", toolName: "a", toolCallId: "x", tool_call_id: "x" },
      { role: "tool", content: "Running b...", toolName: "b", toolCallId: "y", tool_call_id: "y" },
    ];
    const out = finishToolCall(msgs, "y", "b result");
    expect(out[1]).toMatchObject({ content: "b result", toolName: "b" });
    expect(out[0]).toMatchObject({ content: "Running a..." }); // untouched
  });
});

describe("finalizeAssistantMessage", () => {
  const base = {
    nextAssistantIdx: 0,
    timing: { turnStartedAt: 1000, firstTokenAt: 1200 },
    now: 2000,
    delegate,
  };

  it("keeps streamed content when the final message text is empty", () => {
    const msgs: Msg[] = [{ role: "assistant", content: "streamed so far" }];
    const r = finalizeAssistantMessage({ ...base, msgs, pricing: null, event: assistantMessage([{ type: "text", text: "" }]) });
    expect((r.msgs[r.index] as { content: string }).content).toBe("streamed so far");
  });

  it("computes duration and TTFT from injected timing", () => {
    const msgs: Msg[] = [{ role: "assistant", content: "" }];
    const r = finalizeAssistantMessage({ ...base, msgs, pricing: null, event: assistantMessage([{ type: "text", text: "hello" }]) });
    expect(r.meta.ms).toBe(1000); // now - turnStartedAt
    expect(r.meta.ttftMs).toBe(200); // firstTokenAt - turnStartedAt
  });

  it("prefers provider usage over estimates and surfaces measured prompt tokens", () => {
    const msgs: Msg[] = [{ role: "assistant", content: "" }];
    const r = finalizeAssistantMessage({
      ...base,
      msgs,
      pricing: null,
      event: assistantMessage([{ type: "text", text: "reply" }], { promptTokens: 500, completionTokens: 42 }),
    });
    expect(r.meta.tokens).toBe(42);
    expect(r.meta.exact).toBe(true);
    expect(r.measuredPromptTokens).toBe(542);
    expect(r.measuredUsage).toEqual({ prompt: 500, completion: 42 });
  });

  it("uses the provider's evalDuration for tok/s when present", () => {
    const msgs: Msg[] = [{ role: "assistant", content: "" }];
    const r = finalizeAssistantMessage({
      ...base,
      msgs,
      pricing: null,
      event: assistantMessage([{ type: "text", text: "x" }], { completionTokens: 100, evalDurationMs: 2000 }),
    });
    expect(r.meta.tps).toBe(50); // 100 tokens / 2s
  });

  it("estimates cost from pricing when the provider reports no cost", () => {
    const msgs: Msg[] = [{ role: "assistant", content: "" }];
    const r = finalizeAssistantMessage({
      ...base,
      msgs,
      pricing: { inputPerMillion: 3, outputPerMillion: 15 },
      event: assistantMessage([{ type: "text", text: "x" }], { promptTokens: 1_000_000, completionTokens: 1_000_000 }),
    });
    expect(r.meta.costUsd).toBeCloseTo(18); // 1M*3 + 1M*15 per million
  });

  it("leaves cost undefined for local/subscription turns", () => {
    const msgs: Msg[] = [{ role: "assistant", content: "" }];
    const r = finalizeAssistantMessage({ ...base, msgs, pricing: null, event: assistantMessage([{ type: "text", text: "x" }]) });
    expect(r.meta.costUsd).toBeUndefined();
  });

  it("hoists tool_call blocks into the assistant message", () => {
    const msgs: Msg[] = [{ role: "assistant", content: "" }];
    const r = finalizeAssistantMessage({
      ...base,
      msgs,
      pricing: null,
      event: assistantMessage([
        { type: "text", text: "calling" },
        { type: "tool_call", toolCallId: "c1", name: "read_file", input: { path: "a.ts" } },
      ]),
    });
    const a = r.msgs[r.index] as { toolCalls?: { id: string; name: string }[] };
    expect(a.toolCalls).toHaveLength(1);
    expect(a.toolCalls?.[0]).toMatchObject({ id: "c1", name: "read_file" });
  });
});
