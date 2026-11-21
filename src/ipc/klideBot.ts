// klide_bot_* — Kit answering `@klide-bot` on your pull requests
// (src-tauri/src/agent/klide_bot.rs). The scheduled service starts a
// read-only Run per mention; its answer waits as a draft until you post it.

import { invoke } from "@tauri-apps/api/core";
import { toStartRunRequest } from "../agent/client";
import type { StartAgentRunInput } from "../agent/types";

export type KlideBotMention = {
  key: string; workspaceRoot: string; repo: string; prNumber: number; prTitle: string;
  commentUrl: string; author: string; excerpt: string; provider: string; model: string;
  runId: string | null; error: string | null; at: number;
  draft: string | null; postedUrl: string | null; announced: boolean; notified: boolean;
};

export type KlideBotInfo = {
  enabled: boolean; provider: string | null; model: string | null;
  enabledAt: number | null; lastPollAt: number | null; lastError: string | null;
  mentions: KlideBotMention[];
};

export function klideBotGet(workspaceRoot: string): Promise<KlideBotInfo> {
  return invoke("klide_bot_get", { workspaceRoot });
}

/** `input: null` turns the bot off. Rust forces each Run read-only (Plan). */
export function klideBotSet(workspaceRoot: string, input: StartAgentRunInput | null): Promise<KlideBotInfo> {
  return invoke("klide_bot_set", { workspaceRoot, request: input ? toStartRunRequest(input) : null });
}

/** Drafts (and failures) not yet toasted, each returned once. */
export function klideBotTake(): Promise<KlideBotMention[]> {
  return invoke("klide_bot_take");
}

/** Post the draft as a signed reply under your GitHub account; the comment's URL. */
export function klideBotPost(key: string): Promise<string> {
  return invoke("klide_bot_post", { key });
}
