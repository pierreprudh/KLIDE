// One walk over `AgentEvent[]` produces a normalized conversation. The AI
// panel and Mission Control both consume this — each has its own row shape
// (Msg vs RunMessage), so the fold owns the pairing logic (user↔assistant,
// tool-call lifecycle by toolCallId) and the mappers do the trivial shape
// conversion. The wire format lives once, in here.

import type {
  AgentAttachment,
  AgentContentBlock,
  AgentEvent,
  AgentUsage,
} from "./types";
import type { Msg } from "../components/ai/types";
import type { RunMessage, RunToolCall } from "../runs";

export type FoldedToolCall = {
  id: string;
  name: string;
  input: unknown;
  summary?: string;
  result?: { content: string; ok: boolean };
  status: "started" | "finished" | "unknown";
};

export type AssistantMeta = {
  /** Wall-clock duration from the previous turn boundary (user or tool). */
  ms?: number;
  /** Completion tokens — exact from `AgentUsage` when present, else a
   *  length-based estimate. The mapper decides whether to expose this. */
  tokens?: number;
  tokensEstimate?: number;
  /** Decode speed in tok/s — only set when `AgentUsage.evalDurationMs` is. */
  tps?: number;
  /** True iff `tokens` came from the provider, not the estimate. */
  exact?: boolean;
  /** Per-turn cost in USD, carried from `AgentUsage.costUsd`. Absent for
   *  local / subscription / unknown-price turns. */
  costUsd?: number;
};

export type FoldedRow =
  | {
      kind: "user";
      text: string;
      attachments?: AgentAttachment[];
    }
  | {
      kind: "assistant";
      text: string;
      thinking?: string;
      toolCalls: FoldedToolCall[];
      meta?: AssistantMeta;
    }
  | {
      kind: "steering";
      reason: string;
    };

type AssistantRow = Extract<FoldedRow, { kind: "assistant" }>;

export function foldAgentEvents(events: AgentEvent[]): FoldedRow[] {
  const rows: FoldedRow[] = [];
  let turnStartTs: number | undefined;

  const lastAssistant = (): AssistantRow | null => {
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (row.kind === "assistant") return row;
    }
    return null;
  };

  // Walk every assistant row, most-recent first. A tool call can be attached
  // to a non-final assistant (e.g. streamed tool calls interleaved with
  // follow-up text), so we don't just look at the last row.
  const findTool = (toolCallId: string): FoldedToolCall | null => {
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (row.kind !== "assistant") continue;
      const found = row.toolCalls.find((t) => t.id === toolCallId);
      if (found) return found;
    }
    return null;
  };

  const ensureAssistant = (): AssistantRow => {
    const last = lastAssistant();
    if (last) return last;
    const created: AssistantRow = {
      kind: "assistant",
      text: "",
      toolCalls: [],
    };
    rows.push(created);
    return created;
  };

  const upsertTool = (
    toolCallId: string,
    patch: (t: FoldedToolCall) => void,
  ): FoldedToolCall => {
    const existing = findTool(toolCallId);
    if (existing) {
      patch(existing);
      return existing;
    }
    const assistant = ensureAssistant();
    const created: FoldedToolCall = {
      id: toolCallId,
      name: "tool",
      input: undefined,
      status: "unknown",
    };
    assistant.toolCalls.push(created);
    patch(created);
    return created;
  };

  for (const event of events) {
    if (event.type === "user_message") {
      turnStartTs = event.ts;
      rows.push({
        kind: "user",
        text: event.text,
        attachments: event.attachments?.length ? event.attachments : undefined,
      });
      continue;
    }

    if (event.type === "assistant_message") {
      const textBlocks = event.content.filter(isTextBlock);
      const text = textBlocks.map((b) => b.text).join("");
      const thinking = event.content.find(isThinkingBlock)?.text;
      const toolBlocks = event.content.filter(isToolCallBlock);

      const ms =
        turnStartTs !== undefined && event.ts >= turnStartTs
          ? event.ts - turnStartTs
          : undefined;
      turnStartTs = event.ts;
      const usage = event.usage;
      const meta = computeMeta(text, thinking, ms, usage);

      rows.push({
        kind: "assistant",
        text,
        thinking,
        toolCalls: toolBlocks.map((b) => ({
          id: b.toolCallId,
          name: b.name,
          input: b.input,
          status: "unknown" as const,
        })),
        meta: meta ?? undefined,
      });
      continue;
    }

    if (event.type === "tool_call_started") {
      upsertTool(event.toolCallId, (t) => {
        t.name = event.name;
        t.input = event.input;
        t.summary = event.summary;
        t.status = "started";
      });
      continue;
    }

    if (event.type === "tool_call_finished") {
      upsertTool(event.toolCallId, (t) => {
        t.result = { content: event.result.content, ok: event.result.ok };
        t.status = "finished";
      });
      continue;
    }

    if (event.type === "steering_injected") {
      rows.push({ kind: "steering", reason: event.reason });
      continue;
    }
  }

  return rows;
}

function computeMeta(
  text: string,
  thinking: string | undefined,
  ms: number | undefined,
  usage: AgentUsage | undefined,
): AssistantMeta | null {
  const hasUsage = usage?.completionTokens !== undefined;
  const estimated = Math.round((text.length + (thinking?.length ?? 0)) / 4);
  const tokens = hasUsage ? usage!.completionTokens! : estimated;
  const tps =
    hasUsage &&
    usage?.evalDurationMs !== undefined &&
    usage.evalDurationMs > 0
      ? Math.round(usage.completionTokens! / (usage.evalDurationMs / 1000))
      : undefined;
  if (ms === undefined && !tokens && tps === undefined) return null;
  return {
    ms,
    tokens: tokens || undefined,
    tokensEstimate: hasUsage ? undefined : estimated || undefined,
    tps,
    exact: hasUsage,
    costUsd: usage?.costUsd,
  };
}

function isTextBlock(
  b: AgentContentBlock,
): b is { type: "text"; text: string } {
  return b.type === "text";
}
function isThinkingBlock(
  b: AgentContentBlock,
): b is { type: "thinking"; text: string } {
  return b.type === "thinking";
}
function isToolCallBlock(
  b: AgentContentBlock,
): b is {
  type: "tool_call";
  toolCallId: string;
  name: string;
  input: unknown;
} {
  return b.type === "tool_call";
}

// ── Mappers ──────────────────────────────────────────────────────────────
// Each consumer picks the field it cares about. The AI panel keeps separate
// `role: "tool"` rows for tool results (so the renderer can show the call
// info and the result on distinct rows). Mission Control folds tool calls
// into the assistant's `tools` field with full lifecycle.

export function foldedToMsgs(rows: FoldedRow[]): Msg[] {
  const msgs: Msg[] = [];
  for (const row of rows) {
    if (row.kind === "user") {
      msgs.push({
        role: "user",
        content: row.text,
        attachments: row.attachments,
      });
      continue;
    }
    if (row.kind === "steering") {
      msgs.push({
        role: "system",
        content: row.reason,
        steering: { reason: row.reason },
      });
      continue;
    }
    msgs.push({
      role: "assistant",
      content: row.text,
      thinking: row.thinking,
      toolCalls: row.toolCalls.length
        ? row.toolCalls.map((t) => ({
            id: t.id,
            name: t.name,
            args: serializeArgs(t.input),
          }))
        : undefined,
      meta: row.meta
        ? {
            ms: row.meta.ms,
            tokens: row.meta.tokens,
            tps: row.meta.tps,
            exact: row.meta.exact,
            costUsd: row.meta.costUsd,
          }
        : undefined,
    });
    for (const t of row.toolCalls) {
      if (!t.result) continue;
      msgs.push({
        role: "tool",
        content: t.result.content,
        toolName: t.name,
        toolCallId: t.id,
      });
    }
  }
  return msgs;
}

export function foldedToRunMessages(rows: FoldedRow[]): RunMessage[] {
  const out: RunMessage[] = [];
  for (const row of rows) {
    if (row.kind === "user") {
      out.push({ role: "user", text: row.text });
      continue;
    }
    // Mission Control's RunMessage has no system role; steering markers are an
    // AI-panel transcript annotation, so they're dropped from the run board.
    if (row.kind === "steering") continue;
    if (!row.text.trim() && row.toolCalls.length === 0) continue;
    out.push({
      role: "assistant",
      text: row.text,
      tools: row.toolCalls.length
        ? row.toolCalls.map(toRunToolCall)
        : undefined,
    });
  }
  return out;
}

function toRunToolCall(t: FoldedToolCall): RunToolCall {
  return {
    id: t.id,
    name: t.name,
    input: t.input,
    summary: t.summary,
    result: t.result?.content,
    ok: t.result?.ok,
    status: t.status,
  };
}

function serializeArgs(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}
