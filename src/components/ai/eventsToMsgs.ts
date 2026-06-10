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

  // Transcript events carry real timestamps — derive each turn's duration
  // from the gap between the previous user/tool event and the assistant
  // message, so replayed runs show the same meta footer as live ones.
  let turnStartTs: number | undefined;

  for (const event of events) {
    switch (event.type) {
      case "user_message":
        turnStartTs = event.ts;
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
        const ms = turnStartTs !== undefined && event.ts >= turnStartTs ? event.ts - turnStartTs : undefined;
        turnStartTs = event.ts;
        const estimated = Math.round((text.length + (thinkingBlock?.text.length ?? 0)) / 4);
        // Replay prefers the provider's real count when the transcript
        // carries one — old transcripts (pre-usage) will be replayed with
        // the estimate, which matches the behavior those runs had live.
        const usage = event.usage;
        const tokens = usage?.completionTokens !== undefined ? usage.completionTokens : estimated;
        let tps: number | undefined;
        if (
          usage?.completionTokens !== undefined &&
          usage?.evalDurationMs !== undefined &&
          usage.evalDurationMs > 0
        ) {
          tps = Math.round(usage.completionTokens / (usage.evalDurationMs / 1000));
        }
        msgs.push({
          role: "assistant",
          content: text,
          thinking: thinkingBlock?.text,
          toolCalls: toolBlocks.length
            ? toolBlocks.map((t) => ({ id: t.toolCallId, name: t.name, args: JSON.stringify(t.input) }))
            : undefined,
          meta: ms !== undefined || tokens || tps ? { ms, tokens: tokens || undefined, tps, exact: usage?.completionTokens !== undefined } : undefined,
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
