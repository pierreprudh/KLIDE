// The marks a skill's lede can draw, one place.
//
// Both surfaces that show a mark read this map: the composer's lede and the
// Skills panel's picker, which is the only way to keep the preview honest —
// the picker shows the same drawing the composer will.

import type { ReactElement } from "react";
import {
  AiIcon,
  AskIcon,
  CodeIcon,
  DiagramIcon,
  DocumentIcon,
  GitIcon,
  MemoryIcon,
  PlanIcon,
  ReviewIcon,
  SearchIcon,
  SkillsIcon,
  TerminalIcon,
  type GlyphProps,
} from "../../icons";
import type { SkillMark } from "../../skillAppearance";

const GLYPHS: Record<SkillMark, (p: GlyphProps) => ReactElement> = {
  diagram: DiagramIcon,
  document: DocumentIcon,
  plan: PlanIcon,
  review: ReviewIcon,
  skills: SkillsIcon,
  ai: AiIcon,
  ask: AskIcon,
  memory: MemoryIcon,
  git: GitIcon,
  terminal: TerminalIcon,
  search: SearchIcon,
  code: CodeIcon,
};

/** What each mark is called, for the picker's tooltip. */
export const MARK_NAMES: Record<SkillMark, string> = {
  diagram: "Diagram",
  document: "Document",
  plan: "Plan",
  review: "Review",
  skills: "Skill",
  ai: "Conversation",
  ask: "Question",
  memory: "Memory",
  git: "Git",
  terminal: "Terminal",
  search: "Search",
  code: "Code",
};

export function SkillMarkGlyph({ mark, ...rest }: GlyphProps & { mark: SkillMark }) {
  const Glyph = GLYPHS[mark];
  return <Glyph {...rest} />;
}
