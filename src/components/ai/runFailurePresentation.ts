import type { Msg } from "./types";
import { visibleProse, type ToolRun } from "./toolRuns";

/** Presentation only: receiving text never changes the Run's failed status. */
export function runFailurePresentation(msgs: Msg[], runs: ToolRun[]) {
  const failures = new Map<number, { hasOutput: boolean; activityStart?: number }>();
  let start = 0;
  let hasOutput = false;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if ((m.role === "user" && m.queueState !== "queued") ||
        (m.role === "system" && (m.observer || m.workerReport || m.completion || m.runInterrupted))) {
      start = i + 1;
      hasOutput = false;
    }
    if (m.role === "assistant" && !m.subagent && !m.toolCalls?.length && visibleProse(m)) hasOutput = true;
    if (m.role === "system" && m.runError) {
      // The last activity stretch in this attempt owns the notice. It stays
      // outside the disclosure so closing the tools cannot hide the error.
      let activity: ToolRun | undefined;
      for (const run of runs) {
        if (run.start >= start && run.end <= i) activity = run;
      }
      failures.set(i, { hasOutput, activityStart: activity?.start });
      start = i + 1;
      hasOutput = false;
    }
  }
  return failures;
}
