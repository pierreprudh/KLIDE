// The one slash-command vocabulary. Two composers offer a `/` menu — the AI
// panel's (a live conversation) and Focus's start stage (no conversation yet)
// — and they must agree on how a query is recognised, how it filters, how the
// keyboard walks the list, and what the shared one-shot prompts say. Each host
// still supplies its own `run` closures, because what "/plan" does depends on
// whose state it flips; the rest lives here so the two menus can't drift.

import type { AgentMode } from "../../agent/types";

export type SlashCommand = {
  name: string;
  desc: string;
  run: () => void | Promise<void>;
};

/** The typed prefix that opens the menu, or null when the composer is not in
 *  slash-command shape. Only a lone `/word` at the start of the draft counts —
 *  a slash anywhere else is prose (a path, a fraction). Hyphens are part of the
 *  word so `/auto-mode` keeps the menu open past the dash. */
export function slashQueryOf(value: string): string | null {
  const m = value.match(/^\/([\w-]*)$/);
  return m ? m[1] : null;
}

export function filterSlashCommands<T extends { name: string }>(commands: readonly T[], query: string): T[] {
  const q = query.toLowerCase();
  return commands.filter((c) => c.name.startsWith(q));
}

/** Wrap-around step through the list; a zero-length list stays at 0. */
export function stepSlashIndex(idx: number, delta: 1 | -1, length: number): number {
  if (length <= 0) return 0;
  return (idx + delta + length) % length;
}

export type SlashKeyAction = "next" | "prev" | "accept" | "dismiss";

/** What a keystroke means while the menu is open. Null means the composer
 *  should handle the key itself (typing, Shift+Enter, …). */
export function slashKeyAction(key: string): SlashKeyAction | null {
  switch (key) {
    case "ArrowDown": return "next";
    case "ArrowUp": return "prev";
    case "Enter":
    case "Tab": return "accept";
    case "Escape": return "dismiss";
    default: return null;
  }
}

/** Descriptions shared word-for-word by both menus. */
export const SLASH_DESC = {
  chat: "Switch to Chat mode (no tools)",
  plan: "Switch to Plan mode (read-only, proposes a plan)",
  goal: "Switch to Goal mode (can propose edits)",
  mode: "Show the current mode",
  autoMode: "Auto-accept edits — apply without a prompt",
  reviewMode: "Review every edit before it applies (default)",
  clear: "Start a new conversation",
  compact: "Summarize older turns to free up context",
  handoff: "Save this task state into Project Memory",
  start: "Start the local server (Ollama / MLX) for this provider",
  explain: "Explain a file — pick one next (read-only)",
  init: "Analyze the repo and create a CLAUDE.md",
  interview: "Interview me about this codebase — Q&A, one question at a time",
} as const;

/** The mode in words, for `/mode`. Reads the same three facts both composers
 *  hold: the effective mode, and the Goal policy pair. */
export function currentModeText(opts: {
  effectiveMode: AgentMode;
  requireDiffReview: boolean;
  autoApproveCommands: boolean;
}): string {
  if (opts.effectiveMode === "chat") return "chat mode · no tools";
  if (opts.effectiveMode === "plan") return "plan mode · read-only";
  if (opts.requireDiffReview) return "reviewing every edit";
  return opts.autoApproveCommands
    ? "full auto · commands run without asking"
    : "auto-accept edits on";
}

/** One-shot prompts that start a run on their own. The mode each rides in is
 *  part of the command, not the composer's current setting: /init edits, so it
 *  needs Goal; /interview only reads, so Plan keeps it from touching a file. */
export const SLASH_PROMPTS: Record<"init" | "interview", { mode: AgentMode; text: string }> = {
  init: {
    mode: "goal",
    text:
      "Explore this project (read key files like package.json, README, and the main source folders) and create a concise CLAUDE.md at the workspace root documenting what the project is, its stack, how to run it, and the repo layout. Use create_file so I can review the diff.",
  },
  interview: {
    mode: "plan",
    // The prompt is self-contained so the skill works even if the user hasn't
    // installed the SKILL.md yet — installing it just gives the model extra
    // system-prompt context.
    text:
      "Run the codebase interview. Read README.md (and the top-level package manifest / entry point if there's no README) to ground yourself, then identify 5-10 high-signal things you don't understand about the project — ambiguous naming, surprising structure, missing docs, design tensions, historical choices. For each one, call the `userAnswerQuestion` tool with a single short question (one sentence, focused on what only I can answer). Wait for each answer, use it as-is, and move to the next. After all questions, write a structured doc to docs/codebase-decisions.md with one section per Q&A (Question / Answer / Why it matters). End the run when the doc is written.",
  },
};

export const EXPLAIN_PREFIX = "Explain what this file does and how it works: ";
