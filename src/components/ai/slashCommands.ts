// The one slash-command vocabulary. Two composers offer a `/` menu — the AI
// panel's (a live conversation) and Focus's start stage (no conversation yet)
// — and they must agree on how a query is recognised, how it filters, how the
// keyboard walks the list, and what the shared one-shot prompts say. Each host
// still supplies its own `run` closures, because what "/plan" does depends on
// whose state it flips; the rest lives here so the two menus can't drift.

import type { AgentMode } from "../../agent/types";
import { skillSlashName, type Skill } from "../../skills";

export { skillSlashName };

export type SlashCommand = {
  name: string;
  desc: string;
  run: () => void | Promise<void>;
};

/** A `/` the composer is willing to read as a command.
 *
 *  A slash opens the menu wherever it is typed — at the head of the draft or
 *  in the middle of a sentence — as long as it starts a word: something must
 *  precede it that isn't a character, so `src/App.tsx` never counts. What
 *  gives the remaining paths away is what *follows* the word: a second slash
 *  or a dot means `/src/App.tsx`, not a command, and the menu stays shut even
 *  while the path is half typed. Hyphens belong to the word, so `/auto-mode`
 *  keeps the menu open past the dash.
 *
 *  `head` says the slash opens the draft and nothing follows it — the shape in
 *  which a command may take the whole composer over (`/clear`, `/plan`).
 *  Mid-sentence, only the Skills are on offer, because they compose with the
 *  prose already typed and the built-ins replace it. */
export type SlashQuery = {
  /** The word typed so far, up to the caret: `vis` in `/vis|ualise`. */
  query: string;
  /** Where the `/` sits in the draft. */
  start: number;
  /** The slash opens the draft and nothing but space follows the word. */
  head: boolean;
};

export function slashQueryAt(value: string, caret: number = value.length): SlashQuery | null {
  const at = Math.max(0, Math.min(caret, value.length));
  const before = value.slice(0, at);
  const m = before.match(/(?:^|\s)\/([\w-]*)$/);
  if (m === null) return null;
  const query = m[1];
  // The word can run on past the caret — `/vis|ualise`, or the `src` of a path
  // whose slash happens to follow a space. Read it whole before judging it.
  const tail = value.slice(at).match(/^[\w-]*/)![0];
  const rest = value.slice(at + tail.length);
  if (/^[/.]/.test(rest)) return null;
  const start = at - query.length - 1;
  // The tail is the same word, still being typed; only what lies beyond it
  // makes a command stop being the whole draft.
  return { query, start, head: start === 0 && rest.trim() === "" };
}

/** Accepting a command: it lands where it was typed.
 *
 *  The half-typed word is replaced in place — a sentence already written is
 *  not rearranged to make room for a command, so the caret comes back right
 *  after the command with the rest of the line untouched. The trailing space
 *  is the one the composer's `skillTokenOf` needs to read a command as closed;
 *  it is dropped when the prose that follows already starts with one. */
export function replaceSlashWord(opts: {
  value: string;
  /** Where the typed `/` sits in the draft. */
  start: number;
  /** Where the caret sits; the word may run on past it. */
  caret: number;
  /** What the command leaves behind, trailing space included. */
  prefix: string;
}): { value: string; caret: number } {
  const { value, start, caret, prefix } = opts;
  const end = caret + (value.slice(caret).match(/^[\w-]*/)?.[0].length ?? 0);
  const after = value.slice(end);
  const inserted = /^\s/.test(after) ? prefix.replace(/\s+$/, "") : prefix;
  return { value: value.slice(0, start) + inserted + after, caret: start + inserted.length };
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

/** What accepting a Skill's `/` entry leaves in the composer: the command
 *  itself and a space, cursor after it. The message goes out as typed —
 *  `/visualise draw the flow` — and the system prompt names each enabled
 *  skill's command (`enabledSkillsPrompt`), so the model reads the word as
 *  the instruction. Nothing is rewritten between what you see and what is
 *  sent. */
export function skillSlashPrefix(skill: Pick<Skill, "name">): string {
  return `/${skillSlashName(skill.name)} `;
}

/** The enabled Skills as `/` commands, after the built-in vocabulary. Only
 *  enabled skills appear — a disabled skill's instructions aren't in the
 *  prompt, so a command for it would promise what the run can't keep. A
 *  skill whose name collides with a built-in command (`/handoff`) yields to
 *  it; two skills that slug to the same name keep the first. */
export function skillSlashCommands(
  skills: readonly Skill[],
  taken: readonly Pick<SlashCommand, "name">[],
  insert: (prefix: string) => void,
): SlashCommand[] {
  const used = new Set(taken.map((c) => c.name));
  const out: SlashCommand[] = [];
  for (const skill of skills) {
    if (!skill.enabled) continue;
    const name = skillSlashName(skill.name);
    if (!name || used.has(name)) continue;
    used.add(name);
    out.push({
      name,
      desc: skill.description.trim() || `Apply the ${skill.name} skill to what you type next`,
      run: () => insert(skillSlashPrefix(skill)),
    });
  }
  return out;
}
