// klide_bot_* — `@klide-bot` on your pull requests, brought to you
// (src-tauri/src/agent/klide_bot.rs). The scheduled service records each
// mention; "Look into it" opens Kit in a worktree at the PR's head.

import { invoke } from "@tauri-apps/api/core";
import { toStartRunRequest } from "../agent/client";
import type { StartAgentRunInput } from "../agent/types";

export type KlideBotMention = {
  key: string; workspaceRoot: string; repo: string; prNumber: number; prTitle: string;
  commentUrl: string; author: string; excerpt: string; body: string;
  provider: string; model: string; at: number; announced: boolean; notified: boolean;
};

export type KlideBotInfo = {
  enabled: boolean; provider: string | null; model: string | null;
  enabledAt: number | null; lastPollAt: number | null; lastError: string | null;
  mentions: KlideBotMention[];
};

export type KlideBotLook = {
  cwd: string; branch: string; sha: string;
  headRef: string | null; crossRepo: boolean;
  /** The PR's description, thread and diff — the attached note. */
  context: string;
};

export function klideBotGet(workspaceRoot: string): Promise<KlideBotInfo> {
  return invoke("klide_bot_get", { workspaceRoot });
}

/** `input: null` turns the bot off. The input only names the agent "Look
 *  into it" opens on; nothing runs by itself. */
export function klideBotSet(workspaceRoot: string, input: StartAgentRunInput | null): Promise<KlideBotInfo> {
  return invoke("klide_bot_set", { workspaceRoot, request: input ? toStartRunRequest(input) : null });
}

/** Mentions not yet toasted, each returned once. */
export function klideBotTake(): Promise<KlideBotMention[]> {
  return invoke("klide_bot_take");
}

/** A worktree at the PR's head and the note the conversation starts with. */
export function klideBotLook(key: string): Promise<KlideBotLook> {
  return invoke("klide_bot_look", { key });
}
