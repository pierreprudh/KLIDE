// Genuinely misc AI-panel helpers: CSS var reads, ids, token estimates, and
// re-exported shared formatters. The Stored conversation index and the
// per-panel Conversation binding live in `storedConversations.ts`.

import { invoke } from "@tauri-apps/api/core";
import type { Msg } from "./types";
import type { ProjectContextItem } from "../../contextTray";

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Exact token count for a string under a specific model's own tokenizer, where
// the provider exposes one (Ollama /api/tokenize, Anthropic count_tokens);
// otherwise a length-based estimate with `exact: false`. Counts message
// content only — the chat-template wrapper the model also sees is not included,
// so per-message counts won't sum to a full-prompt total.
export async function countMessageTokens(
  provider: string,
  model: string,
  text: string,
): Promise<{ count: number; exact: boolean }> {
  const res = await invoke<{ tokens: number; exact: boolean }>("ai_count_tokens", {
    provider,
    model,
    text,
  });
  return { count: res.tokens, exact: res.exact };
}

export function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Tokens for a Lens slice. Lived in `contextTray.ts` with its own inline
 *  `/ 3.7`, a second copy of the constant `estimateTokens` owns — on the
 *  auto-compaction path, where a drift arms a paid call at the wrong moment. It
 *  could not simply call across, because `contextTray` is imported *by* this
 *  module; re-homing it here removes the duplicate and the cycle at once. */
export function estimateProjectContextTokens(items: ProjectContextItem[]): number {
  return items.reduce(
    (sum, item) => sum + estimateTokens(`${item.path}\n${item.label}\n${item.detail}`),
    0
  );
}

export function estimateTokens(text: string): number {
  if (!text.trim()) return 0;
  return Math.ceil(text.length / 3.7);
}

/** What one attached image costs in context. The real number is geometric
 *  (Anthropic bills roughly `width * height / 750`, OpenAI tiles similarly),
 *  and a data URI carries no dimensions — so a screenshot-sized flat estimate
 *  stands in. Zero, which is what a photo used to cost here, made a vision
 *  turn look free: the context meter under-read and auto-compaction waited
 *  too long. */
export const IMAGE_TOKEN_ESTIMATE = 1_300;

export function messageTokenEstimate(m: Msg): number {
  const p = messageTokenParts(m);
  return p.prompts + p.answers + p.reasoning + p.tools + p.other;
}

/** Where one message's tokens sit — the context popover's Messages detail.
 *  `messageTokenEstimate` is their sum, so the two never disagree. */
export type MessageTokenParts = { prompts: number; answers: number; reasoning: number; tools: number; other: number };

export function messageTokenParts(m: Msg): MessageTokenParts {
  const parts: MessageTokenParts = { prompts: 0, answers: 0, reasoning: 0, tools: 0, other: 0 };
  if (m.role === "user") {
    parts.prompts = estimateTokens(m.content);
    if (m.attachments) {
      parts.prompts += m.attachments.reduce(
        (sum, a) =>
          sum +
          estimateTokens(a.path) +
          (a.dataUri ? IMAGE_TOKEN_ESTIMATE : estimateTokens(a.content)),
        0
      );
    }
    if (m.projectContext) parts.prompts += estimateProjectContextTokens(m.projectContext.items);
  } else if (m.role === "assistant") {
    parts.answers = estimateTokens(m.content);
    parts.reasoning = estimateTokens(m.thinking ?? "");
    parts.tools = estimateTokens(JSON.stringify(m.toolCalls ?? []));
  } else if (m.role === "tool") {
    parts.tools = estimateTokens(m.content) + estimateTokens(m.toolName);
  } else {
    parts.other = estimateTokens(m.content);
  }
  return parts;
}


export { formatSpan, relativeTime } from "../../time";


/** The AI panel's `@file` picker and the command palette rank the same way —
 *  see `fileSearch.ts`. They used to have two implementations with the same four
 *  tiers in opposite polarity, so one query gave two orders. */
export { rankFiles as fuzzyFiles, isSubsequence } from "../../fileSearch";
