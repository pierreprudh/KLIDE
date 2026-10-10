// Consecutive tool work, folded into one row you can open.
//
// A delegate CLI writes one message per tool call, so a stretch of work that
// reads as a single step — "look around, then answer" — arrives as fifteen
// separate messages. Rendered one per line they push the actual conversation
// off the screen: the answer is what the reader came for, and it sits under a
// column of `Bash` rows that are only interesting when something went wrong.
//
// So everything on the way to the answer collapses to a single line —
// "Worked for 19s" — and opening it gives back exactly the rows that were
// there before. A run is the whole stretch of work: every call, its result,
// the thinking between, and the narration a call came with ("Let me check
// the workspace…"). It ends at the message that *is* the answer — prose with
// no call behind it, or a call that draws a card for the operator — and
// that answer's own reasoning folds in too, so what stays in view is one
// line and what the reader came for.
//
// The thinking between the calls folds *with* them. Each thought in a run is
// a half-second decision about which tool to call next, and hoisted out of
// the fold the five of them stack into what reads as one long deliberation
// with nothing happening in between. Opening the row gives the think → call
// → think order back exactly as it happened.

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
  /** Wall time across the run — each turn's span since the boundary before
   *  it, tool execution included. */
  workedMs?: number;
  /** The message the run led to, when its own reasoning folds in with the
   *  run: the answer's thought is the last step of the work, not a second
   *  row over the prose. Its span is already in `thinkingMs`. */
  answer?: number;
};

/** Below this a turn's *own* rows are left in place under its sentence
 *  (`InlineToolRun`): two rows are not a wall. The conversation-level fold
 *  (`groupToolRuns`) has no floor — one call on the way to the answer is
 *  still on the way. */
export const MIN_STACKED_CALLS = 3;

/** Mirrors `PLAN_MISSION_TOOL` in src-tauri/src/agent/tools.rs. */
export const PLAN_MISSION_TOOL = "plan_mission";

/** Tool calls that are the agent addressing the operator, not machinery: a
 *  planned Mission is drawn as a card the operator approves on, a delegation
 *  is a row the operator watches. Folding either into "5 tool calls" hides
 *  the one thing the turn was for, so a message that makes one of these
 *  calls ends a run the way a sentence does. */
export const SPEAKING_TOOLS: ReadonlySet<string> = new Set([PLAN_MISSION_TOOL, "spawn_subagent"]);

/** What a turn would show the reader: its content with every reasoning
 *  encoding taken out — the structured `thinking` field is already absent,
 *  an inline <think> block and the plan-JSON fallback are not. */
function visibleProse(m: Extract<Msg, { role: "assistant" }>): string {
  const { content: withoutInlineThinking } = splitThinking(m.content);
  const { content } = stripPlanJson(withoutInlineThinking);
  return content.trim();
}

function hasThinking(m: Msg): boolean {
  if (m.role !== "assistant") return false;
  if (m.thinking) return true;
  const { thinking: inline, content } = splitThinking(m.content);
  return !!inline || !!stripPlanJson(content).thinking;
}

/** Whether a message is on the way to the answer rather than the answer. A
 *  tool result is; so is any turn that makes a call — its sentence, if it
 *  has one, is narration ("Reading it now."), not the reply — and so is a
 *  turn that has said nothing visible yet (reasoning only, or the empty
 *  placeholder a streaming turn starts as). The answer is prose with no
 *  call behind it, or a call that draws a card: a planned Mission, a
 *  delegation — the agent addressing the operator (see `SPEAKING_TOOLS`). */
function isToolWork(m: Msg): boolean {
  if (m.role === "tool") return true;
  if (m.role !== "assistant") return false;
  if (m.toolCalls?.some((call) => SPEAKING_TOOLS.has(call.name))) return false;
  if (m.toolCalls?.length) return true;
  return visibleProse(m) === "";
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
 * The foldable runs in a conversation, in order. A stretch that made no call
 * and holds no result — a lone thought before an answer — is not a run; the
 * thought draws its own line.
 */
export function groupToolRuns(msgs: Msg[], pairing: ToolResultPairing = pairToolResults(msgs)): ToolRun[] {
  const runs: ToolRun[] = [];
  let start = -1;
  const flush = (end: number) => {
    if (start < 0) return;
    let calls = 0;
    let results = 0;
    let thinkingMs: number | undefined;
    let workedMs: number | undefined;
    const names: string[] = [];
    for (let i = start; i < end; i++) {
      const m = msgs[i];
      calls += callsIn(m);
      if (m.role === "tool") results++;
      if (m.role === "assistant") {
        if (m.thinkingMs !== undefined) thinkingMs = (thinkingMs ?? 0) + m.thinkingMs;
        if (m.meta?.ms !== undefined) workedMs = (workedMs ?? 0) + m.meta.ms;
      }
      for (const name of namesIn(m)) {
        if (!names.includes(name)) names.push(name);
      }
    }
    // A run of results with no calls in view (the calls were compacted away)
    // is still a run — count the rows so the summary is never "0 tool calls".
    if (calls === 0 && results > 0) calls = end - start;
    if (calls === 0) {
      start = -1;
      return;
    }
    // The answer's own reasoning is the last step of the work it closes.
    let answer: number | undefined;
    const next = msgs[end];
    if (next?.role === "assistant" && hasThinking(next)) {
      answer = end;
      if (next.thinkingMs !== undefined) thinkingMs = (thinkingMs ?? 0) + next.thinkingMs;
    }
    runs.push({ start, end, calls, names, thinkingMs, workedMs, answer });
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


/** What the one line says. `label` is the wall time the work took — "Worked
 *  for 19.4s", the honest span when tools ran — or the reasoning span when
 *  only that was measured, or the count when nothing was timed at all. The
 *  count and `names` (every distinct tool) are for the hover: printed on the
 *  row they made the line a sentence nobody read, but a pointer resting on
 *  it is a question. */
export function toolRunLabel(run: Pick<ToolRun, "calls" | "names" | "thinkingMs" | "workedMs">): { label: string; count: string; names: string } {
  const count = `${run.calls} tool call${run.calls === 1 ? "" : "s"}`;
  return {
    label: run.workedMs
      ? `Worked for ${formatElapsed(run.workedMs)}`
      : run.thinkingMs
        ? `Thought for ${formatElapsed(run.thinkingMs)}`
        : count,
    count,
    names: run.names.join(", "),
  };
}
