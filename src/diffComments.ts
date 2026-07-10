// Diff Comment → Agent — the review-loop send-back (Orca/Superset-validated).
// Select lines in a diff, write a note, and the comment lands in the running
// agent: pasted into a delegate TUI, or folded into a harness turn. This
// module owns the pure half — turning a block-range selection into a
// line-anchored comment and rendering the plain-text contract the agent sees
// — plus the one PTY write helper. Rendering/selection UI lives in
// components/diffView.tsx; routing policy lives in the host surface.
import { invoke } from "@tauri-apps/api/core";
import type { DiffBlock } from "./components/diffView";

/** One line-anchored review comment. `side: "old"` means every selected line
 *  was a deletion — line numbers then refer to the PREVIOUS version of the
 *  file (Superset's side-aware rule); otherwise numbers follow the new file. */
export type DiffLineComment = {
  path: string;
  side: "new" | "old";
  startLine: number;
  endLine: number;
  /** The selected diff rows with their +/−/space signs, capped for the wire. */
  excerpt: string[];
  text: string;
};

const EXCERPT_CAP = 24;

/** Which file a diff block index belongs to (nearest `file` header above). */
export function fileOfBlock(blocks: DiffBlock[], index: number): string | null {
  for (let i = Math.min(index, blocks.length - 1); i >= 0; i--) {
    const b = blocks[i];
    if (b.kind === "file") return b.path;
  }
  return null;
}

/** Build a comment from a selected block range (inclusive, any order).
 *  Returns null when the range holds no code lines or spans no file. The
 *  range is expected to stay within one file — the selection UI clamps. */
export function commentFromBlocks(
  blocks: DiffBlock[],
  anchorIndex: number,
  headIndex: number,
  text: string
): DiffLineComment | null {
  const from = Math.max(0, Math.min(anchorIndex, headIndex));
  const to = Math.min(blocks.length - 1, Math.max(anchorIndex, headIndex));
  const path = fileOfBlock(blocks, from);
  if (!path) return null;

  const rows: Extract<DiffBlock, { kind: "line" }>[] = [];
  for (let i = from; i <= to; i++) {
    const b = blocks[i];
    if (b.kind === "line") rows.push(b);
  }
  if (rows.length === 0) return null;

  // Deletions carry only old-file numbers; everything else follows the new
  // file. A selection that is *entirely* deletions anchors to the old side.
  const allDeleted = rows.every((r) => r.tone === "del");
  const numbers = rows
    .map((r) => (allDeleted ? r.oldNo : r.newNo ?? r.oldNo))
    .filter((n): n is number => n !== null);
  if (numbers.length === 0) return null;

  const excerpt = rows.slice(0, EXCERPT_CAP).map((r) => {
    const sign = r.tone === "add" ? "+" : r.tone === "del" ? "-" : " ";
    return `${sign} ${r.code}`;
  });
  if (rows.length > EXCERPT_CAP) {
    excerpt.push(`… (${rows.length - EXCERPT_CAP} more selected lines)`);
  }

  return {
    path,
    side: allDeleted ? "old" : "new",
    startLine: Math.min(...numbers),
    endLine: Math.max(...numbers),
    excerpt,
    text: text.trim(),
  };
}

/** The plain-text contract the agent receives — Orca-style File/Lines/Comment
 *  with the selected excerpt quoted so the agent doesn't have to re-find the
 *  spot. Reads the same whether pasted into a TUI or sent as a harness turn. */
export function formatDiffComment(c: DiffLineComment): string {
  const lines =
    c.startLine === c.endLine ? `line ${c.startLine}` : `lines ${c.startLine}-${c.endLine}`;
  const side =
    c.side === "old" ? " (deleted lines — numbers refer to the previous version)" : "";
  const quoted = c.excerpt.map((l) => `> ${l}`).join("\n");
  return `Review comment on ${c.path}, ${lines}${side}:\n${quoted}\nComment: ${c.text}`;
}

/** Paste text into a delegate TUI and submit it. Wrapped in bracketed-paste
 *  markers so multiline text lands as one paste (every delegate TUI enables
 *  bracketed paste), then a carriage return submits it. */
export async function sendTextToDelegatePty(sessionId: string, text: string): Promise<void> {
  await invoke("delegate_pty_write", {
    sessionId,
    data: `\x1b[200~${text}\x1b[201~\r`,
  });
}
