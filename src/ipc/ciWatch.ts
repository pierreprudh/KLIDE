// ci_watch_* — the CI watch trigger (src-tauri/src/agent/ci_watch.rs). The
// scheduled service polls `gh` for your open PRs in a watched Workspace and
// starts one read-only Run per commit whose checks failed.

import { invoke } from "@tauri-apps/api/core";
import { toStartRunRequest } from "../agent/client";
import type { StartAgentRunInput } from "../agent/types";

export type CiWatchFired = {
  key: string; workspaceRoot: string; prNumber: number; prTitle: string; prUrl: string;
  checks: string[]; provider: string; model: string; runId: string | null; error: string | null; at: number; announced: boolean;
  /** What became of the failure since, followed by the watch's own poll
   *  (`Now` in ci_watch.rs). Absent: still failed as fired. */
  now?: CiWatchNow | null;
};

export type CiWatchNow = "running" | "passed" | "failing" | "moved" | "closed";

/** What became of a firing, in a word or two (Mission Control's row). */
export function ciNowLabel(now: CiWatchNow): string {
  return { running: "Running again", passed: "Passed since", failing: "Failed again", moved: "Newer commit", closed: "PR closed" }[now];
}

/** Whether "Fix it" still has something to fix. */
export function ciFailureStands(now: CiWatchNow | null | undefined): boolean {
  return !now || now === "running" || now === "failing";
}

export type CiWatchInfo = {
  enabled: boolean; provider: string | null; model: string | null;
  enabledAt: number | null; lastPollAt: number | null; lastError: string | null;
  fired: CiWatchFired[];
};

export function ciWatchGet(workspaceRoot: string): Promise<CiWatchInfo> {
  return invoke("ci_watch_get", { workspaceRoot });
}

/** `input: null` stops watching. The input is the Run each firing starts from;
 *  Rust forces it read-only (Plan) and fills in the prompt. */
export function ciWatchSet(workspaceRoot: string, input: StartAgentRunInput | null): Promise<CiWatchInfo> {
  return invoke("ci_watch_set", { workspaceRoot, request: input ? toStartRunRequest(input) : null });
}

/** Firings not yet shown, each returned once (Rust marks them announced and
 *  posts the Klide notification). Called on load and on `ci-watch:pending`. */
export function ciWatchTake(): Promise<CiWatchFired[]> {
  return invoke("ci_watch_take");
}

/** Where "Fix it" works: a fresh worktree checked out at the PR's failing
 *  commit (reused on a second click). */
export type CiFixWorkspace = {
  cwd: string; branch: string; sha: string;
  headRef: string | null; crossRepo: boolean;
};

export function ciWatchFixPrepare(key: string): Promise<CiFixWorkspace> {
  return invoke("ci_watch_fix_prepare", { key });
}
