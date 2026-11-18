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
