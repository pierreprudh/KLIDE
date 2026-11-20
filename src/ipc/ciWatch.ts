// ci_watch_* — the CI watch trigger (src-tauri/src/agent/ci_watch.rs). The
// scheduled service polls `gh` for your open PRs in a watched Workspace and
// starts one read-only Run per commit whose checks failed.

import { invoke } from "@tauri-apps/api/core";
import { toStartRunRequest } from "../agent/client";
import type { StartAgentRunInput } from "../agent/types";

export type CiWatchFired = {
  key: string; workspaceRoot: string; prNumber: number; prTitle: string; prUrl: string;
  checks: string[]; provider: string; model: string; runId: string | null; error: string | null; at: number; announced: boolean;
};

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
