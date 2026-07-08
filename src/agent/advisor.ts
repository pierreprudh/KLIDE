// Advisor strategy — a cheap executor (the run's own model, typically small or
// local) escalates ONE hard decision to a stronger advisor model via the
// `consult_advisor` tool. The advisor gives guidance (a plan, a correction, or
// a stop signal); it does not take over the task. This mirrors Anthropic's
// "advisor strategy", but Klide's is cross-provider: a local model can consult
// a hosted one because the whole loop runs in our own harness.
//
// The advisor consultation is a ONE-SHOT chat run (no tools) on the advisor's
// provider/model, seeded with the executor's self-contained question. It runs
// as a nested child (parentId = the executor run), so Mission Control nests it.

/** Default advisor when none is configured in Harness settings. The canonical
 *  advisor strategy: a cheap executor escalates to a hosted top model. Needs an
 *  Anthropic key in Settings. Change via HarnessSettings.advisorProvider/
 *  advisorModel (e.g. ollama/qwen3.5:9b for a keyless local-first advisor). */
export const DEFAULT_ADVISOR_PROVIDER = "anthropic";
export const DEFAULT_ADVISOR_MODEL = "claude-opus-4-8";

export type AdvisorConfig = { provider: string; model: string };

/** Resolve the advisor pairing from harness settings, falling back to the
 *  default. Kept tiny so both AiPanel and any future settings UI agree. */
export function resolveAdvisor(settings?: {
  advisorProvider?: string;
  advisorModel?: string;
}): AdvisorConfig {
  return {
    provider: settings?.advisorProvider?.trim() || DEFAULT_ADVISOR_PROVIDER,
    model: settings?.advisorModel?.trim() || DEFAULT_ADVISOR_MODEL,
  };
}

/** System prompt for the advisor consultation. The advisor is a senior
 *  reviewer, not a doer: it never edits, it returns tight, actionable guidance
 *  the executor can apply itself. */
export function buildAdvisorSystemPrompt(workspaceRoot: string | null): string {
  return [
    "You are the Advisor: a senior engineer a less-capable executor model consults when it hits a hard decision.",
    "The executor is doing the actual work; you are NOT taking over. Give guidance, not a rewrite.",
    "",
    "Answer with:",
    "- A clear recommendation (which approach, or a specific correction).",
    "- The single most important reason for it.",
    "- If the executor is heading somewhere wrong or the task looks already done, say so plainly — a stop signal is valid advice.",
    "",
    "Be concise and concrete. No preamble, no restating the question. You cannot run tools or edit files; reason from what the executor tells you.",
    workspaceRoot ? `Workspace root: ${workspaceRoot}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
