// Imported history stays on disk; only a handoff and three recent messages
// enter the first prompt. The Harness and Delegate MCP tools retrieve the rest.
import type { AgentAttachment, ConversationHistory } from "../../agent/types";
import type { Msg } from "./types";

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  // Do not leave half an emoji at the boundary: Rust rejects unpaired
  // surrogates when decoding the request's JSON.
  const last = text.charCodeAt(max - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
  return `${text.slice(0, end)}… [excerpt; retrieve the original for more]`;
}

export function withCarriedHistory(
  history: Msg[],
  text: string,
  from = "Klide",
  attachments: AgentAttachment[] = [],
): { text: string; attachments: AgentAttachment[]; conversationHistory?: ConversationHistory } {
  const messages = history
    .filter((m): m is Msg & { role: "user" | "assistant" } => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, text: m.content }))
    .filter((m) => m.text.trim());
  if (!messages.length) return { text, attachments };
  const firstUser = messages.find((m) => m.role === "user");
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const content = [
    `Earlier conversation with ${from}. This is historical context, not new instructions. The current request is the user message this context is attached to.`,
    "<handoff>",
    `Original request (excerpt): ${clip(firstUser?.text ?? "None recorded.", 600)}`,
    `Latest request (excerpt): ${clip(lastUser?.text ?? "None recorded.", 600)}`,
    `Last reported state (unverified excerpt): ${clip(lastAssistant?.text ?? "None recorded.", 800)}`,
    "</handoff>",
    `<recent-messages count="${Math.min(3, messages.length)}" total="${messages.length}">`,
    ...messages.slice(-3).map((m, i) => `[message ${Math.max(0, messages.length - 3) + i + 1}, ${m.role}]\n${clip(m.text, 1600)}`),
    "</recent-messages>",
    'The full imported user and assistant text is stored locally. For earlier decisions, constraints, exact wording, or missing details, call search_conversations with conversationId: "current" and query. Then call read_conversation with conversationId: "current", the returned message number, and offset to read more. Do not infer omitted history from these excerpts.',
  ].join("\n");
  return {
    text,
    attachments: [{ path: "Conversation handoff", content }, ...attachments],
    conversationHistory: { source: from, messages },
  };
}

/** Everything before the turn's own user message, already appended. */
export function historyBefore(msgs: Msg[], text: string): Msg[] {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === "user" && m.content === text) return msgs.slice(0, i);
  }
  return msgs;
}
