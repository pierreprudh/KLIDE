import type { Msg } from "./types";

export type ResponseCost = { costUsd: number; calls: number };

/** All known model costs behind an answer, including folded tool steps.
 * Keep per-call metadata intact: the conversation total sums those originals,
 * never these derived totals. Manual compaction has its own visible charge. */
export function responseCosts(msgs: Msg[]): Map<number, ResponseCost> {
  const totals = new Map<number, ResponseCost>();
  let costUsd = 0;
  let calls = 0;
  let last = -1;
  const flush = () => {
    if (last >= 0 && calls > 0) totals.set(last, { costUsd, calls });
    costUsd = 0;
    calls = 0;
    last = -1;
  };
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === "user" || (m.role === "system" && (m.observer || m.workerReport || m.compaction?.source === "manual"))) flush();
    if (m.role === "assistant") {
      last = i;
      if (m.meta?.costUsd !== undefined) {
        costUsd += m.meta.costUsd;
        calls++;
      }
    } else if (m.role === "system" && m.compaction?.source !== "manual" && m.compaction?.costUsd !== undefined) {
      costUsd += m.compaction.costUsd;
      calls++;
    }
  }
  flush();
  return totals;
}
