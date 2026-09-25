import type { AgentMode } from "../../agent/types";

/**
 * The Mode a wake turn runs in: the conversation's own. Every Mode is on the
 * coordination plane (Chat carries the agent tools and nothing else), so a
 * wake never needs more authority than the thread already has — promoting a
 * Chat thread to Plan would hand a peer's message file and shell reads the
 * operator never chose.
 */
export function wakeTurnMode(current: AgentMode): AgentMode {
  return current;
}
