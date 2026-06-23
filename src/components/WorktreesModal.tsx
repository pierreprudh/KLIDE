import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Z } from "../zLayers";

// Worktrees — the fleet's review/merge surface. Lists the repo's git
// worktrees and lets you open one in a pinned AI panel, merge its branch back
// into the main checkout, or remove it. Backend lives in git.rs
// (git_worktree_list / git_worktree_merge / git_worktree_remove); this view is
// the thin operator UI over those. Same centered-overlay treatment as
// MemoryModal.

type Worktree = { path: string; branch: string; bootstrapped: string[] };

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
      const list = await invoke<Worktree[]>("git_worktree_list", { workspaceRoot });
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
      const msg = await invoke<string>("git_worktree_merge", { workspaceRoot, branch });
      onNotice(msg);
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
      await invoke("git_worktree_remove", { workspaceRoot, path, force: false });
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

  const btn = {
    height: 26,
    padding: "0 10px",
    fontSize: 11.5,
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border)",
    background: "var(--bg-elevated)",
    color: "var(--fg-strong)",
    cursor: "pointer",
  } as const;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Worktrees"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: Z.modal,
        display: "grid",
        placeItems: "center",
        background: "rgba(0,0,0,0.30)",
        backdropFilter: "blur(3px)",
        WebkitBackdropFilter: "blur(3px)",
      }}
    >
      <div
        className="floating-panel"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(640px, calc(100vw - 96px))",
          maxHeight: "min(560px, calc(100vh - 96px))",
          borderRadius: "var(--radius-lg)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <header
          style={{
            height: 50,
            flexShrink: 0,
            padding: "0 12px 0 16px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--fg-strong)", fontSize: 13.5, fontWeight: 600 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M6 9v6" /><path d="M18 6a9 9 0 0 1-9 9" /><circle cx="18" cy="6" r="3" /></svg>
            Worktrees
          </span>
          <div style={{ flex: 1 }} />
          <button onClick={() => void refresh()} style={{ ...btn, height: 28 }} aria-label="Refresh">Refresh</button>
          <button onClick={onClose} aria-label="Close" style={{ width: 30, height: 30, display: "grid", placeItems: "center", color: "var(--fg-subtle)", background: "transparent", border: "none", borderRadius: "var(--radius-sm)", cursor: "pointer" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </header>

        <div style={{ flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          {!workspaceRoot && <div style={{ color: "var(--fg-subtle)", fontSize: 12, padding: 12 }}>Open a workspace folder first.</div>}
          {workspaceRoot && loading && worktrees.length === 0 && <div style={{ color: "var(--fg-subtle)", fontSize: 12, padding: 12 }}>Loading…</div>}
          {workspaceRoot && !loading && worktrees.length <= 1 && (
            <div style={{ color: "var(--fg-subtle)", fontSize: 12, padding: 12, lineHeight: 1.5 }}>
              No worktrees yet. Use <strong style={{ color: "var(--fg-strong)" }}>Agent: New Run in Worktree</strong> (⌘⇧P) to run an agent on an isolated branch.
            </div>
          )}
          {worktrees.map((w) => {
            const main = isMain(w);
            const busy = busyPath === w.path;
            return (
              <div
                key={w.path}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 12px",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--border)",
                  background: "var(--bg-surface)",
                  opacity: busy ? 0.6 : 1,
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--fg-strong)", fontWeight: 600 }}>
                    {w.branch || "(detached)"}
                    {main && <span style={{ fontSize: 10, fontWeight: 500, color: "var(--fg-subtle)", border: "1px solid var(--border)", borderRadius: 999, padding: "0 6px" }}>main checkout</span>}
                  </div>
                  <div style={{ fontSize: 10.5, color: "var(--fg-subtle)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{w.path}</div>
                </div>
                {!main && (
                  <>
                    <button disabled={busy} style={btn} onClick={() => { onOpenWorktree(w.path); onClose(); }}>Open</button>
                    <button disabled={busy || !w.branch} style={btn} title="Merge this branch into the main checkout's current branch" onClick={() => void merge(w.branch, w.path)}>Merge</button>
                    <button disabled={busy} style={{ ...btn, color: "var(--danger, #b4493b)" }} title="Remove this worktree (fails if it has uncommitted changes)" onClick={() => void remove(w.path)}>Remove</button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
