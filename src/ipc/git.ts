// The git wire, in one place.
//
// 26 `git_*` commands, and until this module every caller reached for `invoke`
// directly — 37 sites across 9 files. The wire types had seven homes between
// them: eight of them declared inside `GitReview.tsx`, `CommitDetails` exported
// from `GitHistoryGraph.tsx` for another component to import, and
// `GitBranchDiffSummary` written out verbatim twice. Three of the names had also
// drifted from the Rust structs they mirror, and `git_diff` was typed two
// different ways — once fully, once as an inline `{additions, deletions}`.
//
// Names here match the Rust structs in `src-tauri/src/git/`, so a reader can
// grep one word across both languages. Types that already have a proper home
// (with logic that uses them) stay there and are re-exported, so callers still
// have a single import path.

import { invoke } from "@tauri-apps/api/core";
import type { GitFile, GitStatus } from "../gitTypes";
import type { GraphCommit } from "../gitGraph";
import type { WorktreeInfo } from "../worktrees";

export type { GitFile, GitStatus, GraphCommit, WorktreeInfo };

// ── Wire types ───────────────────────────────────────────────────────────────

/** One file's diff. Mirrors `GitDiff` in `git/mod.rs`. */
export type GitDiff = {
  path: string;
  diff: string;
  additions: number;
  deletions: number;
  image?: GitImageDiff;
};

export type GitImageSide = { dataUri: string | null; error: string | null };
export type GitImageDiff = { before: GitImageSide | null; after: GitImageSide | null };

/** Mirrors `GitBranchDiffFile`. */
export type GitBranchDiffFile = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
};

/** A whole branch against its merge base. Mirrors `GitBranchDiff`. */
export type GitBranchDiff = {
  baseBranch: string;
  branch: string;
  mergeBase: string;
  diff: string;
  additions: number;
  deletions: number;
  files: GitBranchDiffFile[];
};

/** Mirrors `GitCommit`. */
export type GitCommit = {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  authorEmail: string;
  /** Unix seconds. */
  timestamp: number;
  refs: string[];
};

/** Mirrors `GitBranch`. */
export type GitBranch = {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  ahead: number;
  behind: number;
  lastSubject: string;
};

/** Mirrors `GitLog`. */
export type GitLog = {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Unix millis of the last `git fetch`. */
  lastFetchMs: number | null;
  commits: GitCommit[];
  branches: GitBranch[];
  /** Newest first. */
  tags: GitTag[];
  /** `origin/HEAD`'s branch, else a local main/master, else null. */
  defaultBranch: string | null;
};

/** Mirrors `GitTag`. */
export type GitTag = {
  name: string;
  /** The tagged commit's subject. */
  subject: string;
  /** Unix seconds. */
  timestamp: number;
};

/** Mirrors `CommitFile`. */
export type CommitFile = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
};

/** One commit in full, for the history detail pane. Mirrors `CommitDetails`. */
export type CommitDetails = {
  hash: string;
  shortHash: string;
  subject: string;
  /** Message body after the subject line; may be empty. */
  body: string;
  author: string;
  authorEmail: string;
  /** Unix seconds. */
  timestamp: number;
  refs: string[];
  files: CommitFile[];
  diff: string;
  additions: number;
  deletions: number;
};

/** Mirrors `GitStash`. */
export type GitStash = {
  index: number;
  branch: string;
  message: string;
  /** Unix seconds. */
  timestamp: number;
};

/** Mirrors `PullRequest` in `git/github.rs`. */
export type PullRequest = {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  author: string;
  headRef: string;
  baseRef: string;
  url: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  comments: number;
  /** Distinct commenter logins, first-seen order — drives the avatar stack. */
  commentAuthors: string[];
  /** Unix millis. */
  updatedAtMs: number;
  badge: "open" | "merged" | "closed" | "draft";
  isCurrentBranch: boolean;
  /** null = unavailable; [] = no reported checks. Current PR head only. */
  checks: { name: string; state: string }[] | null;
};

/** Mirrors `PrComment`. */
export type PrComment = {
  author: string;
  body: string;
  /** Unix millis. */
  createdAtMs: number;
};

/** Mirrors `PrCommit`. */
export type PrCommit = {
  shortHash: string;
  headline: string;
  author: string;
  /** Unix millis. */
  createdAtMs: number;
};

/** Mirrors `PullRequestDetails`. Rust repeats the `PullRequest` fields; the
 *  intersection keeps that relationship visible instead of restating them. */
export type PullRequestDetails = PullRequest & {
  body: string;
  mergeable: string;
  reviewDecision: string;
  /** Pending review requests, users or team slugs; null = unavailable. */
  requestedReviewers: string[] | null;
  /** Authors of submitted reviews, retained after a request is fulfilled. */
  reviewedBy: string[];
  commentThread: PrComment[];
  commits: PrCommit[];
  /** Unix millis. */
  createdAtMs: number;
};

export type StashAction = "push" | "pop";

export type PrMergeMethod = "merge" | "squash" | "rebase";

// ── Working tree ─────────────────────────────────────────────────────────────

export function gitStatus(workspaceRoot: string): Promise<GitStatus> {
  return invoke<GitStatus>("git_status", { workspaceRoot });
}

export function gitStage(workspaceRoot: string, path: string): Promise<void> {
  return invoke("git_stage", { workspaceRoot, path });
}

export function gitUnstage(workspaceRoot: string, path: string): Promise<void> {
  return invoke("git_unstage", { workspaceRoot, path });
}

export function gitCommit(workspaceRoot: string, message: string): Promise<void> {
  return invoke("git_commit", { workspaceRoot, message });
}

export function gitDiscard(workspaceRoot: string, path: string): Promise<void> {
  return invoke("git_discard", { workspaceRoot, path });
}

/** One file's diff, working tree or index. Images return before/after data
 *  URIs; untracked text files return a synthesized new-file diff. */
export function gitDiff(workspaceRoot: string, path: string, staged: boolean): Promise<GitDiff> {
  return invoke<GitDiff>("git_diff", { workspaceRoot, path, staged });
}

export function gitBranchDiff(
  workspaceRoot: string,
  branch: string,
  baseBranch?: string | null,
): Promise<GitBranchDiff> {
  return invoke<GitBranchDiff>("git_branch_diff", {
    workspaceRoot,
    branch,
    baseBranch: baseBranch ?? null,
  });
}

// ── History ──────────────────────────────────────────────────────────────────

export function gitLog(workspaceRoot: string, limit?: number): Promise<GitLog> {
  return invoke<GitLog>("git_log", { workspaceRoot, limit: limit ?? null });
}

export function gitGraph(workspaceRoot: string, limit?: number): Promise<GraphCommit[]> {
  return invoke<GraphCommit[]>("git_graph", { workspaceRoot, limit: limit ?? null });
}

export function gitCommitDetails(workspaceRoot: string, hash: string): Promise<CommitDetails> {
  return invoke<CommitDetails>("git_commit_details", { workspaceRoot, hash });
}

// ── Branches and remotes ─────────────────────────────────────────────────────

export function gitCheckoutBranch(workspaceRoot: string, branch: string): Promise<void> {
  return invoke("git_checkout_branch", { workspaceRoot, branch });
}

export function gitFetch(workspaceRoot: string, remote?: string | null): Promise<string> {
  return invoke<string>("git_fetch", { workspaceRoot, remote: remote ?? null });
}

export function gitPull(workspaceRoot: string): Promise<string> {
  return invoke<string>("git_pull", { workspaceRoot });
}

export function gitPush(workspaceRoot: string): Promise<string> {
  return invoke<string>("git_push", { workspaceRoot });
}

// ── Stash ────────────────────────────────────────────────────────────────────

export function gitStash(
  workspaceRoot: string,
  action: StashAction,
  message?: string | null,
): Promise<string> {
  return invoke<string>("git_stash", { workspaceRoot, action, message: message ?? null });
}

export function gitStashList(workspaceRoot: string): Promise<GitStash[]> {
  return invoke<GitStash[]>("git_stash_list", { workspaceRoot });
}

// ── Worktrees ────────────────────────────────────────────────────────────────

export function gitWorktreeAdd(
  workspaceRoot: string,
  branch: string,
  copyFiles?: string[] | null,
): Promise<WorktreeInfo> {
  return invoke<WorktreeInfo>("git_worktree_add", {
    workspaceRoot,
    branch,
    copyFiles: copyFiles ?? null,
  });
}

export function gitWorktreeList(workspaceRoot: string): Promise<WorktreeInfo[]> {
  return invoke<WorktreeInfo[]>("git_worktree_list", { workspaceRoot });
}

export function gitWorktreeMerge(workspaceRoot: string, branch: string): Promise<string> {
  return invoke<string>("git_worktree_merge", { workspaceRoot, branch });
}

export type WorktreeRemoveOptions = {
  force?: boolean;
  /** Recipe-created files to delete before removing (recipe `cleanFiles`). */
  cleanFiles?: string[] | null;
  /** Branch to delete along with the worktree, when Klide created it. */
  deleteBranch?: string | null;
};

export function gitWorktreeRemove(
  workspaceRoot: string,
  path: string,
  options: WorktreeRemoveOptions = {},
): Promise<void> {
  return invoke("git_worktree_remove", {
    workspaceRoot,
    path,
    force: options.force ?? false,
    cleanFiles: options.cleanFiles ?? null,
    deleteBranch: options.deleteBranch ?? null,
  });
}

// ── Pull requests (gh) ───────────────────────────────────────────────────────

export function gitPrList(workspaceRoot: string): Promise<PullRequest[]> {
  return invoke<PullRequest[]>("git_pr_list", { workspaceRoot });
}

export function gitPrView(workspaceRoot: string, number: number): Promise<PullRequestDetails> {
  return invoke<PullRequestDetails>("git_pr_view", { workspaceRoot, number });
}

export function gitPrCheckout(workspaceRoot: string, number: number): Promise<string> {
  return invoke<string>("git_pr_checkout", { workspaceRoot, number });
}

export function gitPrMerge(
  workspaceRoot: string,
  number: number,
  method: PrMergeMethod = "merge",
): Promise<string> {
  return invoke<string>("git_pr_merge", { workspaceRoot, number, method });
}

export function gitPrOpen(workspaceRoot: string, number: number): Promise<string> {
  return invoke<string>("git_pr_open", { workspaceRoot, number });
}

export function gitPrMerged(workspaceRoot: string, number: number): Promise<boolean> {
  return invoke<boolean>("git_pr_merged", { workspaceRoot, number });
}

// ── GitHub account (gh) ──────────────────────────────────────────────────────

/** Mirrors `GitHubUser` in `git/github.rs`. */
export type GitHubUser = {
  login: string;
  avatarUrl: string;
};

/** Mirrors `GitHubAccounts`. `pinned` is Klide's own choice; when it's null,
 *  Klide follows `active` — whichever account `gh auth switch` last selected. */
export type GitHubAccounts = {
  logins: string[];
  active: string | null;
  pinned: string | null;
};

/** The identity Klide acts as: the pin, else gh's active account. */
export function githubCurrentUser(): Promise<GitHubUser> {
  return invoke<GitHubUser>("github_current_user");
}

export function githubAccounts(): Promise<GitHubAccounts> {
  return invoke<GitHubAccounts>("github_accounts");
}

/** Pin Klide to one signed-in account, or pass null to follow gh again.
 *  Resolves to the identity now in force. */
export function githubSetAccount(login: string | null): Promise<GitHubUser> {
  return invoke<GitHubUser>("github_set_account", { login });
}

/** Open a pull request for the workspace's current branch. Resolves to the PR
 *  URL. Named `create_pr` rather than `git_*`, which is how it slipped past
 *  `every_git_command_has_a_frontend_wrapper` and stayed a raw invoke in two
 *  components. */
export function createPr(
  workspaceRoot: string | null,
  title: string,
  body: string | null
): Promise<string> {
  return invoke<string>("create_pr", { workspaceRoot, title, body });
}

/** GitHub avatar URLs for commit authors, keyed by the email queried. Missing
 *  entries mean "no GitHub user matched" — callers fall back to initials. */
export function githubCommitAvatars(
  workspaceRoot: string,
  queries: { hash: string; email: string }[]
): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("github_commit_avatars", { workspaceRoot, queries });
}
