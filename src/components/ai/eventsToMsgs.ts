import type { AgentEvent } from "../../agent/types";
import type { Msg, Conversation } from "./types";

type RunMeta = {
  mode: "chat" | "plan" | "goal";
  provider: string;
  model: string;
};

/** Extract run metadata from the run_started event. */
export function extractRunMeta(events: AgentEvent[]): RunMeta | null {
  const first = events[0];
  if (first?.type === "run_started") {
    return { mode: first.mode, provider: first.provider, model: first.model };
  }
  return null;
}

/** Convert a full Klide agent transcript into AiPanel-compatible messages. */
export function eventsToMsgs(events: AgentEvent[]): Msg[] {
  const msgs: Msg[] = [];
  const toolNameMap = new Map<string, string>();

  for (const event of events) {
    if (event.type === "tool_call_started") {
      toolNameMap.set(event.toolCallId, event.name);
    }
  }

  for (const event of events) {
    switch (event.type) {
      case "user_message":
        msgs.push({
          role: "user",
          content: event.text,
          attachments: event.attachments?.length ? event.attachments : undefined,
        });
        break;
      case "assistant_message": {
        const textBlocks = event.content.filter((b): b is { type: "text"; text: string } => b.type === "text");
        const text = textBlocks.map((b) => b.text).join("");
        const thinkingBlock = event.content.find((b): b is { type: "thinking"; text: string } => b.type === "thinking");
        const toolBlocks = event.content.filter((b): b is { type: "tool_call"; toolCallId: string; name: string; input: unknown } => b.type === "tool_call");
        msgs.push({
          role: "assistant",
          content: text,
          thinking: thinkingBlock?.text,
          toolCalls: toolBlocks.length
            ? toolBlocks.map((t) => ({ id: t.toolCallId, name: t.name, args: JSON.stringify(t.input) }))
            : undefined,
        });
        break;
      }
      case "tool_call_finished":
        msgs.push({
          role: "tool",
          content: event.result.content,
          toolName: toolNameMap.get(event.toolCallId) ?? "",
          toolCallId: event.toolCallId,
        });
        break;
    }
  }
  return msgs;
}

/** Reconstruct a Conversation from events for AiPanel resumption. */
export function eventsToConversation(
  events: AgentEvent[],
  runId: string,
  title: string,
): Conversation {
  const meta = extractRunMeta(events);
  const msgs = eventsToMsgs(events);

  if (meta) {
    msgs.unshift({
      role: "system",
      content: `Run: ${meta.mode} · ${meta.provider}/${meta.model}`,
    });
  }

  return {
    id: runId,
    title,
    msgs,
    updatedAt: Date.now(),
  };
}
