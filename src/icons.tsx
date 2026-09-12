// icons — Klide's icon vocabulary, defined once.
//
// The app used to draw two rails, and each kept a private copy of every glyph —
// two Memory icons, two Orchestrators, two Mission Controls, drawn slightly
// differently and at slightly different stroke widths. Changing one changed one
// rail, which is exactly the bug that sent us looking for the dev server. (The
// rails themselves are one component now — see WorkspaceRail — but the rule
// outlives them: any surface can ask for a mark, none of them owns one.)
//
// So: one name, one drawing, one weight. A caller decides *density* (it passes
// a size); it never decides what a thing looks like.
//
// The set underneath is Phosphor, which ships weight as a variant rather than
// a tunable prop — a "light" glyph is a different set of filled outlines, not
// a thinner stroke. ICON_WEIGHT below is the single lever; changing that line
// re-weights the app.
//
// Glyphs come from `@phosphor-icons/react/dist/csr/<Name>` rather than the
// package root: the root barrel re-exports ~9,000 components, which Vite has
// to walk on every cold dev start. The per-icon path skips that and tree-shakes
// the same way in a production build.

import type { CSSProperties } from "react";
import type { Icon as PhosphorGlyph } from "@phosphor-icons/react";

import { ArrowUp } from "@phosphor-icons/react/dist/csr/ArrowUp";
import { BookmarkSimple } from "@phosphor-icons/react/dist/csr/BookmarkSimple";
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { Cards } from "@phosphor-icons/react/dist/csr/Cards";
import { FileText } from "@phosphor-icons/react/dist/csr/FileText";
import { ChatTeardrop } from "@phosphor-icons/react/dist/csr/ChatTeardrop";
import { ChatTeardropDots } from "@phosphor-icons/react/dist/csr/ChatTeardropDots";
import { FileMagnifyingGlass } from "@phosphor-icons/react/dist/csr/FileMagnifyingGlass";
import { CirclesThree } from "@phosphor-icons/react/dist/csr/CirclesThree";
import { FlowArrow } from "@phosphor-icons/react/dist/csr/FlowArrow";
import { ListChecks } from "@phosphor-icons/react/dist/csr/ListChecks";
import { Folder } from "@phosphor-icons/react/dist/csr/Folder";
import { FolderOpen } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { Gear } from "@phosphor-icons/react/dist/csr/Gear";
import { GitBranch } from "@phosphor-icons/react/dist/csr/GitBranch";
import { House } from "@phosphor-icons/react/dist/csr/House";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { Paperclip } from "@phosphor-icons/react/dist/csr/Paperclip";
import { PuzzlePiece } from "@phosphor-icons/react/dist/csr/PuzzlePiece";
import { Rectangle } from "@phosphor-icons/react/dist/csr/Rectangle";
import { Terminal } from "@phosphor-icons/react/dist/csr/Terminal";
import { Trash } from "@phosphor-icons/react/dist/csr/Trash";
import { User } from "@phosphor-icons/react/dist/csr/User";
import { X } from "@phosphor-icons/react/dist/csr/X";

/** The one weight Klide draws at. Changing this line re-weights the app. */
export const ICON_WEIGHT = "light" as const;

/** Free-mode rail density. Focus's rail runs tighter and passes its own. */
export const RAIL_ICON_SIZE = 18;

export type GlyphProps = {
  size?: number;
  className?: string;
  style?: CSSProperties;
};

/** The primitive. Nothing outside this file names a weight. */
export function Icon({
  as: Glyph,
  size = RAIL_ICON_SIZE,
  ...rest
}: GlyphProps & { as: PhosphorGlyph }) {
  return <Glyph size={size} weight={ICON_WEIGHT} aria-hidden="true" {...rest} />;
}

/* ------------------------------------------------------- rail destinations */

export function HomeIcon(p: GlyphProps) {
  return <Icon as={House} {...p} />;
}

export function SearchIcon(p: GlyphProps) {
  return <Icon as={MagnifyingGlass} {...p} />;
}

export function FolderOpenIcon(p: GlyphProps) {
  return <Icon as={FolderOpen} {...p} />;
}

export function FolderIcon(p: GlyphProps) {
  return <Icon as={Folder} {...p} />;
}

/** The AI panel — a conversation with Kit, so it gets a speech mark rather
 *  than a sparkle. Two reasons beyond taste: a sparkle is the universal "AI"
 *  cliché, and Phosphor's is an outlined four-point star, which is AgentMark
 *  (filled, accent) drawn a second way for a different meaning. */
export function AiIcon(p: GlyphProps) {
  return <Icon as={ChatTeardrop} {...p} />;
}

/** The evidence a finished run left behind — the changed files, the commands
 *  it ran. A file under a lens rather than a checklist: the run already has a
 *  plan mark, and this one means "look at what came out", not "track it". */
export function ReviewIcon(p: GlyphProps) {
  return <Icon as={FileMagnifyingGlass} {...p} />;
}

/** A document a run produced — a page, not a page under a magnifier: the
 *  reader is opening it to read, not to review a change to it. */
export function DocumentIcon(p: GlyphProps) {
  return <Icon as={FileText} {...p} />;
}

/** Kit asking *you* something — the run is parked on an answer. The same
 *  teardrop as AiIcon with its dots showing: one family, so the mark reads as
 *  "the conversation is speaking", not as a second, unrelated glyph. */
export function AskIcon(p: GlyphProps) {
  return <Icon as={ChatTeardropDots} {...p} />;
}

/** Git — the panel in free mode, a branch label in Focus. Same mark either
 *  way, which is the point of naming it once. */
export function GitIcon(p: GlyphProps) {
  return <Icon as={GitBranch} {...p} />;
}

export function SkillsIcon(p: GlyphProps) {
  return <Icon as={PuzzlePiece} {...p} />;
}

/** Memory — a bookmark rather than a notebook, because the AI panel's
 *  "Summarize" action (the one thing that *writes* a memory note) is already
 *  a bookmark. One mark for the writing end and the reading end. */
export function MemoryIcon(p: GlyphProps) {
  return <Icon as={BookmarkSimple} {...p} />;
}

/** Mission Control — three bodies in one frame: "many runs, one board". */
export function MissionIcon(p: GlyphProps) {
  return <Icon as={CirclesThree} {...p} />;
}

export function OrchestratorIcon(p: GlyphProps) {
  return <Icon as={FlowArrow} {...p} />;
}

export function SettingsIcon(p: GlyphProps) {
  return <Icon as={Gear} {...p} />;
}

/** Profile — the glyph plus a live status dot. The dot is drawn here rather
 *  than sourced from the set: it carries state (the local profile resolved),
 *  so it belongs to the destination, not to a glyph. */
export function ProfileIcon({ size = RAIL_ICON_SIZE, ...rest }: GlyphProps) {
  const dot = Math.max(5, Math.round(size * 0.3));
  return (
    <span style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
      <Icon as={User} size={size} {...rest} />
      <span
        style={{
          position: "absolute",
          right: -1,
          bottom: -1,
          width: dot,
          height: dot,
          borderRadius: "50%",
          background: "var(--success)",
          outline: "1.5px solid var(--bg-elevated)",
        }}
      />
    </span>
  );
}

/* ------------------------------------------------------------ rail chrome */

/** The rail's primary action, so it gets the simplest mark in the set: a bare
 *  plus. The glyphs under it describe a place; this one only has to say
 *  "begin", and a pencil said "edit something that already exists". */
/** The agent's plan — the todo list a Goal run works through. */
export function PlanIcon(p: GlyphProps) {
  return <Icon as={ListChecks} {...p} />;
}

export function NewTaskIcon(p: GlyphProps) {
  return <Icon as={Plus} {...p} />;
}

export function CloseIcon(p: GlyphProps) {
  return <Icon as={X} {...p} />;
}

/** Removing something for good — a conversation from local history. Distinct
 *  from CloseIcon on purpose: an X on a row reads as "put this away", and the
 *  row it sits on does not come back. */
export function DeleteIcon(p: GlyphProps) {
  return <Icon as={Trash} {...p} />;
}

/** Attaching a photo or a document to a turn. */
export function AttachIcon(p: GlyphProps) {
  return <Icon as={Paperclip} {...p} />;
}

export function SendIcon(p: GlyphProps) {
  return <Icon as={ArrowUp} {...p} />;
}

/** A prompt caret — the terminal reduced to the one mark that means "shell". */
export function TerminalIcon(p: GlyphProps) {
  return <Icon as={Terminal} {...p} />;
}

/** Focus's layout mark: one centered reading column. */
export function FocusLayoutIcon(p: GlyphProps) {
  return <Icon as={Rectangle} {...p} />;
}

/** Free layout's mark: two offset panels, the mirror of FocusLayoutIcon. */
export function FreeLayoutIcon(p: GlyphProps) {
  return <Icon as={Cards} {...p} />;
}

/** The sidebar itself, as a control. The outer window remains one shape while
 *  the pane retracts and its divider becomes a short handle, so toggling reads
 *  as one object changing state rather than two unrelated icons cross-fading. */
export function SidebarIcon({
  size = RAIL_ICON_SIZE,
  className,
  style,
  collapsed = false,
}: GlyphProps & { collapsed?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      className={`klide-sidebar-icon${className ? ` ${className}` : ""}`}
      data-collapsed={collapsed || undefined}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      <rect
        className="klide-sidebar-icon-pane"
        x="3.5"
        y="4.5"
        width="4.25"
        height="11"
        rx="1.4"
        fill="currentColor"
      />
      <rect
        className="klide-sidebar-icon-frame"
        x="2.5"
        y="3.25"
        width="15"
        height="13.5"
        rx="2.75"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        className="klide-sidebar-icon-divider"
        d="M7.75 4.25V15.75"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Disclosure. `open` rotates it rather than swapping in a second glyph, so
 *  the motion reads as one control turning. */
export function ChevronIcon({ open = false, style, ...rest }: GlyphProps & { open?: boolean }) {
  return (
    <Icon
      as={CaretDown}
      style={{
        transform: open ? "rotate(180deg)" : "none",
        transition: "transform var(--motion-med) var(--ease-soft)",
        ...style,
      }}
      {...rest}
    />
  );
}
