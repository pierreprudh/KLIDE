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
// testable — the geometry lives in SkillToken.tsx, the wiring in the two
// composers.
//
// Only skills named here are wired, and only when the skill is actually
// installed and enabled: a lede for a skill the run would not follow would
// promise something the send can't keep. Everything else stays plain text.

import { skillSlashName, type Skill } from "../../skills";

/** Which mark a wired skill draws. A key, not a glyph — this module stays
 *  free of React so it can be tested on its own. */
export type SkillTokenIcon = "diagram";

export type SkillToken = {
  /** The `/` command, as typed: `visualise`. */
  command: string;
  /** What the lede reads: the skill's name, set as a name. */
  label: string;
  icon: SkillTokenIcon;
  /** The exact text the lede stands in for, trailing space included. */
  prefix: string;
};

/** The wired skills. One for now — the shape is the point, not the count. */
const WIRED: Record<string, { label: string; icon: SkillTokenIcon }> = {
  visualise: { label: "Visualise", icon: "diagram" },
  visualize: { label: "Visualize", icon: "diagram" },
};

/** A draft's leading skill command, or null.
 *
 *  The space is load-bearing. `/visu` and `/visualise` (no space) are still
 *  being typed — the `/` menu is open on them and needs its own text visible —
 *  so a token appears only once the command is closed by a space, which is
 *  exactly what accepting the menu entry leaves behind. */
export function skillTokenOf(value: string, skills: readonly Skill[]): SkillToken | null {
  const m = value.match(/^\/([\w-]+) /);
  if (!m) return null;
  const command = m[1].toLowerCase();
  const wired = WIRED[command];
  if (!wired) return null;
  const installed = skills.some((s) => s.enabled && skillSlashName(s.name) === command);
  if (!installed) return null;
  return { command, label: wired.label, icon: wired.icon, prefix: m[0] };
}

/** The draft as the composer shows it: the lede, and the text the textarea
 *  holds. `body` is the draft verbatim when nothing is wired. */
export function splitSkillToken(
  value: string,
  skills: readonly Skill[],
): { token: SkillToken | null; body: string } {
  const token = skillTokenOf(value, skills);
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
