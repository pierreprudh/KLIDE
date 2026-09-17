// The `/` command listbox both composers float above their textarea. Same
// card, same rows, same hover/keyboard highlight — a host only decides where
// its `position: relative` anchor is and what each command does.
//
// A Skill's row reads as the skill: its name in the accent with its mark, the
// same drawing the composer's lede makes once the command is typed (see
// skillToken.ts). Colour is how a skill is spelled in Klide, and the menu is
// the first place you meet one — a row that looked like `/plan` would make the
// two kinds of command look like one kind.

import { SkillMarkGlyph } from "./skillMarks";
import type { SkillLedes } from "./skillToken";
import type { SlashCommand } from "./slashCommands";

export function SlashMenu({
  matches,
  activeIdx,
  onHover,
  onAccept,
  maxHeight = 240,
  ledes,
}: {
  matches: readonly Pick<SlashCommand, "name" | "desc">[];
  activeIdx: number;
  onHover: (idx: number) => void;
  onAccept: (idx: number) => void;
  maxHeight?: number;
  /** The wired Skills, by command — the rows that draw as skills. A host that
   *  passes nothing gets the plain vocabulary. */
  ledes?: SkillLedes;
}) {
  if (matches.length === 0) return null;
  return (
    <div
      role="listbox"
      aria-label="Slash commands"
      style={{
        position: "absolute",
        bottom: "calc(100% + 6px)",
        left: 0,
        right: 0,
        maxHeight,
        overflowY: "auto",
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-strong)",
        borderRadius: "var(--radius-md)",
        boxShadow: "0 6px 24px rgba(38, 38, 32, 0.14)",
        padding: 4,
        zIndex: 20,
      }}
    >
      {matches.map((cmd, idx) => {
        const lede = ledes?.get(cmd.name);
        return (
        <div
          key={cmd.name}
          role="option"
          aria-selected={idx === activeIdx}
          // mousedown, not click: the textarea keeps focus, so its onBlur
          // (which closes the menu) never fires before the command runs.
          onMouseDown={(e) => { e.preventDefault(); onAccept(idx); }}
          onMouseEnter={() => onHover(idx)}
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 8,
            padding: "6px 8px",
            borderRadius: "var(--radius-sm)",
            cursor: "pointer",
            background: idx === activeIdx ? "var(--bg-hover)" : "transparent",
          }}
        >
          {lede ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--accent)", fontSize: 12, fontWeight: 500, whiteSpace: "nowrap" }}>
              {lede.label}
              {lede.mark && <SkillMarkGlyph mark={lede.mark} size={13} />}
            </span>
          ) : (
            <span style={{ color: "var(--fg-strong)", fontSize: 12, fontWeight: 500 }}>/{cmd.name}</span>
          )}
          <span style={{ color: "var(--fg-dim)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cmd.desc}</span>
        </div>
        );
      })}
    </div>
  );
}
