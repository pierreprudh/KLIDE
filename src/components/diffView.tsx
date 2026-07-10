// The one diff renderer — shared by the staging pane (GitReview) and the
// commit detail pane (GitHistoryGraph), so both read the same way.
//
// Modeled on what makes GitHub / Tower / Fork diffs digestible: dual
// line-number gutters, a separated sign column so code indentation aligns,
// word-level highlighting inside changed line pairs, collapsible per-file
// sections, and hunk gaps as quiet "···" bands instead of raw @@ noise.
// Row tinting keeps the 12% success/danger vocabulary.
//
// Line comments (Diff Comment → Agent): when a host passes `onLineComment`,
// clicking a line's number gutter selects it (⇧-click extends within the
// file) and an inline composer appears under the selection — the note plus
// its line anchor goes back to the host, which routes it to the running
// agent. Selection is marked with a 2px left spine (selection, not state).

import { memo, useState, type ReactNode } from "react";
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

/** One diff code row: [old№ | new№ | sign | code], tinted by tone, with
 *  the word-level changed span on a stronger tint. When the host supports
 *  line comments the gutter becomes the click target and a selected row
 *  carries a 2px accent spine. */
const DiffCodeRow = memo(function DiffCodeRow({
  block,
  selected = false,
  onGutterClick,
}: {
  block: DiffCodeBlock;
  selected?: boolean;
  onGutterClick?: (e: React.MouseEvent) => void;
}) {
  const bg =
    block.tone === "add" ? "color-mix(in srgb, var(--success) 12%, transparent)"
    : block.tone === "del" ? "color-mix(in srgb, var(--danger) 12%, transparent)"
    : "transparent";
  const fg =
    block.tone === "add" ? "var(--success)"
    : block.tone === "del" ? "var(--danger)"
    : "var(--fg-subtle)";
  const hiBg =
    block.tone === "add" ? "color-mix(in srgb, var(--success) 30%, transparent)"
    : "color-mix(in srgb, var(--danger) 30%, transparent)";
  const code = block.code || " ";
  const hi = block.hi;
  const gutterStyle: React.CSSProperties = {
    textAlign: "right",
    paddingRight: 8,
    userSelect: "none",
    fontSize: 10,
    color: "var(--fg-dim)",
    lineHeight: "18px",
    cursor: onGutterClick ? "pointer" : undefined,
  };
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "36px 36px 18px 1fr",
        minHeight: 18,
        background: bg,
        color: fg,
        boxShadow: selected ? "inset 2px 0 0 var(--accent)" : undefined,
      }}
    >
      <span
        style={gutterStyle}
        onClick={onGutterClick}
        title={onGutterClick ? "Comment on this line (⇧-click extends the selection)" : undefined}
      >
        {block.oldNo ?? ""}
      </span>
      <span
        style={gutterStyle}
        onClick={onGutterClick}
        title={onGutterClick ? "Comment on this line (⇧-click extends the selection)" : undefined}
      >
        {block.newNo ?? ""}
      </span>
      <span style={{ userSelect: "none", textAlign: "center" }}>
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
};

/** The renderer over parseDiffBlocks output: collapsible file headers, quiet
 *  hunk bands, tinted code rows, and a "show full diff" tail past `limit`.
 *  Collapse/expand state lives here — remount with a `key` to reset it. */
export function DiffView({ blocks, limit, fileCounts, onLineComment, commentActionLabel }: DiffViewProps) {
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

  const out: ReactNode[] = [];
  let fileCollapsed = false;
  visible.forEach((block, i) => {
    if (block.kind === "file") {
      const counts = fileCounts?.get(block.path);
      const collapsed = collapsedFiles.has(block.path);
      fileCollapsed = collapsed;
      out.push(
        <div
          key={i}
          onClick={() => toggleFileCollapsed(block.path)}
          title={collapsed ? "Expand file" : "Collapse file"}
          style={{ height: 26, display: "flex", alignItems: "center", gap: 8, padding: "0 16px", marginTop: i > 0 ? 8 : 0, borderTop: i > 0 ? "1px solid var(--border)" : "none", borderBottom: "1px solid var(--border)", background: "color-mix(in srgb, var(--bg-hover) 45%, transparent)", cursor: "pointer", userSelect: "none" }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ color: "var(--fg-dim)", flexShrink: 0, transform: collapsed ? "rotate(-90deg)" : "none", transition: "transform var(--motion-fast) var(--ease-out)" }}>
            <path d="M6 9l6 6 6-6" />
          </svg>
          {counts && <FileStatusIcon status={counts.status} />}
          <span style={{ color: "var(--fg-strong)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {block.path}
          </span>
          <span style={{ flex: 1 }} />
          {counts && (
            <span style={{ fontSize: 10.5, flexShrink: 0 }}>
              <span style={{ color: "var(--diff-add)" }}>+{counts.additions}</span>{" "}
              <span style={{ color: "var(--diff-remove)" }}>−{counts.deletions}</span>
            </span>
          )}
        </div>
      );
      return;
    }
    if (fileCollapsed) return;
    if (block.kind === "hunk") {
      out.push(
        <div key={i} style={{ display: "grid", gridTemplateColumns: "72px 1fr", minHeight: 18, color: "var(--fg-dim)", background: "color-mix(in srgb, var(--bg-hover) 60%, transparent)", fontSize: 10.5 }}>
          <span style={{ textAlign: "center", userSelect: "none", letterSpacing: "2px" }}>···</span>
          <span style={{ paddingLeft: 18, whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis", opacity: 0.8 }}>{block.text}</span>
        </div>
      );
      return;
    }
    const selected = sel !== null && i >= selFrom && i <= selTo;
    out.push(
      <DiffCodeRow
        key={i}
        block={block}
        selected={selected}
        onGutterClick={onLineComment ? gutterClick(i) : undefined}
      />
    );
    // The composer sits directly under the selection's last row.
    if (sel !== null && i === selTo && onLineComment) {
      const target = commentFromBlocks(blocks, sel.anchor, sel.head, note);
      out.push(
        <div
          key="comment-composer"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: "8px 16px 10px 90px",
            borderTop: "1px solid var(--border)",
            borderBottom: "1px solid var(--border)",
            background: "color-mix(in srgb, var(--accent) 4%, transparent)",
            fontFamily: "var(--font-ui)",
          }}
        >
          <textarea
            autoFocus
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendComment();
              } else if (e.key === "Escape") {
                clearSelection();
              }
            }}
            placeholder={
              target
                ? `Comment on ${target.path.split("/").pop()} · ${
                    target.startLine === target.endLine
                      ? `line ${target.startLine}`
                      : `lines ${target.startLine}-${target.endLine}`
                  } — ⏎ sends, ⇧⏎ newline`
                : "Comment…"
            }
            style={{
              width: "100%",
              resize: "vertical",
              fontSize: 12,
              lineHeight: 1.5,
              padding: "6px 9px",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              background: "var(--bg)",
              color: "var(--fg-strong)",
              outline: "none",
              fontFamily: "var(--font-ui)",
            }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              onClick={clearSelection}
              style={{
                height: 24,
                padding: "0 9px",
                border: "none",
                background: "transparent",
                fontSize: 11.5,
                color: "var(--fg-subtle)",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={sendComment}
              disabled={!note.trim()}
              style={{
                height: 24,
                padding: "0 10px",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                background: "transparent",
                fontSize: 11.5,
                color: note.trim() ? "var(--fg-strong)" : "var(--fg-dim)",
                cursor: note.trim() ? "pointer" : "default",
                transition: "background var(--motion-fast) var(--ease-out)",
              }}
              onMouseEnter={(e) => {
                if (note.trim()) e.currentTarget.style.background = "var(--bg-hover)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
            >
              {commentActionLabel ?? "Send to agent"}
            </button>
          </div>
        </div>
      );
    }
  });

  return (
    <div style={{ padding: "0 0 8px", fontFamily: "var(--font-mono)", fontSize: 11.5, lineHeight: 1.6 }}>
      {out}
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
