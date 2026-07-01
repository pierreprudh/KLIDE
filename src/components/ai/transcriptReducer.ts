// Pure transcript-shaping core for the AI panel's live run.
//
// The AiPanel streams a run's `AgentEvent`s into a `Msg[]` (the Conversation).
// Historically that transform lived in a ~270-line closure inside the component,
// reachable only by mounting the panel and feeding a real event stream — so the
// subtle, bug-prone parts (the tool-card walk-past, delta application, and the
// token / TTFT / cost math) had no test surface.
//
// These functions are that logic, lifted out as pure operations over plain
// values: `(msgs, …) → { msgs, … }`. The component keeps the effectful shell
// (setState, the delta flush timer, IPC); this module owns the shaping and is
// unit-tested directly in transcriptReducer.test.ts.

import type { AgentEvent } from "../../agent/types";
import type { AgentToolCall as ToolCall } from "../../agent/tools";
import { estimateTokens } from "./utils";
import type { Msg } from "./types";

/** Delegate-console tagging carried on every assistant/tool row of a turn. */
export type TranscriptDelegate = { delegateConsole?: boolean; delegateProvider?: string };

export type Pricing = { inputPerMillion: number; outputPerMillion: number } | null;

/** Per-message footer metrics (matches the `meta` field on an assistant Msg). */
export type AssistantMeta = {
  ms?: number;
  tokens?: number;
  promptTokens?: number;
  ttftMs?: number;
  tps?: number;
  exact?: boolean;
  costUsd?: number;
};

/** Timing captured across a single provider turn, owned by the component. */
export type TurnTiming = { turnStartedAt: number; firstTokenAt: number | null };

/**
 * Ensure an assistant bubble exists at/after `nextAssistantIdx` and return its
 * index. After a `tool_call_started` splice, `nextAssistantIdx` points at a tool
 * card; the old guard (`role !== "assistant" → drop`) silently discarded every
 * assistant update from that point on, so multi-turn tool runs never showed
 * their final answer. Walk past tool cards; insert a fresh bubble for the new
 * turn when the slot isn't already an assistant row.
 *
 * Pure: returns a new array (cloned only when it inserts).
 */
export function locateAssistant(
  msgs: Msg[],
  nextAssistantIdx: number,
  delegate: TranscriptDelegate
): { msgs: Msg[]; index: number } {
  let i = nextAssistantIdx;
  while (msgs[i]?.role === "tool") i += 1;
  if (msgs[i]?.role === "assistant") {
    return { msgs, index: i };
  }
  const next = [...msgs];
  next.splice(i, 0, { role: "assistant", content: "", ...delegate });
  return { msgs: next, index: i };
}

/**
 * Apply a throttled delta (accumulated content + thinking) to the current
 * assistant bubble, creating one if needed. Returns the new array and the
 * resolved assistant index (which the component stores back as nextAssistantIdx).
 */
export function appendDelta(
  msgs: Msg[],
  nextAssistantIdx: number,
  content: string,
  thinking: string,
  delegate: TranscriptDelegate
): { msgs: Msg[]; index: number } {
  const located = locateAssistant(msgs, nextAssistantIdx, delegate);
  const next = [...located.msgs];
  const existing = next[located.index] as Msg & { role: "assistant" };
  const newContent = (existing.content || "") + content;
  const newThinking = [existing.thinking, thinking].filter(Boolean).join("") || undefined;
  next[located.index] = { ...existing, content: newContent, thinking: newThinking, ...delegate };
  return { msgs: next, index: located.index };
}

/**
 * Insert a "Running <name>…" tool row after the current assistant bubble.
 * Returns the new array and the advanced nextAssistantIdx.
 */
export function startToolCall(
  msgs: Msg[],
  nextAssistantIdx: number,
  name: string,
  toolCallId: string
): { msgs: Msg[]; index: number } {
  const next = [...msgs];
  next.splice(nextAssistantIdx + 1, 0, {
    role: "tool",
    content: `Running ${name}...`,
    toolName: name,
    toolCallId,
    tool_call_id: toolCallId,
  });
  return { msgs: next, index: nextAssistantIdx + 1 };
}

/**
 * Replace a tool row's "Running…" placeholder with its result. Matches by id
 * over the whole list — ids are unique per run, and searching from
 * nextAssistantIdx+1 used to skip the very row the result belongs to.
 */
export function finishToolCall(msgs: Msg[], toolCallId: string, resultContent: string): Msg[] {
  const next = [...msgs];
  for (let i = 0; i < next.length; i++) {
    const msg = next[i];
    if (msg.role === "tool" && (msg.toolCallId === toolCallId || msg.tool_call_id === toolCallId)) {
      next[i] = {
        role: "tool",
        content: resultContent,
        toolName: msg.toolName,
        toolCallId,
        tool_call_id: toolCallId,
      };
      break;
    }
  }
  return next;
}

type AssistantMessageEvent = Extract<AgentEvent, { type: "assistant_message" }>;

/**
 * Fold a finalized `assistant_message` into the transcript: build the assistant
 * Msg with real content, thinking, tool calls, and the per-message meta footer
 * (duration, tokens, TTFT, tok/s, cost). Prefers the provider's own usage block
 * over length estimates; leaves cost undefined for local / subscription turns.
 *
 * Pure: all timing is passed in (`timing`, `now`) so tests are deterministic.
 * `measuredPromptTokens` / `measuredUsage` are surfaced for the component to
 * push into the context gauge state when the provider reported prompt tokens.
 */
export function finalizeAssistantMessage(input: {
  msgs: Msg[];
  nextAssistantIdx: number;
  event: AssistantMessageEvent;
  timing: TurnTiming;
  now: number;
  pricing: Pricing;
  delegate: TranscriptDelegate;
}): {
  msgs: Msg[];
  index: number;
  meta: AssistantMeta;
  measuredPromptTokens?: number;
  measuredUsage?: { prompt: number; completion: number };
} {
  const { event, timing, now, pricing, delegate } = input;
  const text = event.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const thinking = event.content
    .filter((b) => b.type === "thinking")
    .map((b) => b.text)
    .join("")
    .trim();
  const tcBlocks = event.content.filter((b) => b.type === "tool_call");
  const tcCalls: ToolCall[] = tcBlocks.map((b) => ({
    id: ("toolCallId" in b ? b.toolCallId : "") as string,
    name: "name" in b ? (b.name as string) : "",
    args: "input" in b ? b.input : {},
  }));

  const turnMs = now - timing.turnStartedAt;
  const ttftMs = timing.firstTokenAt !== null ? timing.firstTokenAt - timing.turnStartedAt : undefined;

  const located = locateAssistant(input.msgs, input.nextAssistantIdx, delegate);
  const next = [...located.msgs];
  const existing = next[located.index] as Msg & { role: "assistant" };
  // Empty text with streamed deltas → keep the streamed content.
  const msgContent = text || existing.content || "";
  const estimatedTokens = estimateTokens(msgContent) + estimateTokens(thinking);

  // Prefer the provider's real counts when present — Ollama reports eval_count,
  // OpenAI/Anthropic send a usage block. The estimate is the fallback.
  const usage = event.usage;
  const tokens = usage?.completionTokens !== undefined ? usage.completionTokens : estimatedTokens;

  let measuredPromptTokens: number | undefined;
  let measuredUsage: { prompt: number; completion: number } | undefined;
  if (usage?.promptTokens !== undefined) {
    const completion = usage.completionTokens ?? tokens;
    measuredPromptTokens = usage.promptTokens + completion;
    measuredUsage = { prompt: usage.promptTokens, completion };
  }

  // tok/s over decode time (turn minus TTFT). Prefer the provider's own
  // eval_duration when available: it's pure decode time, wall-clock can be
  // dragged out by tool calls and rendering.
  const decodeMs = ttftMs !== undefined ? turnMs - ttftMs : turnMs;
  let tps: number | undefined;
  if (
    usage?.completionTokens !== undefined &&
    usage?.evalDurationMs !== undefined &&
    usage.evalDurationMs > 0
  ) {
    tps = Math.round(usage.completionTokens / (usage.evalDurationMs / 1000));
  } else if (tokens > 0 && decodeMs > 100) {
    tps = Math.round(tokens / (decodeMs / 1000));
  }
  const exact = usage?.completionTokens !== undefined;

  // Per-message cost. The provider's own figure wins when present (OpenRouter
  // reports the real charged amount); otherwise fall back to token counts ×
  // list price. Local / subscription turns leave costUsd undefined.
  const costUsd =
    usage?.costUsd !== undefined
      ? usage.costUsd
      : pricing && usage?.promptTokens !== undefined && usage?.completionTokens !== undefined
        ? (usage.promptTokens * pricing.inputPerMillion +
            usage.completionTokens * pricing.outputPerMillion) /
          1_000_000
        : undefined;

  const meta: AssistantMeta = { ms: turnMs, tokens, promptTokens: usage?.promptTokens, ttftMs, tps, exact, costUsd };
  next[located.index] = {
    role: "assistant",
    content: msgContent,
    thinking: thinking || undefined,
    toolCalls: tcCalls.length ? tcCalls : undefined,
    ...delegate,
    meta,
  };
  return { msgs: next, index: located.index, meta, measuredPromptTokens, measuredUsage };
}
