// klide_bot_* — klide-bot's settings on GitHub (src-tauri/src/bot_settings.rs).
// The bots run in GitHub Actions on `klide run`; what they run on is two
// repository variables, read and set through Klide's pinned `gh` account.

import { invoke } from "@tauri-apps/api/core";

export type BotKind = "answer" | "review";

export type BotSettings = {
  repo: string;
  answerInstalled: boolean;
  reviewInstalled: boolean;
  /** `provider/model`; null when the bot is off. */
  answerModel: string | null;
  reviewModel: string | null;
  /** Providers whose key secret the repository holds. */
  keyedProviders: string[];
  appIdentity: boolean;
};

export function klideBotSettings(workspaceRoot: string): Promise<BotSettings> {
  return invoke("klide_bot_settings", { workspaceRoot });
}

/** `model: null` turns that bot off. */
export function klideBotSetModel(workspaceRoot: string, bot: BotKind, model: string | null): Promise<BotSettings> {
  return invoke("klide_bot_set_model", { workspaceRoot, bot, model });
}

/** `openrouter/nvidia/x:free` → provider `openrouter`, model `nvidia/x:free`. */
export function splitBotModel(value: string | null): { provider: string; model: string } | null {
  const i = value?.indexOf("/") ?? -1;
  return value && i > 0 ? { provider: value.slice(0, i), model: value.slice(i + 1) } : null;
}
