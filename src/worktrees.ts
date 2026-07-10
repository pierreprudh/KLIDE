// Worktree wire types + notice helpers — the TS half of the worktree-setup
// seam (Rust: src-tauri/src/worktree_setup.rs, recipe in
// <workspace>/.klide/worktree.json).

/** Mirror of Rust's `WorktreeInfo` (git_worktree_add / git_worktree_list). */
export type WorktreeInfo = {
  path: string;
  branch: string;
  /** Untracked config files copied in from the main checkout (e.g. `.env`). */
  bootstrapped: string[];
  /** Dependency dirs symlinked from the main checkout (recipe `linkDirs`). */
  linked?: string[];
  /** Deterministic dev-server port (recipe `portBase`), when configured. */
  port?: number | null;
  /** A recipe `setupScript` was started in the background — its outcome
   *  arrives on the `worktree-setup:done` event. */
  scriptStarted?: boolean;
};

/** Payload of the `worktree-setup:done` global event. */
export type WorktreeSetupDone = {
  path: string;
  branch: string;
  ok: boolean;
  output: string;
};

/** ` · copied .env · linked node_modules · port 3107 · setup running…` —
 *  the suffix every "worktree created" notice shares. Empty when the setup
 *  did nothing. */
export function worktreeSetupSummary(wt: WorktreeInfo): string {
  const parts: string[] = [];
  if (wt.bootstrapped.length > 0) parts.push(`copied ${wt.bootstrapped.join(", ")}`);
  if (wt.linked && wt.linked.length > 0) parts.push(`linked ${wt.linked.join(", ")}`);
  if (wt.port != null) parts.push(`port ${wt.port}`);
  if (wt.scriptStarted) parts.push("setup running…");
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

/** Short display name for a worktree checkout path. */
export function worktreeName(pathOrBranch: { path: string; branch: string }): string {
  return pathOrBranch.path.split("/").filter(Boolean).pop() ?? pathOrBranch.branch;
}
