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


/** One run of the draft, and whether it is a skill command.
 *  `ComposerHighlight` draws these; nothing else needs them. */
export type DraftSpan = {
  text: string;
  skill: boolean;
  /** The glyph to draw after this command, when it has one and there is room
   *  for it. Null on every other span. */
  mark?: SkillMark | null;
};

/** The draft cut into runs, with every wired command marked.
 *
 *  The same rule `skillTokenOf` applies at the head, applied everywhere: a
 *  command starts a word, a space closes it, and only a wired skill counts.
 *  A command still being typed — `/visu`, with the `/` menu open on it — is
 *  not yet closed and stays plain, so the accent arrives when the command
 *  does and nothing flickers underneath the caret.
 *
 *  A mark rides along only where nothing follows the command. The drawing
 *  behind the textarea has to stay glyph-for-glyph with the text inside it,
 *  and a mark is wider than the nothing the textarea laid out in its place —
 *  drawn mid-sentence it would push the rest of the line out of line with the
 *  real one. At the end of the draft the room to its right is empty, so it
 *  costs nothing, which is also the moment you have just picked the skill. */
export function draftSpans(value: string, ledes: SkillLedes): DraftSpan[] {
  const spans: DraftSpan[] = [];
  let at = 0;
  const re = /(^|\s)\/([\w-]+)(?=\s)/g;
  for (let m = re.exec(value); m !== null; m = re.exec(value)) {
    const lede = ledes.get(m[2].toLowerCase());
    if (!lede) continue;
    const start = m.index + m[1].length;
    if (start > at) spans.push({ text: value.slice(at, start), skill: false });
    at = start + m[2].length + 1;
    spans.push({ text: value.slice(start, at), skill: true, mark: value.slice(at).trim() === "" ? lede.mark : null });
  }
  if (at < value.length) spans.push({ text: value.slice(at), skill: false });
  return spans;
}
