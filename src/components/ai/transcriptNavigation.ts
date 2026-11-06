import type { Msg } from "./types";
import { splitThinking, stripPlanJson } from "../markdown";
import { isExchangeBoundary, TRANSCRIPT_WINDOW_TURNS } from "./transcriptWindow";

export type ConversationMatch = {
  index: number;
  field: string;
  text: string;
  offset: number;
  length: number;
  occurrence: number;
};
export type TranscriptRange = { start: number; end: number };

/** Search the existing reader projection, including activity hidden by folds.
 * No transcript parsing, DOM indexing, regular expressions, or image payloads. */
export function searchConversation(messages: readonly Msg[], query: string, options: { includeReasoning?: boolean } = {}): ConversationMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: ConversationMatch[] = [];
  messages.forEach((message, index) => {
    if ((message.role === "user" && message.wake) || (message.role === "system" && message.completion)) return;
    const fields: [string, string][] = [];
    if (message.role === "assistant") {
      const inline = splitThinking(message.content);
      const plan = stripPlanJson(inline.content);
      fields.push(["Answer", plan.content]);
      if (options.includeReasoning) {
        const thinking = [message.thinking, inline.thinking, plan.thinking].filter(Boolean).join("\n\n");
        fields.push(["Reasoning", thinking]);
      }
      message.toolCalls?.forEach(call => fields.push([call.name, `${call.name}\n${typeof call.args === "string" ? call.args : JSON.stringify(call.args) ?? ""}`]));
    } else {
      fields.push([message.role === "user" ? "You" : message.role === "tool" ? message.toolName : "Activity", message.content]);
    }
    if (message.role === "user") message.attachments?.forEach(a => fields.push(["Attachment", a.path]));
    for (const [field, text] of fields) {
      const lower = text.toLowerCase();
      let offset = 0;
      let occurrence = 0;
      while ((offset = lower.indexOf(needle, offset)) !== -1) {
        matches.push({ index, field, text, offset, length: needle.length, occurrence: occurrence++ });
        offset += needle.length;
      }
    }
  });
  return matches;
}

/** A range around a target, bounded at whole exchanges. A single unusually
 * large exchange stays whole, just as it does in the recent-history window. */
export function rangeAroundMessage(messages: readonly Msg[], index: number, turns = TRANSCRIPT_WINDOW_TURNS): TranscriptRange {
  if (!messages.length) return { start: 0, end: 0 };
  const target = Math.max(0, Math.min(index, messages.length - 1));
  const starts = [0];
  for (let i = 1; i < messages.length; i++) if (isExchangeBoundary(messages[i])) starts.push(i);
  let exchange = 0;
  while (exchange + 1 < starts.length && starts[exchange + 1] <= target) exchange++;
  const count = Math.max(1, turns);
  const first = Math.max(0, Math.min(exchange - Math.floor(count / 2), starts.length - count));
  return { start: starts[first], end: starts[first + count] ?? messages.length };
}
