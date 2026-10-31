import { useCallback, useEffect, useState } from "react";
import { Z } from "../zLayers";
import { CloseIcon, GitIcon, ReplayIcon } from "../icons";
import type { WorktreeInfo } from "../worktrees";
import { gitWorktreeList, gitWorktreeMerge, gitWorktreeRemove } from "../ipc/git";

// Worktrees — the fleet's review/merge surface. Lists the repo's git
// worktrees and lets you open one in a pinned AI panel, merge its branch back
// into the main checkout, or remove it. Backend lives in git.rs
// (git_worktree_list / git_worktree_merge / git_worktree_remove); this view is
// the thin operator UI over those. Same centered-overlay treatment as
// MemoryModal.

type Worktree = WorktreeInfo;

type Props = {
  open: boolean;
  workspaceRoot: string | null;
  /** Open a worktree in a fresh AI panel pinned to its path. */
  onOpenWorktree: (path: string) => void;
  /** Surface a one-line status/error to the user (App's file-notice bar). */
  onNotice: (message: string) => void;
  onClose: () => void;
};

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

export function WorktreesModal({ open, workspaceRoot, onOpenWorktree, onNotice, onClose }: Props) {
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyPath, setBusyPath] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!workspaceRoot) return;
    setLoading(true);
    try {
      const list = await gitWorktreeList(workspaceRoot);
      setWorktrees(list);
    } catch (err) {
      onNotice(`Couldn't list worktrees: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [workspaceRoot, onNotice]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function merge(branch: string, path: string) {
    if (!workspaceRoot || !branch) return;
    setBusyPath(path);
    try {
      const msg = await gitWorktreeMerge(workspaceRoot, branch);
      // Landed, so the checkout and its branch have nothing left to give —
      // tear both down, as a race merge does. A dirty worktree refuses the
      // removal and stays, with the reason, so nothing unmerged is lost.
      try {
        await gitWorktreeRemove(workspaceRoot, path, { deleteBranch: branch });
        onNotice(`${msg} Removed its worktree and branch.`);
      } catch (err) {
        onNotice(`${msg} Kept its worktree: ${err instanceof Error ? err.message : String(err)}`);
      }
      await refresh();
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyPath(null);
    }
  }

  async function remove(path: string) {
    if (!workspaceRoot) return;
    setBusyPath(path);
    try {
      await gitWorktreeRemove(workspaceRoot, path);
      onNotice(`Removed worktree ${basename(path)}.`);
      await refresh();
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyPath(null);
    }
  }

  // The first entry git reports is the main checkout (the workspace root); the
  // rest are linked worktrees. Only linked ones get branch actions.
  const isMain = (w: Worktree) => w.path === workspaceRoot;

  const linked = worktrees.filter((w) => !isMain(w)).length;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Worktrees"
      className="klide-worktrees-scrim"
      onClick={onClose}
      style={{ zIndex: Z.modal }}
    >
      <div className="klide-worktrees" onClick={(e) => e.stopPropagation()}>
        <header className="klide-worktrees-header">
          <div className="klide-worktrees-heading">
            <span>
              <GitIcon size={15} />
              Worktrees
            </span>
            {workspaceRoot && (
              <small>
                {linked === 0 ? "No isolated branches" : `${linked} isolated ${linked === 1 ? "branch" : "branches"}`}
              </small>
            )}
          </div>
          <button className="klide-worktrees-icon-btn" onClick={() => void refresh()} aria-label="Refresh">
            <ReplayIcon size={14} />
          </button>
          <button className="klide-worktrees-icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon size={14} />
          </button>
        </header>

        <div className="klide-worktrees-list">
          {!workspaceRoot && <div className="klide-worktrees-empty">Open a workspace folder first.</div>}
          {workspaceRoot && loading && worktrees.length === 0 && <div className="klide-worktrees-empty">Loading…</div>}
          {workspaceRoot && !loading && worktrees.length <= 1 && (
            <div className="klide-worktrees-empty">
              No worktrees yet. <strong>Agent: New Run in Worktree</strong> (⌘⇧P) runs an agent on an isolated branch.
            </div>
          )}
          {worktrees.map((w) => {
            const main = isMain(w);
            const busy = busyPath === w.path;
            return (
              <div key={w.path} className="klide-worktrees-row" data-busy={busy || undefined}>
                <GitIcon size={14} />
                <div className="klide-worktrees-copy">
                  <span>
                    {w.branch || "(detached)"}
                    {main && <em>main checkout</em>}
                  </span>
                  <small>{w.path}</small>
                </div>
                {!main && (
                  <div className="klide-worktrees-actions">
                    <button className="klide-worktrees-action" disabled={busy} onClick={() => { onOpenWorktree(w.path); onClose(); }}>Open</button>
                    <button className="klide-worktrees-action" disabled={busy || !w.branch} onClick={() => void merge(w.branch, w.path)}>Merge</button>
                    <button className="klide-worktrees-action" data-tone="danger" disabled={busy} onClick={() => void remove(w.path)}>Remove</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
