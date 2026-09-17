// How a skill looks when you type it — chosen per skill, in the Skills panel.
//
// A skill invocation is text (`/visualise draw the flow`), and the composer
// draws that leading command as a lede: the skill's name in the accent with a
// mark (see components/ai/skillToken.ts). Which skills get that treatment, what
// each one is called, and which mark it draws are a matter of taste, so they
// are not hard-coded — they live here, per skill, saved.
//
// Keyed by the skill's `/` command rather than its id: a filesystem skill is
// re-read from disk on every launch, and the command is what the composer
// matches anyway. `visualise` ships with a lede so the feature is on out of the
// box; anything else is off until you turn it on, because a lede is a claim
// that a run will follow the skill and only you know which of thirty installed
// skills you actually reach for.
//
// The pure half (defaults, merge, which skills are wired) is separate from the
// stored half so the resolution can be tested without storage, and so the two
// composers take a resolved map rather than reading a store from inside a
// render.

import { useSyncExternalStore } from "react";
import { createPersistedStore, validatedArray } from "./persistedStore";
import { skillSlashName, type Skill } from "./skills";

/** The marks a skill may draw, in picker order. Names from the app's one icon
 *  vocabulary — a skill never gets a private glyph. */
export const SKILL_MARKS = [
  "diagram",
  "document",
  "plan",
  "review",
  "skills",
  "ai",
  "ask",
  "memory",
  "git",
  "terminal",
  "search",
  "code",
] as const;
export type SkillMark = typeof SKILL_MARKS[number];

export const DEFAULT_MARK: SkillMark = "skills";

/** What a skill's lede reads and draws. */
export type SkillLede = { label: string; mark: SkillMark };

/** One skill's saved appearance. `lede: false` is a real answer — it turns a
 *  shipped default off — so an absent record and a stored `false` differ. */
export type SkillAppearance = SkillLede & { command: string; lede: boolean };

/** The skills that ship wired, and how. */
const SHIPPED: Record<string, SkillLede> = {
  visualise: { label: "Visualise", mark: "diagram" },
  visualize: { label: "Visualize", mark: "diagram" },
};

/** A skill's name, set as a name: `visualise` → "Visualise", `code-review` →
 *  "Code review". A name that already carries capitals is left alone — the
 *  author wrote it that way. */
export function defaultLabel(name: string): string {
  const words = name.trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (!words) return words;
  if (/[A-Z]/.test(words)) return words;
  return words[0].toUpperCase() + words.slice(1);
}

function isAppearance(value: unknown): value is SkillAppearance {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.command === "string" &&
    v.command.length > 0 &&
    typeof v.label === "string" &&
    typeof v.lede === "boolean" &&
    SKILL_MARKS.includes(v.mark as SkillMark)
  );
}

const store = createPersistedStore<SkillAppearance[]>({
  key: "klide.skillAppearance",
  validate: (parsed) => validatedArray(parsed, isAppearance),
});

/** One skill's appearance, saved answer over shipped default over plain
 *  fallback. Always returns something drawable — `lede` says whether the
 *  composer draws it. */
export function appearanceOf(skill: Skill, saved: readonly SkillAppearance[]): SkillAppearance {
  const command = skillSlashName(skill.name);
  const stored = saved.find((a) => a.command === command);
  if (stored) return stored;
  const shipped = SHIPPED[command];
  return {
    command,
    label: shipped?.label ?? defaultLabel(skill.name),
    mark: shipped?.mark ?? DEFAULT_MARK,
    lede: !!shipped,
  };
}

/** The wired skills, by command — what a composer hands `skillTokenOf`.
 *
 *  A disabled skill is left out however it is configured: its instructions
 *  aren't in the prompt, so a lede would promise what the run can't keep. */
export function skillLedes(
  skills: readonly Skill[],
  saved: readonly SkillAppearance[],
): Map<string, SkillLede> {
  const out = new Map<string, SkillLede>();
  for (const skill of skills) {
    if (!skill.enabled) continue;
    const a = appearanceOf(skill, saved);
    if (!a.lede || !a.command || out.has(a.command)) continue;
    out.set(a.command, { label: a.label.trim() || defaultLabel(skill.name), mark: a.mark });
  }
  return out;
}

export function savedAppearances(): SkillAppearance[] {
  return store.get();
}

/** Save one skill's appearance. A command's record is replaced whole, so the
 *  panel always writes a complete answer rather than a patch nobody can read
 *  back. */
export function saveAppearance(next: SkillAppearance): void {
  store.mutate((current) => [...current.filter((a) => a.command !== next.command), next]);
}

/** Drop a skill's saved answer, so it falls back to its default again. */
export function resetAppearance(command: string): void {
  store.mutate((current) => current.filter((a) => a.command !== command));
}

/** The saved appearances, re-rendering the caller when any of them change. */
export function useSkillAppearances(): SkillAppearance[] {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
