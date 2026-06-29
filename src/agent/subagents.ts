// Subagent registry — the shared primitive behind @mention dispatch,
// the spawn_subagent tool, and Goal-mode fan-out.
//
// A subagent is a focused *role*: a mode (read-only `plan` vs editing `goal`),
// a system-prompt fragment that specialises the base harness prompt, and an
// optional model override. Running one is just `startAgentRun` with the
// subagent's systemPrompt + mode + `parentId` set — Mission Control already
// nests child runs by `parentId`, so spawned subagents surface there for free.

import type { AgentMode } from "./types";

export type SubagentId = "explorer" | "reviewer" | "implementer" | "tester";

export type Subagent = {
  id: SubagentId;
  /** Token the user types after `@` and the label shown in the menu. */
  label: string;
  /** One line for the mention menu. */
  blurb: string;
  /** Read-only (`plan`) or editing (`goal`). Drives the tool allowlist. */
  mode: AgentMode;
  /** Role specialisation appended to the base system prompt. */
  instructions: string;
  /** Optional model override — e.g. a cheaper model for the explorer. */
  model?: string;
};

export const BUILTIN_SUBAGENTS: Subagent[] = [
  {
    id: "explorer",
    label: "explorer",
    blurb: "Read-only sweep — locate code across the repo, report findings",
    mode: "plan",
    instructions:
      "You are the Explorer subagent. Your job is to LOCATE and REPORT, never to edit. " +
      "Sweep the workspace with read-only tools, follow naming conventions across files, and " +
      "return a concise map: the files that matter, with `path:line` references and verbatim " +
      "signatures where they help. Do not propose a design or make changes — just surface what exists.",
  },
  {
    id: "reviewer",
    label: "reviewer",
    blurb: "Read-only critique — review the change for bugs and clarity",
    mode: "plan",
    instructions:
      "You are the Reviewer subagent. Inspect the relevant code read-only and critique it: " +
      "correctness bugs first, then clarity and reuse. Be specific — cite `path:line`, explain why " +
      "each finding is a real problem, and rank by severity. Do not edit files; return findings only.",
  },
  {
    id: "implementer",
    label: "implementer",
    blurb: "Editing — make the smallest useful set of diff-reviewed edits",
    mode: "goal",
    instructions:
      "You are the Implementer subagent. Inspect first, then make the smallest useful set of edits " +
      "to achieve the task. Every edit is diff-reviewed before it is written. After tool work, " +
      "summarise what changed, what was applied or rejected, and what remains.",
  },
  {
    id: "tester",
    label: "tester",
    blurb: "Editing — add or run tests and report pass/fail",
    mode: "goal",
    instructions:
      "You are the Tester subagent. Focus on verification: find the test setup, add focused tests " +
      "for the task at hand (diff-reviewed), and run them. Report what passed, what failed, and the " +
      "exact failing output. Do not refactor unrelated code.",
  },
];

export function resolveSubagent(id: string): Subagent | undefined {
  return BUILTIN_SUBAGENTS.find((s) => s.id === id || s.label === id);
}

/** Subagents whose label starts with `query` (case-insensitive), for the @menu. */
export function matchSubagents(query: string): Subagent[] {
  const q = query.trim().toLowerCase();
  if (!q) return BUILTIN_SUBAGENTS;
  return BUILTIN_SUBAGENTS.filter((s) => s.label.toLowerCase().startsWith(q));
}

/**
 * Compose a subagent's system prompt by appending its role specialisation to
 * the base harness prompt. Keeping the base intact preserves identity guard,
 * workspace root, tool conventions, skills, and project rules.
 */
export function buildSubagentSystemPrompt(def: Subagent, base: string): string {
  return `${base}

--- SUBAGENT ROLE ---
You are running as a delegated subagent ("${def.label}"), spawned to handle one focused task. Stay strictly within this role and return a tight, self-contained result the parent agent can act on.

${def.instructions}`;
}

/**
 * Parse a leading `@<subagent>` directive from composer text.
 * Returns the matched subagent and the remaining task text, or null.
 * Only matches known subagent ids so it never clashes with `@file` mentions.
 */
export function parseSubagentDirective(
  text: string
): { subagent: Subagent; task: string } | null {
  const m = text.match(/^@([a-z][\w-]*)\s+([\s\S]+)$/i);
  if (!m) return null;
  const subagent = resolveSubagent(m[1]);
  if (!subagent) return null;
  return { subagent, task: m[2].trim() };
}

/**
 * Find `@<subagent>` mentions embedded *inside* a larger message — the
 * concurrent case: the main assistant answers the message while each mentioned
 * subagent runs in the background. Each call's task is the text following the
 * mention up to the next mention (or end), with a leading "to "/"please "/":"
 * filler trimmed. Only known subagent ids match, so `@file` mentions are
 * ignored. Returns [] when there are none.
 */
export function extractInlineSubagentCalls(
  text: string
): { subagent: Subagent; task: string }[] {
  const calls: { subagent: Subagent; task: string }[] = [];
  const matches = [...text.matchAll(/@([a-z][\w-]*)/gi)];
  for (let i = 0; i < matches.length; i += 1) {
    const m = matches[i];
    const subagent = resolveSubagent(m[1]);
    if (!subagent) continue;
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index ?? text.length : text.length;
    const task = text
      .slice(start, end)
      .trim()
      .replace(/^(to|please|and|:)\s+/i, "")
      .trim();
    calls.push({ subagent, task: task || text.trim() });
  }
  return calls;
}
