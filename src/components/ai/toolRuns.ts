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
import { dropEmptyFences, splitThinking, stripPlanJson } from "../markdown";
import { formatElapsed } from "./WorkingRow";
import { delegateLabel } from "../../delegates";

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
  /** The Delegate that ran these calls itself, when it did — the line names
   *  it ("Hermes worked for 30.1s"), since Klide gated none of them. */
  observedBy?: string;
};

/** Below this a turn's *own* rows are left in place under its sentence
 *  (`InlineToolRun`): two rows are not a wall. The conversation-level fold
 *  (`groupToolRuns`) has no floor — one call on the way to the answer is
 *  still on the way. */
export const MIN_STACKED_CALLS = 3;

/** Mirrors `PLAN_MISSION_TOOL` in src-tauri/src/agent/tools.rs. */
export const PLAN_MISSION_TOOL = "plan_mission";

/** The Pause tool a run asks the operator one question through — the name
 *  src-tauri/src/agent/tools.rs registers it under. */
export const USER_QUESTION_TOOL = "userAnswerQuestion";

/** Tool calls that are the agent addressing the operator, not machinery: a
 *  planned Mission is drawn as a card the operator approves on, a delegation
 *  is a row the operator watches, a question and its answer are an exchange
 *  the conversation keeps. Folding any of them into "5 tool calls" hides
 *  the one thing the turn was for, so a message that makes one of these
 *  calls ends a run the way a sentence does. */
export const SPEAKING_TOOLS: ReadonlySet<string> = new Set([PLAN_MISSION_TOOL, "spawn_subagent", USER_QUESTION_TOOL]);

/** A sub-agent a Delegate CLI started itself — Claude Code's `Agent` (`Task`
 *  before it was renamed), OpenCode 2's `subagent`. Starting one is a step of the turn's work like any
 *  call; where it is lives in the tray above the composer (turnSubagents.ts),
 *  so a fan-out never pushes the answer off the screen. */
const OBSERVED_SUBAGENT_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task", "subagent"]);

export function isObservedSubagent(call: { name: string; observedBy?: string }): boolean {
  return !!call.observedBy && OBSERVED_SUBAGENT_TOOLS.has(call.name);
}

/** A call that draws its own card and so speaks for the turn. */
export function isSpeakingCall(call: { name: string }): boolean {
  return SPEAKING_TOOLS.has(call.name);
}

/** What a turn would show the reader: its content with every reasoning
 *  encoding taken out — the structured `thinking` field is already absent,
 *  an inline <think> block and the plan-JSON fallback are not. */
export function visibleProse(m: Extract<Msg, { role: "assistant" }>): string {
  const { content: withoutInlineThinking } = splitThinking(m.content);
  const { content } = stripPlanJson(withoutInlineThinking);
  return dropEmptyFences(content).trim();
}

/** Everything a turn thought, however it arrived — the structured field, an
 *  inline <think> leak, or the plan-JSON fallback. */
function thoughtText(m: Extract<Msg, { role: "assistant" }>): string {
  if (m.thinking) return m.thinking;
  const { thinking: inline, content } = splitThinking(m.content);
  return inline || stripPlanJson(content).thinking || "";
}

/** Filler a thought opens with before it says anything. */
const THOUGHT_FILLER = /^(ok(ay)?|hmm+|wait|so|alright|right|let me think|thinking)[\s.,!…:-]*$/i;

/** A sentence that only restates the request — small reasoning models open
 *  every thought with one ("The user wants me to read each file…"), so as a
 *  gist it repeats on every step and says nothing about this one. */
const RESTATES_REQUEST = /^(the\s+)?user\s+(wants|wanted|asks|asked|is asking|has asked|requests|requested|would like|needs)\b/i;

/** The sentence a reasoning model would have written before its call, lifted
 *  from what it thought instead: the first paragraph that says something,
 *  two sentences at most, markdown furniture off, cut at a word past 240
 *  characters. The first paragraph rather than the last because it is where
 *  the model reads the last result and decides ("The README is Klide's own
 *  — let me look under artifacts/"); the last is usually "Let me run it." */
export function thoughtGist(thinking: string): string {
  const paragraphs = thinking
    .split(/\n\s*\n/)
    .map((p) => p.replace(/^\s*(#{1,6}\s+|[-*•]\s+|\d+[.)]\s+)/gm, "").replace(/\*\*|__/g, "").replace(/\s+/g, " ").trim())
    .filter((p) => p && !THOUGHT_FILLER.test(p));
  // A sentence ends at punctuation followed by space or the end — a dot
  // inside a name (`slugify.js`, `README.md`) is not an end. The gist is
  // the first paragraph with something left once its restatement is off.
  let sentences: string[] = [];
  for (const p of paragraphs) {
    const all = (p.match(/.+?[.!?]+["')\]]*(?=\s|$)|.+$/g) ?? [p]).map((s) => s.trim());
    const from = all.findIndex((s) => !RESTATES_REQUEST.test(s));
    if (from >= 0) { sentences = all.slice(from); break; }
  }
  if (!sentences.length) return "";
  let gist = sentences.slice(0, 2).join(" ").trim();
  if (gist.length > 240) {
    const cut = gist.slice(0, 239);
    gist = cut.slice(0, Math.max(cut.lastIndexOf(" "), 160)).trimEnd() + "…";
  }
  return gist;
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
/** A compaction marker the Run drew. It is a step of the response it sits
 *  in — a line in the fold, like a call — whether it opened the response or
 *  came between two of its calls. A Compact between turns is followed by no
 *  answer, so it folds into nothing and keeps its own line. */
function isCompactionMarker(m: Msg): boolean {
  return m.role === "system" && !!m.compaction;
}

function isToolWork(m: Msg): boolean {
  if (m.role === "tool") return true;
  if (m.role !== "assistant") return false;
  if (m.toolCalls?.some(isSpeakingCall)) return false;
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

function observedIn(msgs: Msg[], start: number, end: number): string | undefined {
  for (let i = start; i < end; i++) {
    const m = msgs[i];
    if (m.role === "tool" && m.observedBy) return m.observedBy;
  }
  return undefined;
}

function namesIn(m: Msg): string[] {
  if (m.role === "assistant") return (m.toolCalls ?? []).map((t) => t.name);
  return m.role === "tool" && m.toolName ? [m.toolName] : [];
}

export type RunFoldOptions = {
  /** The row still streaming, while the run is live. A sentence that is
   *  still arriving has no call behind it *yet*: whether it is narration
   *  before the next call or the answer is not known until its turn
   *  settles. Until then it stays the last step of the work it follows —
   *  otherwise every new sentence ended the run, folded the rows above it
   *  to "Worked for" and drew itself under the line, only for the call that
   *  followed to reopen the run with the sentence back at the bottom. */
  streaming?: number;
};

/**
 * The foldable runs in a conversation, in order. A stretch that made no call
 * and holds no result — a lone thought before an answer — is not a run; the
 * thought draws its own line.
 */
export function groupToolRuns(msgs: Msg[], pairing: ToolResultPairing = pairToolResults(msgs), opts: RunFoldOptions = {}): ToolRun[] {
  const runs: ToolRun[] = [];
  let start = -1;
  const flush = (end: number) => {
    if (start < 0) return;
    let calls = 0;
    let results = 0;
    let compactions = 0;
    let thinkingMs: number | undefined;
    let workedMs: number | undefined;
    const names: string[] = [];
    for (let i = start; i < end; i++) {
      const m = msgs[i];
      calls += callsIn(m);
      if (m.role === "tool") results++;
      if (isCompactionMarker(m)) compactions++;
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
    if (calls === 0 && results > 0) calls = end - start - compactions;
    const next = msgs[end];
    // A response that only compacted before answering is still a fold — the
    // compaction and the answer's thought — but a marker no answer follows (a
    // Compact between turns) is nobody's step and keeps its own line.
    if (calls === 0 && !(compactions > 0 && next?.role === "assistant")) {
      start = -1;
      return;
    }
    if (calls === 0 && workedMs === undefined && next?.role === "assistant" && next.meta?.ms !== undefined) {
      workedMs = next.meta.ms;
    }
    // The answer's own reasoning is the last step of the work it closes.
    let answer: number | undefined;
    if (next?.role === "assistant" && hasThinking(next)) {
      answer = end;
      if (next.thinkingMs !== undefined) thinkingMs = (thinkingMs ?? 0) + next.thinkingMs;
    }
    // A delegate's turn is one CLI turn measured once, on the answer that
    // closes it: its tool rows carry no span of their own. That span is the
    // work — without it the line would fall back to "11 tool calls".
    const observedBy = observedIn(msgs, start, end);
    if (workedMs === undefined && next?.role === "assistant" && next.meta?.ms !== undefined && observedBy) {
      workedMs = next.meta.ms;
    }
    runs.push({ start, end, calls, names, thinkingMs, workedMs, answer, ...(observedBy ? { observedBy } : {}) });
    start = -1;
  };
  for (let i = 0; i < msgs.length; i++) {
    // A result belongs with its call: the answer to a call a sentence made is
    // part of that sentence's turn, not the start of a new stretch of work —
    // folding it would repeat the names already drawn above the fold.
    const owner = pairing.claimed.get(i);
    const work = owner !== undefined
      ? isToolWork(msgs[owner])
      : isToolWork(msgs[i]) || isCompactionMarker(msgs[i]) || stillArriving(msgs[i], i, opts, start);
    if (work) {
      if (start < 0) start = i;
      continue;
    }
    flush(i);
  }
  flush(msgs.length);
  return runs;
}


/** Turns that follow an answered question, whose thought draws no line of its
 *  own. The answered card and the reply to it are one exchange — question,
 *  answer, verdict — and a "Thought process" row between them split it, so
 *  the one fold a turn shows stays the one at its top. The reasoning is still
 *  in the transcript; only its row goes. A turn that makes calls is already
 *  inside a fold and needs nothing from this. */
export function turnsAfterQuestions(msgs: Msg[], pairing: ToolResultPairing = pairToolResults(msgs)): Set<number> {
  const after = new Set<number>();
  for (let i = 1; i < msgs.length; i++) {
    if (msgs[i].role !== "assistant") continue;
    const prev = msgs[i - 1];
    if (prev.role !== "tool") continue;
    const owner = pairing.claimed.get(i - 1);
    const asked = prev.toolName === USER_QUESTION_TOOL
      || (owner !== undefined && msgs[owner].role === "assistant" && !!msgs[owner].toolCalls?.some((c) => c.name === USER_QUESTION_TOOL));
    if (asked) after.add(i);
  }
  return after;
}

export type QuestionVerdict = "right" | "wrong";

/** A reply that grades the answer it follows opens with a mark — ✅ or ❌ —
 *  and the mark belongs on the answered card, beside the answer it judges. */
const VERDICT_MARK = /^\s*(✅|✔️|✔|❌|✖️|✗|✘)\s*/u;

export function verdictOf(content: string): QuestionVerdict | undefined {
  const mark = VERDICT_MARK.exec(content)?.[1];
  if (!mark) return undefined;
  return mark === "✅" || mark.startsWith("✔") ? "right" : "wrong";
}

/** The reply's text with its verdict mark taken off — the card wears it. */
export function dropVerdictMark(content: string): string {
  return content.replace(VERDICT_MARK, "");
}

/** A question's args as an object — live events pass the input object,
 *  transcript replay passes it JSON-stringified. */
export function questionArgs(args: unknown): Record<string, unknown> {
  let v = args;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { return {}; }
  }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** The question's args with its answer key taken out, for anything drawn
 *  while the question is still open — the call's row, its JSON disclosure. */
export function withoutAnswerKey(args: unknown): unknown {
  const o = questionArgs(args);
  if (!("correct" in o)) return args;
  const { correct: _key, ...rest } = o;
  return rest;
}

const PICK_LETTER = /^\s*\(?([A-Da-d1-4])(?:[.):]\s*|\s*$)/;

/** The pick graded against the answer key the question carried (`correct`):
 *  by letter when both name one (`B`, `B.`, `B. The Workspace…`), otherwise
 *  by the answer's text, case and spacing aside. Undefined when the question
 *  had no key or nothing was picked. */
export function gradeAnswer(said: string, correct: unknown): QuestionVerdict | undefined {
  if (typeof correct !== "string" || !correct.trim() || !said.trim()) return undefined;
  const a = PICK_LETTER.exec(said)?.[1]?.toUpperCase();
  const b = PICK_LETTER.exec(correct)?.[1]?.toUpperCase();
  if (a && b) return a === b ? "right" : "wrong";
  const text = (s: string) => s.replace(PICK_LETTER, "").replace(/\s+/g, " ").trim().toLowerCase();
  return text(said) === text(correct) ? "right" : "wrong";
}

/** Which question each graded reply judged: question turn index → verdict,
 *  and the reply turns whose leading mark moves onto that card. */
export function questionVerdicts(msgs: Msg[], pairing: ToolResultPairing = pairToolResults(msgs)): { byQuestion: Map<number, QuestionVerdict>; replies: Set<number> } {
  const byQuestion = new Map<number, QuestionVerdict>();
  const replies = new Set<number>();
  for (const i of turnsAfterQuestions(msgs, pairing)) {
    const owner = pairing.claimed.get(i - 1);
    const reply = msgs[i];
    if (owner === undefined || reply.role !== "assistant") continue;
    const verdict = verdictOf(visibleProse(reply));
    if (!verdict) continue;
    byQuestion.set(owner, verdict);
    replies.add(i);
  }
  return { byQuestion, replies };
}

/** A prose row still streaming at the end of a run in progress (see
 *  `RunFoldOptions.streaming`). A row that already carries a call is work
 *  or a card on its own terms; a row that follows no run is simply the
 *  answer arriving, as before. */
function stillArriving(m: Msg, index: number, opts: RunFoldOptions, runStart: number): boolean {
  return index === opts.streaming && runStart >= 0 && m.role === "assistant" && !m.toolCalls?.length;
}

/** What the one line says. `label` is the wall time the work took — "Worked
 *  for 19.4s", the honest span when tools ran — or the reasoning span when
 *  only that was measured, or the count when nothing was timed at all. The
 *  count and `names` (every distinct tool) are for the hover: printed on the
 *  row they made the line a sentence nobody read, but a pointer resting on
 *  it is a question. */
export function toolRunLabel(run: Pick<ToolRun, "calls" | "names" | "thinkingMs" | "workedMs" | "observedBy">): { label: string; count: string; names: string } {
  const count = run.calls === 0 ? "context compacted" : `${run.calls} tool call${run.calls === 1 ? "" : "s"}`;
  // A Delegate's work says whose it was: "Hermes worked for" beside Kit's
  // plain "Worked for", so the reader sees which runs Klide gated.
  const who = run.observedBy ? `${delegateLabel(run.observedBy)} ` : "";
  const verb = (word: string) => (who ? `${who}${word.toLowerCase()}` : word);
  return {
    label: run.workedMs
      ? `${verb("Worked")} for ${formatElapsed(run.workedMs)}`
      : run.thinkingMs
        ? `${verb("Thought")} for ${formatElapsed(run.thinkingMs)}`
        : count,
    count,
    names: run.names.join(", "),
  };
}

// ── The run while it is still going ─────────────────────────────────────────
//
// A run in flight is read, not opened. The operator follows the thread of
// what the model is doing — the sentence it wrote before a call, the next
// sentence after — and the calls between are machinery: finished, they are
// one quiet line ("Read files, searched files"); the one running is one
// line too ("Running curl …"). Thinking folds away with the rows, except
// that a turn which said nothing lends the gist of its thought to the slot
// its sentence would have had — a reasoning model narrates there. When the
// answer lands the whole run folds to "Worked for" and a click gives every
// row back (`groupToolRuns` / `ToolRunRow`); this digest is only for the
// time before that.

export type LiveStep =
  | { kind: "prose"; index: number }
  /** A turn that said nothing and went straight to its calls: the sentence
   *  it would have written is in its thinking, and its gist stands where
   *  the sentence would (`thoughtGist`). */
  | { kind: "thought"; index: number; text: string }
  | {
      kind: "work";
      /** Distinct tool names, in first-appearance order. */
      names: string[];
      calls: number;
      /** The call still running, when one is — the line reads what it is
       *  doing rather than what the finished ones did. */
      live?: { name: string; args: unknown };
    };

function resultPending(r: Msg | undefined): boolean {
  return !r || (r.role === "tool" && /^Running /.test(r.content));
}

export function liveWorkSteps(msgs: Msg[], start: number, end: number, pairing: ToolResultPairing = pairToolResults(msgs)): LiveStep[] {
  const steps: LiveStep[] = [];
  let group: Extract<LiveStep, { kind: "work" }> | null = null;
  const note = (name: string) => {
    if (!group) group = { kind: "work", names: [], calls: 0 };
    if (!group.names.includes(name)) group.names.push(name);
    group.calls++;
  };
  const flush = () => {
    if (group) steps.push(group);
    group = null;
  };
  for (let i = start; i < end; i++) {
    const m = msgs[i];
    if (m.role === "assistant") {
      if (visibleProse(m) !== "") {
        flush();
        steps.push({ kind: "prose", index: i });
      } else if (m.toolCalls?.length) {
        // Only once the turn has settled on its calls: a thought still
        // streaming changes with every token, and would be read mid-word.
        const gist = thoughtGist(thoughtText(m));
        if (gist) {
          flush();
          steps.push({ kind: "thought", index: i, text: gist });
        }
      }
      const results = pairing.byCall.get(i);
      (m.toolCalls ?? []).forEach((call, index) => {
        note(call.name);
        const r = results?.get(toolCallKey(call, index));
        if (resultPending(r === undefined ? undefined : msgs[r])) {
          group!.live = { name: call.name, args: call.args };
        } else if (group!.live?.name === call.name && group!.live.args === call.args) {
          group!.live = undefined;
        }
      });
      continue;
    }
    // A result its call already counted; or a stray one (the call was
    // compacted away), which still counts as a step of work.
    if (m.role === "tool" && !pairing.claimed.has(i)) note(m.toolName ?? "tool");
  }
  flush();
  return steps;
}

/** What a tool does, as a verb phrase the summary line joins: "read files,
 *  searched files, ran commands". Harness names and the delegate CLIs' own
 *  (`Read`, `Bash`, `Grep`, `Edit`) both land. */
export function workVerb(name: string): string {
  const n = name.toLowerCase();
  if (/^(read_file|peek_value|list_dir|read|list|ls|cat|notebookread)$/.test(n)) return "read files";
  if (/^(grep|glob|search_conversations|rg|find)$/.test(n)) return "searched files";
  if (/^(run_command|read_command_output|kill_command|bash|shell|exec)$/.test(n)) return "ran commands";
  if (/^(web_search|web_fetch|websearch|webfetch|fetch)$/.test(n)) return "searched the web";
  if (/^(write_file|create_file|edit|write|multiedit|notebookedit|write_spreadsheet)$/.test(n)) return "edited files";
  if (/^(inspect_spreadsheet)$/.test(n)) return "inspected a workbook";
  if (/^get_git_/.test(n)) return "checked git";
  if (/^memory_/.test(n)) return "recalled memory";
  if (/^(update_todo_list|get_todo_list|todowrite|todoread)$/.test(n)) return "updated the plan";
  if (/^(lint)$/.test(n)) return "ran lint";
  if (/^(consult_advisor)$/.test(n)) return "asked the advisor";
  if (/^(connector_call|connector_tools)$/.test(n)) return "used a connector";
  return `used ${name}`;
}

/** The one line for a finished stretch of calls: "Read files, searched
 *  files, ran commands". */
export function workSummary(names: string[]): string {
  const verbs: string[] = [];
  for (const name of names) {
    const v = workVerb(name);
    if (!verbs.includes(v)) verbs.push(v);
  }
  const line = verbs.join(", ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

function firstStringArg(args: unknown, keys: string[]): string {
  let v: unknown = args;
  if (typeof v === "string") {
    const raw: string = v;
    try { v = JSON.parse(raw); } catch { return raw.trim(); }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return "";
  const o = v as Record<string, unknown>;
  for (const key of keys) {
    const val = o[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  const first = Object.values(o).find((x) => typeof x === "string" && (x as string).trim()) as string | undefined;
  return first?.trim() ?? "";
}

/** The one line for the call that is running: "Running curl -L …",
 *  "Reading src/toast.ts", "Searching the web for opencode v2". */
export function liveWorkLine(call: { name: string; args: unknown }): string {
  const n = call.name.toLowerCase();
  const arg = firstStringArg(call.args, ["command", "path", "pattern", "query", "url", "file_path", "title"]).replace(/\s+/g, " ");
  const what = arg.length > 120 ? arg.slice(0, 119) + "…" : arg;
  const verb = /^(run_command|bash|shell|exec)$/.test(n)
    ? "Running"
    : /^(read_file|peek_value|read|cat|notebookread)$/.test(n)
      ? "Reading"
      : /^(list_dir|list|ls)$/.test(n)
        ? "Listing"
        : /^(grep|glob|rg|find|search_conversations)$/.test(n)
          ? "Searching"
          : /^(web_search|websearch)$/.test(n)
            ? "Searching the web for"
            : /^(web_fetch|webfetch|fetch)$/.test(n)
              ? "Fetching"
              : /^(write_file|create_file|edit|write|multiedit|notebookedit|write_spreadsheet)$/.test(n)
                ? "Editing"
                : null;
  if (verb) return what ? `${verb} ${what}` : `${verb}…`;
  return what ? `${call.name} ${what}` : `${call.name}…`;
}
