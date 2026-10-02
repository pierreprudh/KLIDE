import type { Msg } from "./types";

/** Empty main-response rows carry activity only while they own the live tail. */
export function assistantPlaceholder(m: Msg, streaming: boolean, isLast: boolean): "working" | "hidden" | null {
  const empty = m.role === "assistant" && m.content === "" && !m.thinking && !m.toolCalls?.length && !m.subagent && !m.delegateConsole;
  if (!empty) return null;
  return streaming && isLast ? "working" : "hidden";
}
