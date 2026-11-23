// "Look into it" on a klide-bot mention — the first Work turn.
//
// What you see is one short line naming who asked what; the PR's description,
// thread and diff ride along as an attached note, fenced as data. The
// conversation runs in a worktree at the PR's head, so Kit reads the PR's own
// code. Every edit still goes through review, and pushing is a command the
// person approves.

import type { AgentAttachment } from "./types";
import type { KlideBotLook, KlideBotMention } from "../ipc/klideBot";

/** The comment without the handle, flattened. */
export function mentionAsk(m: Pick<KlideBotMention, "excerpt">): string {
  return m.excerpt.replace(/@klide-bot\b[,:]?\s*/i, "").trim();
}

export function klideBotLookTurn(m: KlideBotMention, ws: KlideBotLook): { text: string; attachment: AgentAttachment } {
  const full = (m.body || m.excerpt).replace(/@klide-bot\b[,:]?\s*/gi, "").replace(/\s+/g, " ").trim();
  // The whole comment is in the note; the line only names it.
  const ask = full.length > 300 ? `${full.slice(0, 299).trimEnd()}…` : full;
  const push = ws.crossRepo || !ws.headRef
    ? "This PR's branch can't be pushed from here."
    : `If a change is needed, commit it here; pushing is \`git push origin HEAD:${ws.headRef}\`.`;
  const text = `@${m.author} asked about #${m.prNumber}: “${ask}” — take a look. ${push}`;
  return { text, attachment: { path: `PR #${m.prNumber} thread.md`, content: ws.context } };
}
