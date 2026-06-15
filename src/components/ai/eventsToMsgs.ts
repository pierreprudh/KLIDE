import type { AgentEvent } from "../../agent/types";
import { foldAgentEvents, foldedToMsgs } from "../../agent/foldEvents";
import type { Conversation, Msg } from "./types";

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
  return foldedToMsgs(foldAgentEvents(events));
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
