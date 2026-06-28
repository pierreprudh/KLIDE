import { useMemo, useState, type ReactNode } from "react";
import { diffLines } from "diff";

export type PendingEdit = {
  path: string;
  oldContent: string;
  newContent: string;
  isCreate: boolean;
  /** Optional advisory note from the harness (e.g. a staleness warning when
   *  the file changed since the agent last read it). Shown as a banner. */
  reason?: string;
};

type Props = {
  edit: PendingEdit;
  onApply: () => void;
  onReject: () => void;
  /** Open the full side-by-side diff in the Monaco editor. When provided, the
   *  ⤢ action opens there (syntax-highlighted); the inline hunk peek stays
   *  available by clicking the filename. Without it, ⤢ toggles the inline diff. */
  onOpenChanges?: () => void;
};

type Row =
  | { kind: "context"; no: number; text: string }
  | { kind: "del"; no: number; text: string }
  | { kind: "add"; no: number; text: string }
  | { kind: "gap"; hidden: number };

/** Turn two file versions into Claude-Code-style hunk rows: changed lines
 *  (red −, green +) surrounded by a few lines of unchanged context, with long
 *  unchanged runs collapsed into a "⋯ N unchanged" gap. Line numbers follow the
 *  new file (old file for deletions), matching the gutter in Claude Code. */
function buildRows(oldContent: string, newContent: string, context = 3): { rows: Row[]; added: number; removed: number } {
  const changes = diffLines(oldContent, newContent);
  const flat: Exclude<Row, { kind: "gap" }>[] = [];
  let oldNo = 1;
  let newNo = 1;
  let added = 0;
  let removed = 0;
  for (const c of changes) {
    const lines = c.value.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    for (const text of lines) {
      if (c.added) {
        flat.push({ kind: "add", no: newNo++, text });
        added++;
      } else if (c.removed) {
        flat.push({ kind: "del", no: oldNo++, text });
        removed++;
      } else {
        flat.push({ kind: "context", no: newNo, text });
        oldNo++;
        newNo++;
      }
    }
  }

  const keep = new Array(flat.length).fill(false);
  flat.forEach((r, i) => {
    if (r.kind === "add" || r.kind === "del") {
      for (let j = Math.max(0, i - context); j <= Math.min(flat.length - 1, i + context); j++) {
        keep[j] = true;
      }
    }
  });

  const rows: Row[] = [];
  let hidden = 0;
  for (let i = 0; i < flat.length; i++) {
    if (keep[i]) {
      if (hidden > 0) {
        rows.push({ kind: "gap", hidden });
        hidden = 0;
      }
      rows.push(flat[i]);
    } else {
      hidden++;
    }
  }
  if (hidden > 0) rows.push({ kind: "gap", hidden });
  return { rows, added, removed };
}

/** A bare icon action — no container, just the glyph, coloring on hover. The
 *  ✗ / ✓ / open-changes controls on the folded pill. */
function BareAction({
  label,
  tone,
  onClick,
  children,
}: {
  label: string;
  tone: "danger" | "accent" | "neutral";
  onClick: () => void;
  children: ReactNode;
}) {
  const hoverFg = tone === "danger" ? "var(--diff-remove)" : tone === "accent" ? "var(--accent)" : "var(--fg-strong)";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      style={{
        flexShrink: 0,
        width: 20,
        height: 20,
        display: "grid",
        placeItems: "center",
        padding: 0,
        border: "none",
        background: "transparent",
        color: "var(--fg-subtle)",
        cursor: "pointer",
        transition: "color var(--motion-fast) var(--ease-out)",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.color = hoverFg)}
      onMouseLeave={(e) => (e.currentTarget.style.color = "var(--fg-subtle)")}
    >
      {children}
    </button>
  );
}

/** File edit / creation review as a single premium pill — filename on the left,
 *  ✗ cancel / ✓ validate / ⤢ open-changes on the right (the Image-#4 sketch).
 *  Folded by default; "open changes" expands the description + line-numbered
 *  diff in place. Lives inline under the message that proposed the edit. */
export function InlineDiffReview({ edit, onApply, onReject, onOpenChanges }: Props) {
  const { rows, added, removed } = useMemo(
    () => buildRows(edit.oldContent, edit.newContent),
    [edit.oldContent, edit.newContent]
  );
  const [expanded, setExpanded] = useState(false);

  const gutter = useMemo(() => {
    const max = rows.reduce((m, r) => (r.kind === "gap" ? m : Math.max(m, r.no)), 0);
    return String(max).length;
  }, [rows]);

  const plural = (n: number) => (n === 1 ? "" : "s");

  return (
    <div
      className="ai-qa-card"
      style={{
        marginBottom: 8,
        padding: expanded ? "8px 10px 10px" : "7px 10px",
        borderRadius: 6,
        border: "1px solid color-mix(in srgb, var(--accent) 28%, var(--border))",
        background: "color-mix(in srgb, var(--bg-elevated) 90%, transparent)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {/* folded one-line pill */}
      <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
        <span aria-hidden="true" style={{ flexShrink: 0, display: "grid", placeItems: "center", color: "var(--accent)" }}>
          {edit.isCreate ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
              <path d="M12 18v-6" />
              <path d="M9 15h6" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          )}
        </span>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          title={`${edit.path} — click to ${expanded ? "hide" : "peek at"} the inline diff`}
          style={{
            flex: 1,
            minWidth: 0,
            padding: 0,
            border: "none",
            background: "transparent",
            cursor: "pointer",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            color: "var(--fg-strong)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            direction: "rtl",
            textAlign: "left",
            letterSpacing: "-0.01em",
          }}
        >
          {edit.path}
        </button>
        <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 600, display: "flex", gap: 6 }}>
          <span style={{ color: "var(--diff-add)" }}>+{added}</span>
          <span style={{ color: "var(--diff-remove)" }}>−{removed}</span>
        </span>
        <span style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 4, marginLeft: 2 }}>
          <BareAction label="Cancel" tone="danger" onClick={onReject}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </BareAction>
          <BareAction label="Validate" tone="accent" onClick={onApply}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </BareAction>
          <BareAction
            label={onOpenChanges ? "Open changes in editor" : expanded ? "Hide changes" : "Open changes"}
            tone="neutral"
            onClick={() => { if (onOpenChanges) onOpenChanges(); else setExpanded((v) => !v); }}
          >
            {onOpenChanges || !expanded ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />
              </svg>
            )}
          </BareAction>
        </span>
      </div>

      {expanded && (
        <div style={{ display: "flex", alignItems: "center", gap: 5, paddingLeft: 4, fontSize: 11, color: "var(--fg-subtle)" }}>
          <span aria-hidden="true">└</span>
          <span>
            {edit.isCreate ? (
              <>
                New file, <span style={{ color: "var(--diff-add)", fontWeight: 600 }}>{added}</span> line{plural(added)}
              </>
            ) : (
              <>
                Added <span style={{ color: "var(--diff-add)", fontWeight: 600 }}>{added}</span> line{plural(added)}, removed{" "}
                <span style={{ color: "var(--diff-remove)", fontWeight: 600 }}>{removed}</span> line{plural(removed)}
              </>
            )}
          </span>
        </div>
      )}

      {expanded && edit.reason && (
        <div
          style={{
            padding: "7px 9px",
            borderRadius: "var(--radius-sm)",
            background: "color-mix(in srgb, var(--warning) 13%, transparent)",
            color: "var(--fg-strong)",
            fontSize: 11.5,
            lineHeight: 1.4,
          }}
        >
          {edit.reason}
        </div>
      )}

      {expanded && (
        <div
          style={{
            maxHeight: 260,
            overflow: "auto",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--border)",
            background: "var(--bg)",
            padding: "6px 0",
            fontFamily: "var(--font-mono)",
            fontSize: 11.5,
            lineHeight: 1.5,
          }}
        >
          {rows.map((r, i) => {
            if (r.kind === "gap") {
              return (
                <div key={i} style={{ padding: "1px 12px", color: "var(--fg-dim)", fontStyle: "italic", userSelect: "none" }}>
                  ⋯ {r.hidden} unchanged line{plural(r.hidden)}
                </div>
              );
            }
            const bg = r.kind === "add" ? "color-mix(in srgb, var(--diff-add) 13%, transparent)" : r.kind === "del" ? "color-mix(in srgb, var(--diff-remove) 13%, transparent)" : "transparent";
            const marker = r.kind === "add" ? "+" : r.kind === "del" ? "−" : " ";
            const markerColor = r.kind === "add" ? "var(--diff-add)" : r.kind === "del" ? "var(--diff-remove)" : "var(--fg-dim)";
            return (
              <div key={i} style={{ display: "flex", background: bg, whiteSpace: "pre" }}>
                <span
                  style={{
                    flexShrink: 0,
                    width: `${gutter}ch`,
                    textAlign: "right",
                    paddingLeft: 10,
                    color: r.kind === "context" ? "var(--fg-dim)" : markerColor,
                    userSelect: "none",
                  }}
                >
                  {r.no}
                </span>
                <span style={{ flexShrink: 0, width: 18, textAlign: "center", color: markerColor, userSelect: "none" }}>{marker}</span>
                <span style={{ color: "var(--fg-strong)", paddingRight: 12 }}>{r.text || " "}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
