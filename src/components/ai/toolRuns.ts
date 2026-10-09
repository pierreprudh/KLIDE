// Consecutive tool work, folded into one row you can open.
//
// A delegate CLI writes one message per tool call, so a stretch of work that
// reads as a single step — "look around, then answer" — arrives as fifteen
// separate messages. Rendered one per line they push the actual conversation
// off the screen: the answer is what the reader came for, and it sits under a
// column of `Bash` rows that are only interesting when something went wrong.
//
// So a run of them collapses to a single line, and opening it gives back
// exactly the rows that were there before. The rule for what belongs to a run
// is deliberately narrow: a message counts only if it carries tool work and
// *no prose*. The moment the agent says something, the run ends — a sentence
// between two tool calls is the agent explaining itself, and burying it would
// cost more than the tidiness is worth.
//
// The thinking between those calls folds *with* them. Each thought in a run
// is a half-second decision about which tool to call next, and hoisted out
// of the fold the five of them stack into what reads as one long deliberation
// with nothing happening in between. So the row sums them — "Thought for
// 6.3s · 11 tool calls" — and opening it gives the think → call → think order
// back exactly as it happened.

import type { Msg } from "./types";
import { splitThinking, stripPlanJson } from "../markdown";
import { formatElapsed } from "./WorkingRow";

/** One stretch of uninterrupted tool work. `end` is exclusive. */
export type ToolRun = {
  start: number;
  end: number;
  /** How many tool calls it made — not how many messages it took. */
  calls: number;
  /** Distinct tool names, in the order they first appear. */
  names: string[];
  /** How long the model reasoned across the run, summed from each turn's
   *  measured span. Absent when no turn measured anything. */
  thinkingMs?: number;
};

/** Below this a run is left alone: two rows are not a wall, and hiding them
 *  behind a summary costs a click to learn less than the rows already said. */
export const MIN_STACKED_CALLS = 3;

/** Whether a message is tool work and nothing else. An assistant turn that
 *  also speaks is prose with tool rows attached, not part of a run. */
function isToolWork(m: Msg): boolean {
  if (m.role === "tool") return true;
  if (m.role !== "assistant" || !m.toolCalls?.length) return false;

  // Reasoning-only payloads are still tool work. Providers encode them three
  // ways: a structured `thinking` field (already absent from `content`), an
  // inline <think> block, or the conservative plan-JSON fallback. Classify on
  // what would remain visible to the reader so those formats share the same
  // folding and hoisting path without burying actual prose.
  const { content: withoutInlineThinking } = splitThinking(m.content);
  const { content: visibleContent } = stripPlanJson(withoutInlineThinking);
  return visibleContent.trim() === "";
}

/** The key a call is filed under: its id, or its position when the provider
 *  gave it none (older transcripts, some local models). */
export function toolCallKey(call: { id?: string }, index: number): string {
  return call.id ?? `#${index}`;
}

/** Which result row answers which call.
 *
 * A call and its result arrive as two messages, and drawn in arrival order
 * the results pile up under whatever call came last — so a `read_file` result
 * would sit beneath the `peek_value` beside it and read as its answer. This
 * pairs them so a call row can draw its own result underneath, and the loop
 * can skip the result's standalone row. */
export type ToolResultPairing = {
  /** assistant index → call key (see `toolCallKey`) → index of its result row. */
  byCall: Map<number, Map<string, number>>;
  /** Result rows that belong to a call above them; the loop draws nothing for
   *  these, the call draws them. */
  claimed: Map<number, number>;
};

export function pairToolResults(msgs: Msg[]): ToolResultPairing {
  const byCall = new Map<number, Map<string, number>>();
  const claimed = new Map<number, number>();
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== "assistant" || !m.toolCalls?.length) continue;
    const open = m.toolCalls.map((call, index) => ({ call, key: toolCallKey(call, index), taken: false }));
    const mine = new Map<string, number>();
    // Results follow their calls directly; the first message that is not a
    // result ends this turn's stretch, whatever it is.
    for (let j = i + 1; j < msgs.length; j++) {
      const r = msgs[j];
      if (r.role !== "tool") break;
      const id = r.toolCallId ?? r.tool_call_id;
      // By id when both sides have one; otherwise the first unanswered call
      // with this name — the order results arrive in is the order they were
      // dispatched for the providers that never sent ids.
      const slot = id
        ? open.find((o) => !o.taken && o.call.id === id)
        : open.find((o) => !o.taken && o.call.name === r.toolName);
      if (!slot) continue;
      slot.taken = true;
      mine.set(slot.key, j);
      claimed.set(j, i);
    }
    if (mine.size) byCall.set(i, mine);
  }
  return { byCall, claimed };
}

function callsIn(m: Msg): number {
  return m.role === "assistant" ? m.toolCalls?.length ?? 0 : 0;
}

function namesIn(m: Msg): string[] {
  if (m.role === "assistant") return (m.toolCalls ?? []).map((t) => t.name);
  return m.role === "tool" && m.toolName ? [m.toolName] : [];
}

/**
 * The stackable runs in a conversation, in order. Runs shorter than
 * `MIN_STACKED_CALLS` are not returned at all — the caller renders those
 * messages exactly as it always did.
 */
export function groupToolRuns(msgs: Msg[], pairing: ToolResultPairing = pairToolResults(msgs)): ToolRun[] {
  const runs: ToolRun[] = [];
  let start = -1;
  const flush = (end: number) => {
    if (start < 0) return;
    let calls = 0;
    let thinkingMs: number | undefined;
    const names: string[] = [];
    for (let i = start; i < end; i++) {
      const m = msgs[i];
      calls += callsIn(m);
      if (m.role === "assistant" && m.thinkingMs !== undefined) thinkingMs = (thinkingMs ?? 0) + m.thinkingMs;
      for (const name of namesIn(m)) {
        if (!names.includes(name)) names.push(name);
      }
    }
    // A run of results with no calls in view (the calls were compacted away)
    // is still a run — count the rows so the summary is never "0 tool calls".
    if (calls === 0) calls = end - start;
    if (calls >= MIN_STACKED_CALLS) runs.push({ start, end, calls, names, thinkingMs });
    start = -1;
  };
  for (let i = 0; i < msgs.length; i++) {
    // A result belongs with its call: the answer to a call a sentence made is
    // part of that sentence's turn, not the start of a new stretch of work —
    // folding it would repeat the names already drawn above the fold.
    const owner = pairing.claimed.get(i);
    const work = owner !== undefined ? isToolWork(msgs[owner]) : isToolWork(msgs[i]);
    if (work) {
      if (start < 0) start = i;
      continue;
    }
    flush(i);
  }
  flush(msgs.length);
  return runs;
}


/** What the collapsed row says. Three names is enough to tell one run from
 *  another; past that the count is the information. `thought` is the
 *  reasoning the fold put away, in the words a single turn's header uses. */
export function toolRunLabel(run: ToolRun): { thought?: string; count: string; names: string } {
  const shown = run.names.slice(0, 3);
  const rest = run.names.length - shown.length;
  return {
    thought: run.thinkingMs ? `Thought for ${formatElapsed(run.thinkingMs)}` : undefined,
    count: `${run.calls} tool call${run.calls === 1 ? "" : "s"}`,
    names: rest > 0 ? `${shown.join(", ")} +${rest}` : shown.join(", "),
  };
}
