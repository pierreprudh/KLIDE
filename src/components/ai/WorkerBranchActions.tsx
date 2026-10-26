// WORKER BRANCH ACTIONS — apply or drop a finished worker's branch from the
// row that dispatched it.
//
// A worker's worktree is kept until the operator chooses: nothing removes it
// on settle, dirty or failed. The row offers the two choices Mission Control
// offers a worktree Run (App.tsx), with the same semantics: Merge brings the
// branch into the main checkout, then removes its worktree and branch (a
// refusal there is reported, never forced); Discard force-removes both. The
// actions show only while a worktree on that branch still exists, so the
// row's state is read from Git, not remembered — after a reload, or once the
// branch was handled elsewhere, there is nothing to offer.

import { useEffect, useState } from "react";
import { gitWorktreeList, gitWorktreeMerge, gitWorktreeRemove } from "../../ipc/git";
import { refreshGitStatus } from "../../gitStatus";
import { pushToast } from "../../toast";
import { errMessage } from "../../errors";

export function WorkerBranchActions({ workspaceRoot, branch }: { workspaceRoot: string; branch: string }) {
  const [path, setPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    gitWorktreeList(workspaceRoot)
      .then((list) => { if (live) setPath(list.find((w) => w.branch === branch)?.path ?? null); })
      .catch(() => { if (live) setPath(null); });
    return () => { live = false; };
  }, [workspaceRoot, branch]);

  if (!path) return null;

  const merge = async () => {
    if (!confirm(`Merge ${branch} into the main checkout, then remove its worktree?`)) return;
    setBusy(true);
    try {
      const merged = await gitWorktreeMerge(workspaceRoot, branch);
      try {
        await gitWorktreeRemove(workspaceRoot, path, { deleteBranch: branch });
        pushToast(`${merged} Worktree removed.`, { tone: "success" });
        setPath(null);
      } catch (e) {
        // The work is in the main checkout already; a cleanup refusal (edits
        // left uncommitted in the worktree) is reported, not forced.
        pushToast(`${merged} The worktree was kept: ${errMessage(e)}`, { tone: "warn" });
      }
      await refreshGitStatus(workspaceRoot);
    } catch (e) {
      pushToast(errMessage(e), { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (!confirm(`Discard ${branch}? Its worktree, its commits and any uncommitted edits are deleted. This can't be undone.`)) return;
    setBusy(true);
    try {
      await gitWorktreeRemove(workspaceRoot, path, { force: true, deleteBranch: branch });
      pushToast(`Discarded ${branch}.`, { tone: "info" });
      setPath(null);
    } catch (e) {
      pushToast(errMessage(e), { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const action = { background: "none", border: "none", padding: 0, fontSize: 12, cursor: busy ? "default" : "pointer", opacity: busy ? 0.5 : 1 } as const;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 6 }}>
      <button type="button" disabled={busy} onClick={() => void merge()} style={{ ...action, color: "var(--accent)" }} title={`Merge ${branch} into the main checkout`}>
        Merge
      </button>
      <button type="button" disabled={busy} onClick={() => void discard()} style={{ ...action, color: "var(--fg-subtle)" }} title={`Delete the worktree and ${branch}`}>
        Discard
      </button>
    </div>
  );
}
