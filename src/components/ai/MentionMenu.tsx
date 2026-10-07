// The `@` listbox both composers float above their textarea — the sibling of
// SlashMenu. Subagents first (only offered when the `@` opens the message),
// then workspace files. A host owns the query, the file list and the caret;
// this draws the rows and reports hover and acceptance by absolute index.

import type { Subagent } from "../../agent/subagents";

const heading = {
  padding: "4px 8px 2px",
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--fg-dim)",
  userSelect: "none",
} as const;

export function MentionMenu({
  subagents,
  files,
  activeIdx,
  onHover,
  onAccept,
  maxHeight = 220,
}: {
  subagents: readonly Subagent[];
  files: readonly string[];
  activeIdx: number;
  onHover: (idx: number) => void;
  /** Absolute index: subagents occupy `0…subagents.length-1`, files follow. */
  onAccept: (idx: number) => void;
  maxHeight?: number;
}) {
  if (subagents.length + files.length === 0) return null;
  const row = (active: boolean) => ({
    display: "flex",
    alignItems: "baseline",
    gap: 6,
    padding: "5px 8px",
    borderRadius: "var(--radius-sm)",
    fontSize: 12,
    cursor: "pointer",
    background: active ? "var(--bg-hover)" : "transparent",
    whiteSpace: "nowrap",
    overflow: "hidden",
  } as const);
  return (
    <div
      role="listbox"
      aria-label="Mentions"
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
      {subagents.length > 0 && <div style={heading}>Subagents</div>}
      {subagents.map((sub, i) => (
        <div
          key={sub.id}
          role="option"
          aria-selected={i === activeIdx}
          // mousedown, not click: the textarea keeps focus, so its onBlur
          // (which closes the menu) never fires before the row is taken.
          onMouseDown={(e) => { e.preventDefault(); onAccept(i); }}
          onMouseEnter={() => onHover(i)}
          style={row(i === activeIdx)}
        >
          <span style={{ color: "var(--fg-strong)", fontWeight: 500 }}>@{sub.label}</span>
          <span style={{ color: "var(--fg-dim)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis" }}>{sub.blurb}</span>
        </div>
      ))}
      {files.length > 0 && subagents.length > 0 && <div style={{ ...heading, paddingTop: 6 }}>Files</div>}
      {files.map((path, idx) => {
        const absIdx = subagents.length + idx;
        const cut = path.lastIndexOf("/");
        const dir = cut >= 0 ? path.slice(0, cut + 1) : "";
        const base = cut >= 0 ? path.slice(cut + 1) : path;
        return (
          <div
            key={path}
            role="option"
            aria-selected={absIdx === activeIdx}
            onMouseDown={(e) => { e.preventDefault(); onAccept(absIdx); }}
            onMouseEnter={() => onHover(absIdx)}
            style={{ ...row(absIdx === activeIdx), gap: 2 }}
          >
            <span style={{ color: "var(--fg-strong)" }}>{base}</span>
            <span style={{ color: "var(--fg-dim)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis" }}>{dir && ` ${dir}`}</span>
          </div>
        );
      })}
    </div>
  );
}
