import type { GitStatusMark } from "../gitStatusMark";

/** A changed file the way every changes list draws it — Git Review's working
 *  tree and a run's result card alike: the name wears its status colour (no
 *  status letter; the word is the tooltip), the folder whispers under it one
 *  step in, and comes up when the row is hovered or selected. Compose it inside
 *  a `.klide-file-row`; the row owns fills, the label owns the two lines.
 *  `mark` is null when the status is not known yet — the name stays neutral. */
export function ChangedFileLabel({ path, mark }: { path: string; mark: GitStatusMark | null }) {
  const parts = path.split("/");
  const name = parts.pop() ?? path;
  const folder = parts.join("/");
  return (
    <div style={{ minWidth: 0 }}>
      <div className="klide-file-row-name" title={mark?.title} style={mark ? { color: mark.color } : undefined}>{name}</div>
      {folder && <div className="klide-file-row-sub klide-changed-file-folder">{folder}</div>}
    </div>
  );
}
