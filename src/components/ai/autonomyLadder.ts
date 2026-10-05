// The agent's autonomy, in one place — split along the seam the UI wears it:
//
// **Mode** is a domain noun (see CONTEXT.md): the capability tier of a Run —
// `chat` (no tools), `plan` (read-only tools), `goal` (full tools). The + menu
// offers two of them: Plan, and `goal` under its working name, **Work**. Work
// is the default — an editor's assistant edits. `chat` is not picked: it is
// what Work collapses to when the model cannot call tools (`effectiveMode`).
// "Goal" as a word is now the `/goal` command — an objective the run works
// toward until it is done (`goalDirectiveOf`) — not a tier.
//
// **Goal policy** is what Goal mode does with its two gates: review every edit
// (the default), auto-accept edits (commands still ask), or full auto (edits
// and commands, no prompts). In a live conversation the foot bar is the decider
// — its standing note names the policy and a click cycles to the next — so Mode
// never grows a rung per policy. Focus's start stage has no run to report on
// yet, so its "+" menu lists the policies as rows below the Mode rows instead.

import type { AgentMode } from "../../agent/types";

export type ModeChoice = {
  mode: AgentMode;
  label: string;
  /** One short clause. Lower-case, no trailing period: it renders as a
   *  subtitle under the label. */
  description: string;
};

export const MODE_CHOICES: ModeChoice[] = [
  { mode: "plan", label: "Plan", description: "read-only, proposes" },
  { mode: "goal", label: "Work", description: "edits and commands" },
];

/** The Mode a composer opens on. Work, unless the last pick was Plan: the
 *  stored value is the picker's own, so a `chat` left over from the three-row
 *  menu lands on Work rather than on a row that is no longer there. */
export function initialMode(stored: string | null): AgentMode {
  return stored === "plan" ? "plan" : "goal";
}

/** The label a Mode wears in the UI (`goal` reads Work). Chat is named only
 *  when it is the effective tier of a tool-less model. */
export function modeLabel(mode: AgentMode): string {
  return MODE_CHOICES.find((c) => c.mode === mode)?.label ?? "Chat";
}

export type GoalPolicy = "review" | "auto" | "full";

export type GoalPolicyChoice = {
  key: GoalPolicy;
  /** The foot-bar note's text. Lower-case: it sits beside the branch label. */
  label: string;
  /** One short clause, for the surfaces that list the policies as rows (the
   *  start-stage + menu) instead of cycling one note. */
  description: string;
  /** What the run request gets. `commands: true` is never persisted — on
   *  reload every panel falls back to prompting. */
  review: boolean;
  commands: boolean;
};

/** Cycle order — each click on the foot-bar note escalates one step, then
 *  wraps back to the reviewing default. */
export const GOAL_POLICIES: GoalPolicyChoice[] = [
  { key: "review", label: "reviewing edits", description: "every edit waits for you", review: true, commands: false },
  { key: "auto", label: "auto-accept edits", description: "edits apply, commands ask", review: false, commands: false },
  { key: "full", label: "full auto", description: "edits and commands, no prompts", review: false, commands: true },
];

/** Which policy the current pair of gate flags spells. An off-ladder combo
 *  (review on + commands on) reads as review — the safest gate wins. */
export function goalPolicyOf(requireDiffReview: boolean, autoApproveCommands: boolean): GoalPolicyChoice {
  const match = GOAL_POLICIES.find(
    (p) => p.review === requireDiffReview && p.commands === (requireDiffReview ? false : autoApproveCommands)
  );
  return match ?? GOAL_POLICIES[0];
}

/** The next rung on the click cycle. */
export function nextGoalPolicy(current: GoalPolicy): GoalPolicyChoice {
  const idx = GOAL_POLICIES.findIndex((p) => p.key === current);
  return GOAL_POLICIES[(idx + 1) % GOAL_POLICIES.length];
}

/**
 * The mode a pick collapses to when the model cannot call tools.
 *
 * A model with no tool support cannot Work, so offering it would produce a
 * run that silently does nothing. Delegate providers are exempt: the
 * CLI behind them runs its own tools, so Klide's view of "does this model
 * support tools" does not apply.
 *
 * Both surfaces had their own copy of this and they had already diverged —
 * FocusMode's omitted the delegate exemption. It didn't bite only because Focus
 * filters delegates out of its picker, which is a coincidence, not a reason.
 */
export function effectiveMode(opts: {
  mode: AgentMode;
  modelSupportsTools: boolean;
  providerDelegatesWork: boolean;
}): AgentMode {
  const { mode, modelSupportsTools, providerDelegatesWork } = opts;
  if (mode === "goal" && !modelSupportsTools && !providerDelegatesWork) return "chat";
  return mode;
}
