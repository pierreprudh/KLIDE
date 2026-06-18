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

  // A run that ended in failure (e.g. the provider returned a 500) has no
  // assistant turn to fold, so a resumed panel would otherwise show the user
  // message and nothing else — reading as an empty or hung run. Surface the
  // error as a trailing system line so the resumed view explains itself.
  // `aborted` (a user-initiated Stop) is intentionally silent, matching the
  // live run path in AiPanel.
  const runError = events.find(
    (e): e is Extract<AgentEvent, { type: "run_error" }> =>
      e.type === "run_error" && e.error.code !== "aborted",
  );
  if (runError) {
    msgs.push({
      role: "system",
      content: `Run failed: ${runError.error.message}`,
    });
  }

  return {
    id: runId,
    title,
    msgs,
    updatedAt: Date.now(),
  };
}
