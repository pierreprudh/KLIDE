// MISSION BRANCH ACTIONS — bring an isolated Mission's accepted work into the
// checkout.
//
// Each attempt of a Mission in a Git project works in its own worktree, and an
// accepted one fast-forwards the Mission branch (Rust `missions/isolation.rs`).
// The checkout is never written to on its own: this row is where the operator
// merges. What is left to merge is read from Git each time, so the row is gone
// once the branch is merged — here, in Git Review, or in a terminal.

import { useEffect, useState } from "react";
import { gitBranchDiff, gitWorktreeMerge, type GitBranchDiff } from "../../ipc/git";
import { refreshGitStatus } from "../../gitStatus";
import { pushToast } from "../../toast";
import { errMessage } from "../../errors";

export function MissionBranchActions({ workspaceRoot, branch, refreshKey }: { workspaceRoot: string; branch: string; refreshKey: number }) {
  const [diff, setDiff] = useState<GitBranchDiff | null>(null);
  const [busy, setBusy] = useState(false);
  const [merged, setMerged] = useState(0);

  useEffect(() => {
    let live = true;
    gitBranchDiff(workspaceRoot, branch)
      .then((next) => { if (live) setDiff(next.files.length > 0 ? next : null); })
      .catch(() => { if (live) setDiff(null); });
    return () => { live = false; };
  }, [workspaceRoot, branch, refreshKey, merged]);

  if (!diff) return null;

  const merge = async () => {
    if (!confirm(`Merge ${branch} into ${diff.baseBranch}?`)) return;
    setBusy(true);
    try {
      pushToast(await gitWorktreeMerge(workspaceRoot, branch), { tone: "success" });
      await refreshGitStatus(workspaceRoot);
      setMerged((n) => n + 1);
    } catch (e) {
      pushToast(errMessage(e), { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const files = diff.files.length === 1 ? "1 file" : `${diff.files.length} files`;
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 14, padding: "0 14px 14px", fontSize: 12, color: "var(--fg-dim)" }}>
      <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
        Accepted work is on <code style={{ fontFamily: "var(--font-mono)" }}>{branch}</code> · {files}, +{diff.additions} −{diff.deletions}
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={() => void merge()}
        title={`Merge ${branch} into ${diff.baseBranch}`}
        style={{ marginLeft: "auto", flexShrink: 0, background: "none", border: "none", padding: 0, fontSize: 12, color: "var(--accent)", cursor: busy ? "default" : "pointer", opacity: busy ? 0.5 : 1 }}
      >
        Merge into {diff.baseBranch}
      </button>
    </div>
  );
}
