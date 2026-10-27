import { describe, expect, it } from "vitest";
import type { GitFile } from "./gitTypes";
import type { PrComment, PrCommit, PullRequest } from "./ipc/git";
import {
  checkoutBranchOutcome,
  checkoutPrOutcome,
  commitOutcome,
  discardFileOutcome,
  selectionAfterDiscard,
  fetchOutcome,
  mergePrOutcome,
  mergePrTimeline,
  openPrInBrowserOutcome,
  prCounts,
  pullOutcome,
  pushOutcome,
  splitStatusFiles,
  stageAllOutcome,
  stageFileOutcome,
  stashPopOutcome,
  stashPushOutcome,
  submitPrOutcome,
  totalAdditions,
  unstageAllOutcome,
  unstageFileOutcome,
  visiblePrs,
  type GitActionOutcome,
  branchAgentMark,
  branchDisplay,
  mergeBranchesForMenu,
  sortBranchesForMenu,
} from "./gitReview";

function pr(number: number, badge: PullRequest["badge"]): PullRequest {
  return {
    number,
    title: `PR ${number}`,
    state: badge === "draft" ? "OPEN" : badge.toUpperCase(),
    isDraft: badge === "draft",
    author: "pierre",
    headRef: `feature/${number}`,
    baseRef: "main",
    url: `https://github.com/x/y/pull/${number}`,
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    comments: 0,
    commentAuthors: [],
    updatedAtMs: 0,
    badge,
    isCurrentBranch: false,
  };
}

function commit(at: number, headline: string): PrCommit {
  return { shortHash: headline.slice(0, 7), headline, author: "pierre", createdAtMs: at };
}

function comment(at: number, body: string): PrComment {
  return { author: "reviewer", body, createdAtMs: at };
}

describe("PR timeline merge", () => {
  it("interleaves commits and comments by timestamp, ascending", () => {
    const events = mergePrTimeline({
      commits: [commit(30, "third"), commit(10, "first")],
      commentThread: [comment(20, "in between"), comment(40, "last word")],
    });
    expect(events.map((e) => e.at)).toEqual([10, 20, 30, 40]);
    expect(events.map((e) => e.kind)).toEqual(["commit", "comment", "commit", "comment"]);
  });

  it("keeps a commit ahead of a comment sharing its timestamp (stable ties)", () => {
    const events = mergePrTimeline({
      commits: [commit(20, "same instant")],
      commentThread: [comment(20, "also same instant"), comment(5, "earlier")],
    });
    expect(events.map((e) => e.kind)).toEqual(["comment", "commit", "comment"]);
  });

  it("passes every event through untouched — one entry per input", () => {
    const commits = [commit(1, "a"), commit(2, "b")];
    const thread = [comment(3, "c")];
    const events = mergePrTimeline({ commits, commentThread: thread });
    expect(events).toHaveLength(3);
    expect(events.filter((e) => e.kind === "commit").map((e) => e.commit)).toEqual(commits);
    expect(events.filter((e) => e.kind === "comment").map((e) => e.comment)).toEqual(thread);
  });

  it("handles an empty conversation", () => {
    expect(mergePrTimeline({ commits: [], commentThread: [] })).toEqual([]);
  });
});

describe("PR list derivations", () => {
  const list = [pr(1, "open"), pr(2, "draft"), pr(3, "merged"), pr(4, "closed"), pr(5, "open")];

  it("splits PRs into in-flight and done: drafts count as open, closed-unmerged as closed", () => {
    // Drafts are open PRs that are not ready, so they sit under Open; Closed
    // is merged and closed-unmerged together — the row's badge tells them apart.
    expect(visiblePrs(list, "open").map((p) => p.number)).toEqual([1, 2, 5]);
    expect(visiblePrs(list, "closed").map((p) => p.number)).toEqual([3, 4]);
  });

  it("counts per badge, closed-unmerged included", () => {
    expect(prCounts(list)).toEqual({ open: 2, draft: 1, merged: 1, closed: 1 });
    expect(prCounts([])).toEqual({ open: 0, draft: 0, merged: 0, closed: 0 });
  });
});

describe("working-tree derivations", () => {
  const files: GitFile[] = [
    { path: "a.ts", status: "M", staged: true },
    { path: "b.ts", status: "M", staged: false },
    { path: "c.ts", status: "??", staged: false },
  ];

  it("splits staged from changed, keeping order", () => {
    const { stagedFiles, changedFiles } = splitStatusFiles(files);
    expect(stagedFiles.map((f) => f.path)).toEqual(["a.ts"]);
    expect(changedFiles.map((f) => f.path)).toEqual(["b.ts", "c.ts"]);
  });

  it("totals every entry, staged or not", () => {
    expect(totalAdditions(files)).toBe(3);
    expect(totalAdditions([])).toBe(0);
  });
});

describe("action outcomes — the refresh policy per action", () => {
  // The table the component used to hide in 20 ad-hoc handlers.
  const table: [string, GitActionOutcome, GitActionOutcome][] = [
    ["stage file", stageFileOutcome(), { message: "Staged", refresh: ["status"] }],
    ["unstage file", unstageFileOutcome(), { message: "Unstaged", refresh: ["status"] }],
    ["stage all", stageAllOutcome(), { message: "Staged all", refresh: ["status"] }],
    ["unstage all", unstageAllOutcome(), { message: "Unstaged all", refresh: ["status"] }],
    [
      "commit",
      commitOutcome(),
      { message: "Committed", refresh: ["status"], clearCommitMessage: true, closeDiff: true },
    ],
    ["fetch", fetchOutcome(), { message: "Fetched", refresh: ["log", "prs"] }],
    ["pull", pullOutcome(), { message: "Pulled", refresh: ["log", "status"] }],
    ["push", pushOutcome(), { message: "Pushed", refresh: ["log", "prs"] }],
    [
      "checkout branch",
      checkoutBranchOutcome("main"),
      { message: "Switched to main", refresh: ["log", "status"], closeBranchMenu: true, closeDiff: true },
    ],
    ["stash push", stashPushOutcome(), { message: "Stashed", refresh: ["stashes", "status"] }],
    ["stash pop", stashPopOutcome(), { message: "Stash popped", refresh: ["stashes", "status"] }],
    ["open PR in browser", openPrInBrowserOutcome(), { message: "Opened in browser", refresh: [] }],
    [
      "checkout PR",
      checkoutPrOutcome(7, null),
      { message: "Checked out #7", refresh: ["log", "status", "prs"], collapseExpandedPr: false },
    ],
    [
      "merge PR",
      mergePrOutcome(7, null),
      { message: "Merged #7", refresh: ["log", "status", "prs"], collapseExpandedPr: false },
    ],
    [
      "submit PR",
      submitPrOutcome(),
      { message: "Pull request created", refresh: ["prs"], closePrComposer: true },
    ],
  ];

  it.each(table)("%s", (_name, actual, expected) => {
    expect(actual).toEqual(expected);
  });

  it("discard refreshes the stack without closing the entire section", () => {
    expect(discardFileOutcome()).toEqual({ message: "Discarded", refresh: ["status"] });
  });

  it("discarding the selected file moves to another file, or closes an empty stack", () => {
    const open = { path: "a.ts", staged: false };
    expect(selectionAfterDiscard(open, "a.ts", [{ path: "a.ts" }, { path: "b.ts" }]))
      .toEqual({ path: "b.ts", staged: false });
    expect(selectionAfterDiscard(open, "a.ts", [{ path: "a.ts" }])).toBeNull();
  });

  it("discarding another file or a working copy leaves the current staged diff alone", () => {
    const working = { path: "a.ts", staged: false };
    const staged = { path: "a.ts", staged: true };
    expect(selectionAfterDiscard(working, "b.ts", [{ path: "a.ts" }])).toBe(working);
    expect(selectionAfterDiscard(staged, "a.ts", [])).toBe(staged);
    expect(selectionAfterDiscard(null, "a.ts", [])).toBeNull();
  });

  it("acting on the expanded PR collapses it; acting on another leaves it open", () => {
    expect(mergePrOutcome(7, 7).collapseExpandedPr).toBe(true);
    expect(mergePrOutcome(7, 3).collapseExpandedPr).toBe(false);
    expect(checkoutPrOutcome(7, 7).collapseExpandedPr).toBe(true);
    expect(checkoutPrOutcome(7, 3).collapseExpandedPr).toBe(false);
  });
});

describe("branch menu — order and agent marks", () => {
  it("reads the agent off the first segment, past a remote", () => {
    expect(branchAgentMark("codex/agent-coordination")).toBe("codex");
    expect(branchAgentMark("claude/fix-thing")).toBe("claude-code");
    expect(branchAgentMark("klide/goal-title-ab12")).toBe("klide");
    expect(branchAgentMark("origin/codex/agent-coordination", true)).toBe("codex");
    expect(branchAgentMark("origin/main", true)).toBeNull();
    expect(branchAgentMark("feat/auto-model-routing")).toBeNull();
    expect(branchAgentMark("main")).toBeNull();
  });

  it("sorts alphabetically, case-insensitively, without mutating the input", () => {
    const input = [{ name: "origin/main" }, { name: "main" }, { name: "Feat/x" }, { name: "codex/y" }];
    const sorted = sortBranchesForMenu(input);
    expect(sorted.map((b) => b.name)).toEqual(["codex/y", "Feat/x", "main", "origin/main"]);
    expect(input[0].name).toBe("origin/main");
  });
});

describe("branch menu — display and grouping", () => {
  it("lifts the remote, swaps an agent prefix for its mark, dims other prefixes", () => {
    expect(branchDisplay("codex/agent-coordination")).toEqual({ remote: null, agent: "codex", prefix: null, leaf: "agent-coordination" });
    expect(branchDisplay("origin/codex/agent-coordination", true)).toEqual({ remote: "origin", agent: "codex", prefix: null, leaf: "agent-coordination" });
    expect(branchDisplay("feat/auto-model-routing")).toEqual({ remote: null, agent: null, prefix: "feat/", leaf: "auto-model-routing" });
    expect(branchDisplay("origin/main", true)).toEqual({ remote: "origin", agent: null, prefix: null, leaf: "main" });
    expect(branchDisplay("main")).toEqual({ remote: null, agent: null, prefix: null, leaf: "main" });
  });

  it("merges a local with its remote twin, keeps remote-only rows, pins the default first", () => {
    const rows = mergeBranchesForMenu([
      { name: "origin/main", isCurrent: false, isRemote: true, ahead: 0, behind: 0, lastSubject: "remote main" },
      { name: "feat/x", isCurrent: true, isRemote: false, ahead: 2, behind: 0, lastSubject: "x" },
      { name: "origin/feat/x", isCurrent: false, isRemote: true, ahead: 0, behind: 0, lastSubject: "x" },
      { name: "main", isCurrent: false, isRemote: false, ahead: 0, behind: 1, lastSubject: "local main" },
      { name: "origin/codex/y", isCurrent: false, isRemote: true, ahead: 0, behind: 0, lastSubject: "y" },
    ], "main");
    expect(rows.map((r) => [r.name, r.isDefault, r.isCurrent, r.remoteOnly, r.ahead, r.behind])).toEqual([
      ["main", true, false, false, 0, 1],
      ["codex/y", false, false, true, 0, 0],
      ["feat/x", false, true, false, 2, 0],
    ]);
    expect(rows[0].lastSubject).toBe("local main");
  });
});
