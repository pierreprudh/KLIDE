/**
 * The reasoning-effort vocabulary — one owner for how a level reads.
 *
 * *Which* levels exist for a provider+model is not a frontend fact: Rust
 * answers it (`ai_model_reflection_levels`), reading the Codex CLI's own model
 * manifest for a Codex run and the provider registry for a Klide-wire run. The
 * sets genuinely differ — `gpt-6-astra` takes low…ultra and has no `minimal` —
 * so a hardcoded five-item picker offers levels the model will reject and
 * hides the ones it has. This module only turns a level into a caption and
 * into a bar count for the effort glyph.
 */

/** Weakest to strongest, across every set Klide can be handed. */
const ORDER = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

const CAPTIONS: Record<string, string> = {
  minimal: "Smallest reasoning effort",
  low: "Fast, lighter reasoning",
  medium: "Balances speed and depth",
  high: "Greater depth for complex problems",
  xhigh: "Extra depth for complex problems",
  max: "Maximum depth for the hardest problems",
  ultra: "Maximum depth, with task delegation",
};

export function reflectionCaption(level: string): string {
  return CAPTIONS[level] ?? "Reasoning effort";
}

/**
 * The effort glyph draws five bars, so a level has to be placed *within its
 * own set* rather than counted off a fixed list: `medium` is the middle of a
 * six-level Codex model and the top third of a Klide-wire one, and the bars
 * should say so either way. Level 0 is Auto (all bars at rest).
 */
export function reflectionBarLevel(
  level: string | undefined,
  available: readonly string[],
): number {
  if (!level) return 0;
  const idx = available.indexOf(level);
  if (idx < 0) return 0;
  return Math.max(1, Math.round(((idx + 1) / available.length) * 5));
}

/** Sort a set into the canonical order; unknown names keep their given order
 *  at the end, so a level Klide has never seen still reaches the picker. */
export function sortReflectionLevels(levels: readonly string[]): string[] {
  const rank = (l: string) => {
    const i = ORDER.indexOf(l as (typeof ORDER)[number]);
    return i < 0 ? ORDER.length : i;
  };
  return [...levels].sort((a, b) => rank(a) - rank(b));
}
