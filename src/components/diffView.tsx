// The one diff renderer — shared by the staging pane (GitReview) and the
// commit detail pane (GitHistoryGraph), so both read the same way.
//
// Modeled on what makes GitHub / Tower / Fork diffs digestible: dual
// line-number gutters, a separated sign column so code indentation aligns,
// word-level highlighting inside changed line pairs, collapsible per-file
// sections, and hunk gaps as quiet "···" bands instead of raw @@ noise.
// Each file is a hairline card: a code mark and the path over a number
// gutter split from the code by one rule, and a 3px edge marker per changed
// line — solid for added, hatched for removed.
//
// Line comments (Diff Comment → Agent): when a host passes `onLineComment`,
// clicking a line's number gutter selects it (⇧-click extends within the
// file) and an inline composer appears under the selection — the note plus
// its line anchor goes back to the host, which routes it to the running
// agent. A selected line's edge marker turns accent (selection, not state).

import { memo, useState, type ReactNode } from "react";
import { ChevronIcon, CodeIcon, OpenInEditorIcon } from "../icons";
import { gitStatusMark } from "../gitStatusMark";
import {
  commentFromBlocks,
  fileOfBlock,
  type DiffLineComment,
} from "../diffComments";

export type DiffBlock =
  | { kind: "file"; path: string }
  | { kind: "hunk"; text: string }
  | {
      kind: "line";
      /** Code without the leading +/-/space sign. */
      code: string;
      tone: "add" | "del" | "ctx";
      oldNo: number | null;
      newNo: number | null;
      /** Word-level changed span [start, end) within `code`. */
      hi?: [number, number];
    };

type DiffCodeBlock = Extract<DiffBlock, { kind: "line" }>;

const DIFF_META_RE =
  /^(index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|Binary files)/;

export function parseDiffBlocks(lines: string[]): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      const m = line.match(/ b\/(.+)$/);
      blocks.push({ kind: "file", path: m ? m[1] : line.slice("diff --git ".length) });
      continue;
    }
    if (DIFF_META_RE.test(line)) continue;
    if (line.startsWith("@@")) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldNo = Number(m[1]);
        newNo = Number(m[2]);
      }
      blocks.push({ kind: "hunk", text: line.replace(/^@@ .*? @@ ?/, "") });
      continue;
    }
    const tone = line.startsWith("+") ? "add" as const : line.startsWith("-") ? "del" as const : "ctx" as const;
    blocks.push({
      kind: "line",
      code: line.slice(1),
      tone,
      oldNo: tone === "add" ? null : oldNo++,
      newNo: tone === "del" ? null : newNo++,
    });
  }
  markInlineChanges(blocks);
  return blocks;
}

/** Tower-style word-level highlighting: when a run of removed lines is
 *  followed by an equally long run of added lines, each pair almost always
 *  differs in one span — mark it via common prefix/suffix so the eye lands
 *  on what actually changed. */
function markInlineChanges(blocks: DiffBlock[]): void {
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    if (b.kind !== "line" || b.tone !== "del") {
      i++;
      continue;
    }
    let delEnd = i;
    while (delEnd < blocks.length) {
      const d = blocks[delEnd];
      if (d.kind === "line" && d.tone === "del") delEnd++;
      else break;
    }
    let addEnd = delEnd;
    while (addEnd < blocks.length) {
      const a = blocks[addEnd];
      if (a.kind === "line" && a.tone === "add") addEnd++;
      else break;
    }
    if (delEnd - i === addEnd - delEnd) {
      for (let k = 0; k < delEnd - i; k++) {
        const del = blocks[i + k] as DiffCodeBlock;
        const add = blocks[delEnd + k] as DiffCodeBlock;
        const spans = changedSpan(del.code, add.code);
        if (spans) {
          del.hi = spans[0];
          add.hi = spans[1];
        }
      }
    }
    i = addEnd > i ? addEnd : i + 1;
  }
}

/** Common prefix/suffix trim: the changed middle of each side, or null when
 *  the lines are identical or share no shell at all (highlighting everything
 *  is the same as highlighting nothing). */
function changedSpan(a: string, b: string): [[number, number], [number, number]] | null {
  if (a === b) return null;
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && a[p] === b[p]) p++;
  let s = 0;
  while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  if (p === 0 && s === 0) return null;
  return [
    [p, a.length - s],
    [p, b.length - s],
  ];
}

/** File change status as a small stroke icon (Pierre: no bare letters) —
 *  plus/minus/arrow/dot, colored like GitReview's status letters. */
export function FileStatusIcon({ status }: { status: string }) {
  const s = status[0] ?? "M";
  const color =
    s === "A" ? "var(--success)"
    : s === "D" ? "var(--danger)"
    : s === "R" || s === "C" ? "var(--fg-subtle)"
    : "var(--warning)";
  const title =
    s === "A" ? "Added" : s === "D" ? "Deleted" : s === "R" ? "Renamed" : s === "C" ? "Copied" : "Modified";
  return (
    <span title={title} style={{ display: "inline-flex", width: 14, flexShrink: 0, color, justifyContent: "center" }}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {s === "A" ? (
          <><path d="M12 5v14" /><path d="M5 12h14" /></>
        ) : s === "D" ? (
          <path d="M5 12h14" />
        ) : s === "R" || s === "C" ? (
          <><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></>
        ) : (
          // Modified: filled dot — VS Code's convention, quieter than a pencil.
          <circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none" />
        )}
      </svg>
    </span>
  );
}

/** Row geometry shared by code rows, hunk bands and the comment composer:
 *  [edge marker | old№ | new№ ‖ sign | code]. The hairline after the
 *  number gutter separates "where" from "what". */
const ROW_COLUMNS = "3px 34px 34px 22px 1fr";
const GUTTER_WIDTH = 71;

/** One diff code row, tinted by tone, with the word-level changed span on a
 *  stronger tint. The 3px edge marker says what happened to the line — solid
 *  for added, hatched for removed — and turns accent when the line is
 *  selected for a comment. When the host supports line comments the number
 *  gutter is the click target. */
const DiffCodeRow = memo(function DiffCodeRow({
  block,
  selected = false,
  onGutterClick,
}: {
  block: DiffCodeBlock;
  selected?: boolean;
  onGutterClick?: (e: React.MouseEvent) => void;
}) {
  const toneColor = block.tone === "add" ? "var(--diff-add)" : "var(--diff-remove)";
  const bg = block.tone === "add" ? "var(--diff-add-bg)" : block.tone === "del" ? "var(--diff-remove-bg)" : "transparent";
  const hiBg = block.tone === "add" ? "var(--diff-add-word)" : "var(--diff-remove-word)";
  const marker =
    selected ? "var(--accent)"
    : block.tone === "add" ? "var(--diff-add)"
    : block.tone === "del" ? "repeating-linear-gradient(-45deg, var(--diff-remove) 0 2px, transparent 2px 4px)"
    : "transparent";
  const code = block.code || " ";
  const hi = block.hi;
  const gutterTitle = onGutterClick ? "Comment on this line (⇧-click extends the selection)" : undefined;
  const gutterStyle: React.CSSProperties = {
    textAlign: "right",
    paddingRight: 8,
    userSelect: "none",
    fontSize: 10.5,
    color: "var(--fg-dim)",
    cursor: onGutterClick ? "pointer" : undefined,
  };
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: ROW_COLUMNS,
        minHeight: 20,
        lineHeight: "20px",
        background: bg,
        color: block.tone === "ctx" ? "var(--fg-subtle)" : "var(--fg-strong)",
      }}
    >
      <span aria-hidden style={{ background: marker }} />
      <span style={gutterStyle} onClick={onGutterClick} title={gutterTitle}>
        {block.oldNo ?? ""}
      </span>
      <span style={{ ...gutterStyle, borderRight: "1px solid var(--border)" }} onClick={onGutterClick} title={gutterTitle}>
        {block.newNo ?? ""}
      </span>
      <span style={{ userSelect: "none", textAlign: "center", color: toneColor }}>
        {block.tone === "add" ? "+" : block.tone === "del" ? "−" : ""}
      </span>
      <span style={{ whiteSpace: "pre", paddingRight: 16 }}>
        {hi && hi[0] < hi[1] ? (
          <>
            {code.slice(0, hi[0])}
            <span style={{ background: hiBg, borderRadius: 2 }}>{code.slice(hi[0], hi[1])}</span>
            {code.slice(hi[1])}
          </>
        ) : (
          code
        )}
      </span>
    </div>
  );
});

export type FileCount = { status: string; additions: number; deletions: number };

type DiffViewProps = {
  blocks: DiffBlock[];
  /** Blocks rendered before the "show full diff" tail. */
  limit: number;
  /** Optional per-file status + counts for the file header rows. */
  fileCounts?: Map<string, FileCount>;
  /** Enables line comments: gutter click selects, an inline composer sends
   *  the note + its line anchor back to the host for routing to the agent. */
  onLineComment?: (comment: DiffLineComment) => void;
  /** The send button's label — hosts name the actual target
   *  ("Send to claude-code" / "Copy for the agent"). */
  commentActionLabel?: string;
  /** Adds an open-in-editor arrow to each file card's header. */
  onOpenFile?: (path: string) => void;
};

/** The renderer over parseDiffBlocks output: collapsible file headers, quiet
 *  hunk bands, tinted code rows, and a "show full diff" tail past `limit`.
 *  Collapse/expand state lives here — remount with a `key` to reset it. */
export function DiffView({ blocks, limit, fileCounts, onLineComment, commentActionLabel, onOpenFile }: DiffViewProps) {
  const [showFullDiff, setShowFullDiff] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  // Line-comment selection: block indices, anchor→head (⇧-click moves head).
  const [sel, setSel] = useState<{ anchor: number; head: number } | null>(null);
  const [note, setNote] = useState("");
  const toggleFileCollapsed = (path: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const visible = showFullDiff ? blocks : blocks.slice(0, limit);
  const hidden = blocks.length - visible.length;

  const clearSelection = () => {
    setSel(null);
    setNote("");
  };

  const resizeCommentInput = (textarea: HTMLTextAreaElement) => {
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 96)}px`;
  };

  const gutterClick = (index: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    // ⇧-click extends within the same file; anything else starts fresh.
    if (
      e.shiftKey &&
      sel &&
      fileOfBlock(blocks, sel.anchor) === fileOfBlock(blocks, index)
    ) {
      setSel({ anchor: sel.anchor, head: index });
    } else if (sel && sel.anchor === index && sel.head === index) {
      clearSelection(); // clicking the lone selected line deselects
    } else {
      setSel({ anchor: index, head: index });
    }
  };

  const sendComment = () => {
    if (!sel || !onLineComment) return;
    const comment = commentFromBlocks(blocks, sel.anchor, sel.head, note);
    if (!comment || !comment.text) return;
    onLineComment(comment);
    clearSelection();
  };

  const selFrom = sel ? Math.min(sel.anchor, sel.head) : -1;
  const selTo = sel ? Math.max(sel.anchor, sel.head) : -1;

  // Each file is its own card: a header (mark, path, counts) over its rows.
  // Lines before any `diff --git` (a bare hunk) get a card with no header.
  const cards: { key: number; path: string | null; rows: ReactNode[] }[] = [];
  const rowsOf = (i: number) => {
    if (cards.length === 0) cards.push({ key: i, path: null, rows: [] });
    return cards[cards.length - 1].rows;
  };
  visible.forEach((block, i) => {
    if (block.kind === "file") {
      cards.push({ key: i, path: block.path, rows: [] });
      return;
    }
    const current = cards[cards.length - 1];
    if (current?.path != null && collapsedFiles.has(current.path)) return;
    const rows = rowsOf(i);
    if (block.kind === "hunk") {
      // A card's opening band with no context text (a new file) says nothing.
      if (rows.length === 0 && !block.text) return;
      rows.push(
        <div key={i} style={{ display: "grid", gridTemplateColumns: ROW_COLUMNS, minHeight: 20, lineHeight: "20px", color: "var(--fg-dim)", background: "color-mix(in srgb, var(--bg-hover) 70%, transparent)", fontSize: 10.5 }}>
          <span />
          <span style={{ gridColumn: "span 2", textAlign: "center", userSelect: "none", letterSpacing: "2px", borderRight: "1px solid var(--border)" }}>···</span>
          <span />
          <span style={{ whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis" }}>{block.text}</span>
        </div>
      );
      return;
    }
    const selected = sel !== null && i >= selFrom && i <= selTo;
    rows.push(
      <DiffCodeRow
        key={i}
        block={block}
        selected={selected}
        onGutterClick={onLineComment ? gutterClick(i) : undefined}
      />
    );
    // The composer sits directly under the selection's last row.
    if (sel !== null && i === selTo && onLineComment) {
      rows.push(
        <div
          key="comment-composer"
          style={{
            display: "grid",
            gridTemplateColumns: `${GUTTER_WIDTH}px minmax(220px, 620px) 1fr`,
            padding: "4px 16px 6px 0",
            fontFamily: "var(--font-ui)",
          }}
        >
          <span aria-hidden="true" />
          <div className="klide-diff-comment-row klide-fade-swap">
            <textarea
              className="klide-diff-comment-input"
              autoFocus
              rows={1}
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
                resizeCommentInput(e.currentTarget);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendComment();
                } else if (e.key === "Escape") {
                  clearSelection();
                }
              }}
              placeholder="Leave feedback"
            />
            <button
              type="button"
              onClick={clearSelection}
              className="klide-diff-comment-icon"
              aria-label="Cancel comment"
              title="Cancel"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
            <button
              type="button"
              onClick={sendComment}
              disabled={!note.trim()}
              className="klide-diff-comment-send"
              aria-label={commentActionLabel ?? "Send to agent"}
              title={commentActionLabel ?? "Send to agent"}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="m5 12 14-7-7 14-2-5-5-2Z" />
                <path d="m12 14 7-9" />
              </svg>
            </button>
          </div>
        </div>
      );
    }
  });

  return (
    <div style={{ padding: "0 16px 8px", fontFamily: "var(--font-mono)", fontSize: 11.5 }}>
      {cards.map((card) => {
        const counts = card.path != null ? fileCounts?.get(card.path) : undefined;
        const collapsed = card.path != null && collapsedFiles.has(card.path);
        // The path wears its status colour (amber modified, green new, red
        // deleted) — the same reading as every file list in the app.
        const mark = counts ? gitStatusMark(counts.status) : null;
        return (
          <section
            key={card.key}
            data-diff-path={card.path ?? undefined}
            style={{ marginTop: 12, border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", overflow: "hidden" }}
          >
            {card.path != null && (
              <div
                onClick={() => toggleFileCollapsed(card.path!)}
                title={collapsed ? "Expand file" : "Collapse file"}
                style={{ height: 32, display: "flex", alignItems: "center", gap: 8, padding: "0 12px", borderBottom: collapsed ? "none" : "1px solid var(--border)", cursor: "pointer", userSelect: "none" }}
              >
                <CodeIcon size={13} style={{ color: "var(--fg-dim)", flexShrink: 0 }} />
                <span title={mark?.title} style={{ color: mark?.color ?? "var(--fg-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {card.path}
                </span>
                <span style={{ flex: 1 }} />
                {counts && (
                  <span style={{ fontSize: 10.5, flexShrink: 0 }}>
                    <span style={{ color: "var(--diff-add)" }}>+{counts.additions}</span>{" "}
                    <span style={{ color: "var(--diff-remove)" }}>−{counts.deletions}</span>
                  </span>
                )}
                {onOpenFile && mark?.label !== "D" && (
                  <button
                    type="button"
                    className="klide-diff-open"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenFile(card.path!);
                    }}
                    title="Open in editor"
                    aria-label={`Open ${card.path} in editor`}
                  >
                    <OpenInEditorIcon size={13} />
                  </button>
                )}
                <ChevronIcon open={!collapsed} size={11} style={{ color: "var(--fg-dim)", flexShrink: 0 }} />
              </div>
            )}
            {card.rows.length > 0 && (
              <div style={{ overflowX: "auto", padding: "4px 0" }}>
                <div style={{ width: "max-content", minWidth: "100%" }}>{card.rows}</div>
              </div>
            )}
          </section>
        );
      })}
      {hidden > 0 && (
        <div style={{ padding: "10px 16px 2px", color: "var(--fg-subtle)", fontFamily: "var(--font-ui)", fontSize: 12 }}>
          {hidden} more lines hidden.{" "}
          <button
            type="button"
            onClick={() => setShowFullDiff(true)}
            style={{ border: "none", background: "transparent", color: "var(--accent)", cursor: "pointer", font: "inherit", padding: 0 }}
          >
            Show full diff
          </button>
        </div>
      )}
    </div>
  );
}
