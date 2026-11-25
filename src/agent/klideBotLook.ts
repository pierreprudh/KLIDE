import type { AgentAttachment } from "./types";
import type { BotMention, MentionWorkspace } from "../ipc/klideBot";
import { klideBotLook } from "../ipc/klideBot";

export async function prepareMentionTurn(mention: BotMention) {
  const workspace = await klideBotLook(mention);
  return { workspace, turn: klideBotLookTurn(mention, workspace) };
}

export function mentionAsk(body: string): string {
  return body.replace(/@klide-bot\b[,:]?\s*/gi, "").replace(/\s+/g, " ").trim();
}

export function klideBotLookTurn(m: BotMention, ws: MentionWorkspace): { text: string; attachment: AgentAttachment } {
  const full = mentionAsk(m.body);
  const ask = full.length > 300 ? `${full.slice(0, 299)}…` : full;
  return {
    text: `Look into PR #${m.prNumber} “${ws.title}” (${ws.url}). @${m.author} asked: “${ask}”. Investigate the code and explain your findings before making changes. Do not post a GitHub reply or push commits.`,
    attachment: { path: `PR #${m.prNumber} thread.md`, content: ws.context },
  };
}
