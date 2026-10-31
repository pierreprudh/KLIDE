// Two versions of one file as hunk rows — changed lines with a little
// context, long unchanged runs folded into a gap. Shared by the inline edit
// review and the Result card, so both read a change the same way.

import { diffLines } from "diff";

export type DiffRow =
  | { kind: "context"; no: number; text: string }
  | { kind: "del"; no: number; text: string }
  | { kind: "add"; no: number; text: string }
  | { kind: "gap"; hidden: number };

/** Turn two file versions into Claude-Code-style hunk rows: changed lines
 *  (red −, green +) surrounded by a few lines of unchanged context, with long
 *  unchanged runs collapsed into a "⋯ N unchanged" gap. Line numbers follow the
 *  new file (old file for deletions), matching the gutter in Claude Code. */
export function buildDiffRows(oldContent: string, newContent: string, context = 3): { rows: DiffRow[]; added: number; removed: number } {
  const changes = diffLines(oldContent, newContent);
  const flat: Exclude<DiffRow, { kind: "gap" }>[] = [];
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

  const rows: DiffRow[] = [];
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
