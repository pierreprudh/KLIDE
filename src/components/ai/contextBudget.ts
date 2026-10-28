// What is in the model's context window, and how full is it.
//
// This was ~145 lines of straight-line arithmetic in the middle of AiPanel's
// component body — a 3,700-line function with no tests. That mattered more than
// the usual "big file" complaint, because one of these numbers arms an
// *automatic* compaction: crossing the window spends the user's money on a
// summarisation call without being asked. The threshold, and the
// compaction-marker exclusion that stops it firing in a loop, were only
// reachable by mounting the panel against a live event stream.
//
// Everything here is values in, values out. No React, no IPC, no clock.

import { estimateProjectContextTokens, estimateTokens, messageTokenParts } from "./utils";
import type { Msg } from "./types";
import type { ProjectContextItem } from "../../contextTray";

/** One slice of the window, for the breakdown list and the donut. */
export type ContextBreakdownRow = {
  id: string;
  label: string;
  tokens: number;
  color: string;
  muted?: boolean;
  /** What the row is made of, largest first — the popover's flyout. Only
   *  rows with a split worth reading carry one (Messages, Skills). */
  details?: ContextDetailRow[];
};

export type ContextDetailRow = { label: string; tokens: number };

/** Skills listed by name in the flyout before the rest fold into one line. */
const SKILL_DETAIL_LIMIT = 5;

export type ContextBudgetInput = {
  msgs: Msg[];
  /** `conversationTokenEstimate(msgs)`, when the caller already has it. The
   *  message walk stringifies every tool call and depends on `msgs` alone;
   *  the rest of the budget moves with every keystroke of the draft. */
  messageTokens?: number;
  /** `conversationTokens(msgs).details`, memoized beside `messageTokens`. */
  messageDetails?: ContextDetailRow[];
  /** The unsent draft in the composer. Counted, because it will be sent. */
  draft: string;
  /** Already-assembled system prompt for this draft, skills and rules included
   *  (they are subtracted back out so each is attributed once). */
  systemPrompt: string;
  skillsPrompt: string;
  /** `enabledSkillsPromptParts(skills)` — the same block, in pieces. */
  skillParts?: { preamble: string; lines: { command: string; line: string }[] } | null;
  projectRules: string;
  lens: ProjectContextItem[];
  toolSchemaTokens: number;
  /** The provider's own prompt-token count for the last turn, when it reported
   *  one. Preferred over the estimate — it already accounts for the system
   *  prompt, the tool schemas and the full history. */
  measuredPromptTokens: number | null;
  measuredUsageTokens: { prompt: number; completion: number } | null;
  contextLimit: number;
  /** Mid-stream the measured numbers describe the *previous* turn, so the
   *  estimate is the honest answer until the turn settles. */
  streaming: boolean;
};

export type ContextBudget = {
  /** Committed conversation + draft, measured if we can, estimated otherwise. */
  used: number;
  /** Just the committed conversation — what the auto-compaction test uses, so a
   *  long draft can't arm it. */
  committedUsed: number;
  remaining: number;
  /** 0…1, clamped. Drives the ring. */
  ratio: number;
  /** Unclamped, for the auto-compaction test: ≥1 means the next send would not
   *  fit. */
  rawRatio: number;
  /** The same "prompt + draft" figure, but from the provider's *usage* report
   *  rather than its prompt-token count. The two are separate signals — a
   *  provider may report one and not the other — so the tooltip that shows the
   *  split keeps its own number instead of quietly borrowing `used`. */
  promptUsed: number;
  breakdown: ContextBreakdownRow[];
  messageTokens: number;
  draftTokens: number;
};

/** A conversation this short has nothing worth folding: the gate for the
 *  Compact action. What a compaction keeps is Rust's call (`compaction.rs`). */
export const COMPACT_KEEP_RECENT = 4;


/** The composer offers Compact once the gauge reads half full. The Run
 *  compacts by itself when it has to; the button is for "now". */
export const COMPACT_OFFER_RATIO = 0.5;

/**
 * Index of the newest compaction marker, or -1.
 *
 * Earlier rows remain visible. Some recent turns are retained by Rust even
 * though they precede this marker on screen; its contextTokens snapshot counts
 * those turns together with the summary. Other earlier rows are excluded.
 */
export function lastCompactionIndex(msgs: Msg[]): number {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === "system" && (m as Extract<Msg, { role: "system" }>).compaction) return i;
  }
  return -1;
}

/** Estimated tokens of everything the model still sees: the newest checkpoint
 *  (summary plus retained history), then subsequent messages. One
 *  `JSON.stringify` per tool call — and a function of `msgs` alone, so a
 *  caller can memoize it on the message list and pass it in. */
export function conversationTokenEstimate(msgs: Msg[]): number {
  return conversationTokens(msgs).total;
}

/** The same walk, kept apart by what each token is: the user's words, the
 *  answers, reasoning, tool traffic, and the compacted checkpoint. */
export function conversationTokens(msgs: Msg[]): { total: number; details: ContextDetailRow[] } {
  const markerIdx = lastCompactionIndex(msgs);
  let compacted = 0;
  if (markerIdx >= 0) {
    const marker = msgs[markerIdx];
    const compaction = marker.role === "system" ? marker.compaction : undefined;
    // The visible marker follows its retained turns. Rust's snapshot includes
    // those turns and their retained-value stubs, without counting history twice.
    compacted = compaction?.contextTokens ?? estimateTokens(`[Earlier conversation compacted to save context]\n${compaction?.summary ?? ""}`);
  }
  const sums = { prompts: 0, answers: 0, reasoning: 0, tools: 0, other: 0 };
  for (const m of markerIdx < 0 ? msgs : msgs.slice(markerIdx + 1)) {
    const p = messageTokenParts(m);
    sums.prompts += p.prompts;
    sums.answers += p.answers;
    sums.reasoning += p.reasoning;
    sums.tools += p.tools;
    sums.other += p.other;
  }
  const details = [
    { label: "Your messages", tokens: sums.prompts },
    { label: "Answers", tokens: sums.answers },
    { label: "Reasoning", tokens: sums.reasoning },
    { label: "Tool calls and results", tokens: sums.tools },
    { label: "Compacted notes", tokens: compacted },
    { label: "Notices", tokens: sums.other },
  ].filter((d) => d.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  return { total: compacted + sums.prompts + sums.answers + sums.reasoning + sums.tools + sums.other, details };
}

/** One line per enabled skill, largest first, the tail folded into one; the
 *  shared preamble takes whatever the lines don't, so the flyout sums to the
 *  row. */
function skillDetails(
  parts: NonNullable<ContextBudgetInput["skillParts"]>,
  skillsTokens: number,
): ContextDetailRow[] {
  const lines = parts.lines
    .map((l) => ({ label: l.command, tokens: estimateTokens(l.line) }))
    .sort((a, b) => b.tokens - a.tokens);
  const shown = lines.slice(0, SKILL_DETAIL_LIMIT);
  const rest = lines.slice(SKILL_DETAIL_LIMIT);
  const linesTotal = lines.reduce((sum, l) => sum + l.tokens, 0);
  return [
    ...shown,
    ...(rest.length > 0
      ? [{ label: `${rest.length} more ${rest.length === 1 ? "skill" : "skills"}`, tokens: rest.reduce((sum, l) => sum + l.tokens, 0) }]
      : []),
    { label: "How to use skills", tokens: Math.max(0, skillsTokens - linesTotal) },
  ].filter((d) => d.tokens > 0);
}

export function computeContextBudget(input: ContextBudgetInput): ContextBudget {
  const {
    msgs,
    draft,
    systemPrompt,
    skillsPrompt,
    projectRules,
    lens,
    toolSchemaTokens,
    measuredPromptTokens,
    measuredUsageTokens,
    contextLimit,
    streaming,
  } = input;

  const conversation =
    input.messageTokens === undefined || input.messageDetails === undefined ? conversationTokens(msgs) : null;
  const messageTokens = input.messageTokens ?? conversation!.total;
  const messageDetails = input.messageDetails ?? conversation!.details;

  const draftTokens = estimateTokens(draft);
  const skillsTokens = estimateTokens(skillsPrompt);
  const projectRulesTokens = estimateTokens(projectRules);
  const lensTokens = estimateProjectContextTokens(lens);
  // Skills and rules are already inside the assembled prompt; subtract them so
  // the breakdown attributes each to one row.
  const systemPromptTokens = Math.max(
    0,
    estimateTokens(systemPrompt) - skillsTokens - projectRulesTokens
  );

  const estimated =
    messageTokens +
    systemPromptTokens +
    skillsTokens +
    projectRulesTokens +
    toolSchemaTokens +
    lensTokens;

  const settledMeasured = measuredPromptTokens !== null && !streaming;
  const committedUsed = settledMeasured ? measuredPromptTokens : estimated;
  const used = committedUsed + draftTokens;
  const replyTokens = measuredUsageTokens !== null && !streaming ? measuredUsageTokens.completion : 0;

  const promptUsed =
    (measuredUsageTokens !== null && !streaming ? measuredUsageTokens.prompt : estimated) +
    draftTokens;

  const remaining = Math.max(0, contextLimit - used);
  const rawRatio = contextLimit > 0 ? committedUsed / contextLimit : 0;
  const ratio = contextLimit > 0 ? Math.min(1, used / contextLimit) : 0;

  const rows: ContextBreakdownRow[] = [
    { id: "messages", label: "Messages", tokens: messageTokens, color: "var(--ctx-messages)", details: messageDetails },
    { id: "tools", label: "System tools", tokens: toolSchemaTokens, color: "var(--ctx-tools)" },
    { id: "system", label: "System prompt", tokens: systemPromptTokens, color: "var(--ctx-system)" },
    {
      id: "skills",
      label: "Skills",
      tokens: skillsTokens,
      color: "var(--ctx-skills)",
      details: input.skillParts ? skillDetails(input.skillParts, skillsTokens) : undefined,
    },
    { id: "rules", label: "Project rules", tokens: projectRulesTokens, color: "var(--ctx-rules)" },
    { id: "lens", label: "Context lens", tokens: lensTokens, color: "var(--ctx-lens)" },
    { id: "draft", label: "Draft input", tokens: draftTokens, color: "var(--ctx-draft)" },
    { id: "reply", label: "Last reply", tokens: replyTokens, color: "var(--ctx-reply)" },
  ].filter((row) => row.tokens > 0);

  // Whatever the provider counted that we didn't: its own scaffolding, plus the
  // gap between our chars-per-token heuristic and its real tokeniser.
  const measuredDelta = settledMeasured ? Math.max(0, measuredPromptTokens - estimated) : 0;

  const breakdown: ContextBreakdownRow[] = [
    ...rows,
    ...(measuredDelta > 0
      ? [
          {
            id: "measured-extra",
            label: "Provider overhead",
            tokens: measuredDelta,
            color: "var(--fg-dim)",
            muted: true,
          },
        ]
      : []),
    { id: "free", label: "Free space", tokens: remaining, color: "var(--border-strong)", muted: true },
  ];

  return {
    used,
    committedUsed,
    remaining,
    ratio,
    rawRatio,
    promptUsed,
    breakdown,
    messageTokens,
    draftTokens,
  };
}

/** Ring colour for a fullness ratio. */
export function contextTone(ratio: number): string {
  if (ratio > 0.85) return "var(--danger)";
  if (ratio > 0.65) return "var(--warning)";
  return "var(--accent)";
}

/** Is there anything worth folding, and is this a conversation we manage?
 *  Delegate CLIs handle their own context. */
export function canCompactConversation(opts: {
  providerDelegatesWork: boolean;
  streaming: boolean;
  compacting: boolean;
  messageCount: number;
}): boolean {
  return (
    !opts.providerDelegatesWork &&
    !opts.streaming &&
    !opts.compacting &&
    opts.messageCount > COMPACT_KEEP_RECENT + 1
  );
}

/** Running cost of a conversation: the sum of every turn's own cost. Stays 0
 *  for local, subscription and unknown-price models. */
export function conversationCost(msgs: Msg[]): number {
  return msgs.reduce((sum, m) => sum + (m.role === "assistant" ? m.meta?.costUsd ?? 0 : m.role === "system" ? m.compaction?.costUsd ?? 0 : 0), 0);
}
