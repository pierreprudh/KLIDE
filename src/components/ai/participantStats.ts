import type { Msg } from "./types";

/** Latest measured response, never a guessed total for the external process. */
export function participantStats(msgs: Msg[]): string {
  const response = [...msgs].reverse().find((msg) => msg.role === "assistant" && msg.meta);
  if (!response || response.role !== "assistant" || !response.meta) return "Stats unavailable";
  const meta = response.meta;
  const parts: string[] = [];
  if (meta.tokens !== undefined) parts.push(`${meta.exact ? "" : "~"}${meta.tokens.toLocaleString()} tokens`);
  const ms = meta.modelMs ?? meta.ms;
  if (ms !== undefined) parts.push(`${(ms / 1000).toFixed(1)}s ${meta.modelMs !== undefined ? "model" : "elapsed"}`);
  if (meta.costUsd !== undefined) parts.push(meta.costUsd === 0 ? "$0" : meta.costUsd < 0.01 ? "<$0.01" : `$${meta.costUsd.toFixed(2)}`);
  return parts.length ? `Last response · ${parts.join(" · ")}` : "Stats unavailable";
}
