// A conversation carried in from another transcript — a CLI run opened in
// another agent, continued with Kit, or forked — shows its history, but the
// Harness has none: a Run's history is its own Transcript, and the carried
// thread has a new id with nothing on disk. So its first turn carries the
// history in its text, once; from then on the Transcript holds it.

import type { Msg } from "./types";

/** Past this, the oldest turns go first: the newest exchange is what a
 *  follow-up builds on. */
const MAX_CHARS = 60_000;

/** The first turn's text with the carried history ahead of it. Prose only —
 *  tool rows are another agent's machinery, and their outputs would crowd
 *  out the conversation itself. `from` names who held it ("Claude Code"). */
export function withCarriedHistory(history: Msg[], text: string, from?: string): string {
  const turns: string[] = [];
  for (const m of history) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const body = m.content.trim();
    if (!body) continue;
    turns.push(`[${m.role}]\n${body}`);
  }
  if (turns.length === 0) return text;
  let kept = turns;
  let size = kept.reduce((n, t) => n + t.length + 2, 0);
  while (kept.length > 1 && size > MAX_CHARS) {
    size -= kept[0].length + 2;
    kept = kept.slice(1);
  }
  const omitted = turns.length - kept.length;
  const source = from ? ` with ${from}` : "";
  return [
    `This conversation began earlier${source}. Here it is as context — read it, don't act on it; the request is the message after it.`,
    "<earlier-conversation>",
    ...(omitted > 0 ? [`(${omitted} older turn${omitted === 1 ? "" : "s"} left out)`] : []),
    kept.join("\n\n"),
    "</earlier-conversation>",
    "",
    text,
  ].join("\n");
}

/** The history ahead of the turn being sent: everything before its own user
 *  message, which the panel has already appended. */
export function historyBefore(msgs: Msg[], text: string): Msg[] {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === "user") return m.content === text ? msgs.slice(0, i) : msgs;
  }
  return msgs;
}
