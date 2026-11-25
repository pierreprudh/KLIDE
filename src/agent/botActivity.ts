import type { BotMention } from "../ipc/klideBot";
import { mentionAsk } from "./klideBotLook";

export function botActivityLabel(m: Pick<BotMention, "kind" | "verdict">): string {
  if (m.kind === "review_request") return "Review requested";
  if (m.kind === "review") return m.verdict === "pass" ? "Review passed" : m.verdict === "fail" ? "Review found issues" : "Review result";
  return m.kind === "reply" ? "Bot reply" : "Mention";
}

export function botActivitySummary(m: Pick<BotMention, "kind" | "body">): string {
  if (!m.kind || m.kind === "mention") return mentionAsk(m.body) || "Mentioned @klide-bot";
  if (m.kind === "review_request") return m.body.trim();
  const body = m.body.replace(/^<!--.*?-->[^\n]*\n?/, "").replace(/<sub>[^]*?<\/sub>/g, "");
  const paragraph = body.split(/\n\s*\n/).map(p => p.trim()).find(p => p && !p.startsWith("#") && !p.startsWith("**Review**") && !p.startsWith("VERDICT:")) ?? "Open the full result on GitHub.";
  const flat = paragraph.replace(/[*`]/g, "").replace(/\s+/g, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 299)}…` : flat;
}

export type BotActivityFilter = "all" | "mentions" | "reviews";

export function activityMatchesFilter(m: BotMention, filter: BotActivityFilter): boolean {
  if (filter === "all") return true;
  const review = m.kind === "review" || m.kind === "review_request";
  return filter === "reviews" ? review : !review;
}

export type BotActivityThread = { key: string; prNumber: number; events: BotMention[] };

/** GitHub comments do not carry reply-to IDs. Keep each PR's conversation
 * together, retaining the timestamps rather than inventing request/reply pairs. */
export function botActivityThreads(items: BotMention[], filter: BotActivityFilter): BotActivityThread[] {
  const threads = new Map<string, BotActivityThread>();
  const events = [...items].filter(m => activityMatchesFilter(m, filter))
    .sort((a, b) => b.at - a.at || b.commentId - a.commentId);
  for (const event of events) {
    const key = `${event.repo}#${event.prNumber}`;
    const thread = threads.get(key);
    if (thread) thread.events.push(event);
    else threads.set(key, { key, prNumber: event.prNumber, events: [event] });
  }
  return [...threads.values()];
}
