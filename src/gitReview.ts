// The Git Review model — the pure policy behind `components/GitReview.tsx`,
// in the same spirit as `gitGraph.ts`: derivations over the wire types plus
// the outcome of every mutating action (its notice text, which surface data
// it must re-fetch, and which selections it clears). The component stays a
// view: it calls the ipc wrapper, then applies the returned outcome.

import type { GitFile } from "./gitTypes";
import type { PrComment, PrCommit, PullRequest, PullRequestDetails } from "./ipc/git";

// ── Derivations ──────────────────────────────────────────────────────────────

/** Two views, as on GitHub's own list: what is in flight and what is done. A
 *  draft is an open PR that is not ready yet, so it lives under Open wearing
 *  its Draft badge; Closed holds the merged and the closed-unmerged, and each
 *  row's badge says which. Four segments (Open · Draft · Merged · All) mirrored
 *  the badge's four states, not a question anyone asks the panel. */
export type PullRequestFilter = "open" | "closed";

export function visiblePrs(prs: PullRequest[], filter: PullRequestFilter): PullRequest[] {
  return prs.filter((pr) => (filter === "open" ? isOpenPr(pr) : !isOpenPr(pr)));
}

function isOpenPr(pr: PullRequest): boolean {
  return pr.badge === "open" || pr.badge === "draft";
}

/** Per-badge counts; `open` excludes drafts so the head can say "2 open,
 *  1 draft". The Open segment shows open + draft, Closed shows merged + closed. */
export type PrCounts = { open: number; draft: number; merged: number; closed: number };

export function prCounts(prs: PullRequest[]): PrCounts {
  return {
    open: prs.filter((pr) => pr.badge === "open").length,
    draft: prs.filter((pr) => pr.badge === "draft").length,
    merged: prs.filter((pr) => pr.badge === "merged").length,
    closed: prs.filter((pr) => pr.badge === "closed").length,
  };
}

export function splitStatusFiles(files: GitFile[]): { stagedFiles: GitFile[]; changedFiles: GitFile[] } {
  return {
    stagedFiles: files.filter((f) => f.staged),
    changedFiles: files.filter((f) => !f.staged),
  };
}

/** The status-bar change count — every working-tree entry, staged or not. */
export function totalAdditions(files: GitFile[]): number {
  const { stagedFiles, changedFiles } = splitStatusFiles(files);
  return changedFiles.length + stagedFiles.length;
}

/** One entry of the PR conversation timeline: commits and comments
 *  interleaved in time, after the opening description. */
export type PrTimelineEvent =
  | { kind: "commit"; at: number; commit: PrCommit }
  | { kind: "comment"; at: number; comment: PrComment };

export function mergePrTimeline(
  detail: Pick<PullRequestDetails, "commits" | "commentThread">
): PrTimelineEvent[] {
  const events: PrTimelineEvent[] = [
    ...detail.commits.map((c) => ({ kind: "commit" as const, at: c.createdAtMs, commit: c })),
    ...detail.commentThread.map((c) => ({ kind: "comment" as const, at: c.createdAtMs, comment: c })),
  ];
  // Stable sort: a commit and a comment with the same timestamp keep
  // commits-first order, matching the input concatenation above.
  events.sort((a, b) => a.at - b.at);
  return events;
}

// ── Action outcomes ──────────────────────────────────────────────────────────

/** Data the surface re-fetches after an action lands, in order. */
export type GitReviewRefresh = "status" | "log" | "prs" | "stashes";

/** What one successful Git Review action does to the surface. Failures apply
 *  none of it — the runner shows the error notice and stops. */
export type GitActionOutcome = {
  /** Success notice text; also the in-flight action label. */
  message: string;
  refresh: GitReviewRefresh[];
  /** Close the open file diff (back to the history graph). */
  closeDiff?: boolean;
  /** Clear the commit-message field. */
  clearCommitMessage?: boolean;
  /** Close the branch switcher menu. */
  closeBranchMenu?: boolean;
  /** Collapse the expanded PR card (the action consumed it). */
  collapseExpandedPr?: boolean;
  /** Close the PR composer overlay. */
  closePrComposer?: boolean;
};

export function stageFileOutcome(): GitActionOutcome {
  return { message: "Staged", refresh: ["status"] };
}

export function unstageFileOutcome(): GitActionOutcome {
  return { message: "Unstaged", refresh: ["status"] };
}

export function discardFileOutcome(): GitActionOutcome {
  return { message: "Discarded", refresh: ["status"] };
}

/** Keep the stacked section open after a discard; if its selected file was
 *  removed, select the next working file. A staged diff is unaffected. */
export function selectionAfterDiscard<T extends { path: string; staged: boolean }>(
  open: T | null,
  discardedPath: string,
  changedFiles: readonly Pick<GitFile, "path">[],
): T | null {
  if (!open || open.staged || open.path !== discardedPath) return open;
  const next = changedFiles.find((file) => file.path !== discardedPath);
  return next ? { ...open, path: next.path } : null;
}

export function stageAllOutcome(): GitActionOutcome {
  return { message: "Staged all", refresh: ["status"] };
}

export function unstageAllOutcome(): GitActionOutcome {
  return { message: "Unstaged all", refresh: ["status"] };
}

export function commitOutcome(): GitActionOutcome {
  return { message: "Committed", refresh: ["status"], clearCommitMessage: true, closeDiff: true };
}

export function fetchOutcome(): GitActionOutcome {
  return { message: "Fetched", refresh: ["log", "prs"] };
}

export function pullOutcome(): GitActionOutcome {
  return { message: "Pulled", refresh: ["log", "status"] };
}

export function pushOutcome(): GitActionOutcome {
  return { message: "Pushed", refresh: ["log", "prs"] };
}

export function checkoutBranchOutcome(name: string): GitActionOutcome {
  // On failure the menu stays open, so the miss is visible where it happened.
  return {
    message: `Switched to ${name}`,
    refresh: ["log", "status"],
    closeBranchMenu: true,
    closeDiff: true,
  };
}

export function stashPushOutcome(): GitActionOutcome {
  return { message: "Stashed", refresh: ["stashes", "status"] };
}

export function stashPopOutcome(): GitActionOutcome {
  return { message: "Stash popped", refresh: ["stashes", "status"] };
}

export function openPrInBrowserOutcome(): GitActionOutcome {
  return { message: "Opened in browser", refresh: [] };
}

export function checkoutPrOutcome(n: number, expandedPr: number | null): GitActionOutcome {
  return {
    message: `Checked out #${n}`,
    refresh: ["log", "status", "prs"],
    collapseExpandedPr: expandedPr === n,
  };
}

export function mergePrOutcome(n: number, expandedPr: number | null): GitActionOutcome {
  // Log first: the merge command has already fetched, so the graph can draw
  // the merge commit in while the slower GitHub re-fetch is still in flight.
  return {
    message: `Merged #${n}`,
    refresh: ["log", "status", "prs"],
    collapseExpandedPr: expandedPr === n,
  };
}

export function submitPrOutcome(): GitActionOutcome {
  return { message: "Pull request created", refresh: ["prs"], closePrComposer: true };
}

// ── Branch menu ──────────────────────────────────────────────────────────────

/** The agent whose mark leads a branch row, read off the branch's first path
 *  segment. Delegates name their branches `codex/…` and `claude/…`; Klide's
 *  own isolated Runs are `klide/…` (see `runIsolation.ts`). A remote-tracking
 *  branch is read past its remote (`origin/codex/x` → codex). */
export type BranchAgentMark = "codex" | "claude-code" | "klide";

export function branchAgentMark(name: string, isRemote = false): BranchAgentMark | null {
  const segments = name.split("/");
  const head = isRemote && segments.length > 2 ? segments[1] : segments[0];
  if (head === "codex") return "codex";
  if (head === "claude") return "claude-code";
  if (head === "klide") return "klide";
  return null;
}

/** Alphabetical, case-insensitive, stable — the menu is a list to scan, not a
 *  recency feed. Locals and remotes interleave by name (`origin/…` sorts as a
 *  block under o, which is where a reader looks for it). */
export function sortBranchesForMenu<T extends { name: string }>(branches: readonly T[]): T[] {
  return [...branches].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** How one branch name is typeset in the menu. The remote is lifted out of a
 *  remote-tracking name (it becomes the section eyebrow), an agent prefix is
 *  replaced by that agent's mark, and any other `scope/` prefix is kept but
 *  set dim so the leaf reads first. */
export type BranchDisplay = {
  remote: string | null;
  agent: BranchAgentMark | null;
  /** The dim `scope/` prefix — null when there is none or an agent mark took it. */
  prefix: string | null;
  /** The part set strong. */
  leaf: string;
};

export function branchDisplay(name: string, isRemote = false): BranchDisplay {
  const segments = name.split("/");
  const remote = isRemote && segments.length > 1 ? segments[0] : null;
  const local = remote ? segments.slice(1) : segments;
  const agent = branchAgentMark(name, isRemote);
  if (agent) return { remote, agent, prefix: null, leaf: local.slice(1).join("/") || local[0] };
  if (local.length > 1) return { remote, agent: null, prefix: local.slice(0, -1).join("/") + "/", leaf: local[local.length - 1] };
  return { remote, agent: null, prefix: null, leaf: local[0] };
}

/** One row of the branch menu. Locals and their remote-tracking twins are
 *  one row — a reader thinks in branch names, not refs. A branch that exists
 *  only on the remote is still listed (checking it out creates the local). */
export type MenuBranch = {
  name: string;
  isCurrent: boolean;
  isDefault: boolean;
  /** No local ref yet — only `origin/<name>` (or another remote's). */
  remoteOnly: boolean;
  ahead: number;
  behind: number;
  lastSubject: string;
};

/** Merge local + remote refs by branch name, default branch first, then
 *  alphabetical. A local ref wins over its remote twin (it carries the real
 *  ahead/behind and current flags). */
export function mergeBranchesForMenu(
  branches: readonly { name: string; isCurrent: boolean; isRemote: boolean; ahead: number; behind: number; lastSubject: string }[],
  defaultBranch: string | null,
): MenuBranch[] {
  const byName = new Map<string, MenuBranch>();
  for (const b of branches) {
    const name = b.isRemote ? (b.name.split("/").slice(1).join("/") || b.name) : b.name;
    const existing = byName.get(name);
    if (existing && !existing.remoteOnly) continue; // local already there
    if (existing && b.isRemote) continue; // second remote for a remote-only name
    byName.set(name, {
      name,
      isCurrent: b.isCurrent,
      isDefault: name === defaultBranch,
      remoteOnly: b.isRemote,
      ahead: b.isRemote ? 0 : b.ahead,
      behind: b.isRemote ? 0 : b.behind,
      lastSubject: b.lastSubject,
    });
  }
  return [...byName.values()].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

// These are observations, not permission to merge: required-check policy,
// unresolved review threads and local validation are not in this snapshot.
export type PrSignalTone = "quiet" | "attention" | "success" | "muted";
export type PrReadinessSignal = { label: string; value: string; tone: PrSignalTone };
const FAILED_CHECK_STATES = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);
const PENDING_CHECK_STATES = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "EXPECTED"]);

export function prCheckPresentation(state: string): { label: string; tone: PrSignalTone } {
  if (FAILED_CHECK_STATES.has(state)) return { label: state === "CANCELLED" ? "Cancelled" : state === "TIMED_OUT" ? "Timed out" : state === "ACTION_REQUIRED" ? "Action needed" : state === "STALE" ? "Stale" : "Failed", tone: "attention" };
  if (PENDING_CHECK_STATES.has(state)) return { label: state === "IN_PROGRESS" ? "Running" : "Pending", tone: "quiet" };
  if (state === "SUCCESS") return { label: "Passed", tone: "success" };
  return { label: state === "SKIPPED" ? "Skipped" : state === "NEUTRAL" ? "Neutral" : "Unknown", tone: "muted" };
}

export function prReadinessSignals(
  detail: Pick<PullRequestDetails, "mergeable" | "reviewDecision" | "checks"> & Partial<Pick<PullRequestDetails, "requestedReviewers">>,
): PrReadinessSignal[] {
  const checks = detail.checks;
  let checkValue = "Unavailable";
  let checkTone: PrSignalTone = "muted";
  if (checks) {
    if (checks.length === 0) checkValue = "None reported";
    else {
      const failed = checks.filter(c => FAILED_CHECK_STATES.has(c.state)).length;
      const pending = checks.filter(c => PENDING_CHECK_STATES.has(c.state)).length;
      const passed = checks.filter(c => c.state === "SUCCESS").length;
      const other = checks.length - failed - pending - passed;
      checkValue = [failed ? `${failed} failed` : "", pending ? `${pending} pending` : "", passed ? `${passed} passed` : "", other ? `${other} other` : ""].filter(Boolean).join(" · ");
      checkTone = failed ? "attention" : passed === checks.length ? "success" : pending ? "quiet" : "muted";
    }
  }
  const assigned = (detail.requestedReviewers?.length ?? 0) > 0;
  const review: PrReadinessSignal = detail.reviewDecision === "CHANGES_REQUESTED"
    ? { label: "Review", value: "Changes requested", tone: "attention" }
    : assigned ? { label: "Review", value: "Assigned", tone: "quiet" }
    : detail.reviewDecision === "APPROVED" ? { label: "Review", value: "Done", tone: "success" }
    : detail.reviewDecision === "REVIEW_REQUIRED" ? { label: "Review", value: "Required", tone: "quiet" }
    : { label: "Review", value: "None reported", tone: "muted" };
  return [
    { label: "Checks", value: checkValue, tone: checkTone },
    review,
    { label: "Conflicts", value: detail.mergeable === "CONFLICTING" ? "Resolve conflicts" : detail.mergeable === "MERGEABLE" ? "None reported" : "Not yet determined", tone: detail.mergeable === "CONFLICTING" ? "attention" : "muted" },
  ];
}
