// A skill, typed in the composer, shown as itself.
//
// A skill invocation is already text: the message goes out as `/visualise draw
// the flow`, and the system prompt names each enabled skill's command, so the
// model reads the leading word as the instruction (see `enabledSkillsPrompt`).
// That is the whole mechanism and this module does not change it — what it
// changes is what *you* see while typing. A wired command stops reading as a
// slash and starts reading as the skill: its name, in the accent, with its
// mark.
//
// So there is no second state to keep. The draft still holds `/visualise `;
// the composer renders the remainder and draws the prefix as a lede. Splitting
// and rejoining is this module's only job, which is why it is pure and
// testable — the geometry lives in SkillTokenLede.tsx, the taste (which skills
// are wired, what they are called, which mark they draw) in skillAppearance.ts,
// and the wiring in the two composers.
//
// Which skills are wired arrives as a map, resolved by the caller. A lede for a
// skill the run would not follow would promise what the send can't keep, and
// the module that knows what a run follows is not this one.

import type { SkillLede, SkillMark } from "../../skillAppearance";

/** The wired skills, by `/` command. `skillLedes` builds it. */
export type SkillLedes = ReadonlyMap<string, SkillLede>;

export type SkillToken = {
  /** The `/` command, as typed: `visualise`. */
  command: string;
  /** What the lede reads: the skill's name, set as a name. */
  label: string;
  /** The glyph after the name, when one was picked. */
  mark: SkillMark | null;
  /** The exact text the lede stands in for, trailing space included. */
  prefix: string;
};

/** A draft's leading skill command, or null.
 *
 *  The space is load-bearing. `/visu` and `/visualise` (no space) are still
 *  being typed — the `/` menu is open on them and needs its own text visible —
 *  so a token appears only once the command is closed by a space, which is
 *  exactly what accepting the menu entry leaves behind. */
export function skillTokenOf(value: string, ledes: SkillLedes): SkillToken | null {
  const m = value.match(/^\/([\w-]+) /);
  if (!m) return null;
  const command = m[1].toLowerCase();
  const lede = ledes.get(command);
  if (!lede) return null;
  return { command, label: lede.label, mark: lede.mark, prefix: m[0] };
}

/** The draft as the composer shows it: the lede, and the text the textarea
 *  holds. `body` is the draft verbatim when nothing is wired. */
export function splitSkillToken(
  value: string,
  ledes: SkillLedes,
): { token: SkillToken | null; body: string } {
  const token = skillTokenOf(value, ledes);
  return token ? { token, body: value.slice(token.prefix.length) } : { token: null, body: value };
}

/** The draft again, from a lede and an edited body — the inverse of the split,
 *  and what every keystroke rejoins before it reaches the composer's state. */
export function joinSkillToken(token: SkillToken | null, body: string): string {
  return token ? token.prefix + body : body;
}

/** Where the caret sits in the draft, given where it sits in the body. */
export function skillTokenCaret(token: SkillToken | null, caret: number): number {
  return token ? caret + token.prefix.length : caret;
}

