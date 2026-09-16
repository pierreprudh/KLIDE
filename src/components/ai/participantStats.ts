import type { Msg } from "./types";
import type { Run } from "../../runs";

/** Metrics sit apart by space, not by a dot: an em space, which the mono
 *  stats line keeps (it never collapses whitespace). */
export const METRIC_GAP = "\u2003";

/** What a worker child's run record can say about itself: how long it ran,
 *  how many messages, real tokens and cost when its source recorded them.
 *  A worker has no stored conversation of its own, so this is its whole
 *  stats line. */
export function workerRunStats(run: Pick<Run, "messageCount" | "inputTokens" | "outputTokens" | "costUsd" | "createdMs" | "updatedMs">): string {
  const parts: string[] = [];
  const ms = run.updatedMs - run.createdMs;
  if (ms > 0) parts.push(ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);
  if (run.messageCount > 0) parts.push(`${run.messageCount} ${run.messageCount === 1 ? "message" : "messages"}`);
  const tokens = (run.inputTokens ?? 0) + (run.outputTokens ?? 0);
  if (tokens > 0) parts.push(`${tokens.toLocaleString("en-US")} tokens`);
  if (run.costUsd !== undefined && run.costUsd !== null) {
    parts.push(run.costUsd === 0 ? "$0" : run.costUsd < 0.01 ? "<$0.01" : `$${run.costUsd.toFixed(2)}`);
  }
  return parts.length ? parts.join(METRIC_GAP) : "Stats unavailable";
}

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
  return parts.length ? `Last response${METRIC_GAP}${parts.join(METRIC_GAP)}` : "Stats unavailable";
}
