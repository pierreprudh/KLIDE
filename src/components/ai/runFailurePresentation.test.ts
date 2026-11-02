import { describe, expect, it } from "vitest";
import { groupToolRuns, pairToolResults } from "./toolRuns";
import { runFailurePresentation } from "./runFailurePresentation";
import type { Msg } from "./types";

const failed: Msg = { role: "system", content: "", runError: { message: "OpenCode exited with exit status: 1", retryable: true } };
const work: Msg = { role: "assistant", content: "", thinking: "Inspect files", toolCalls: [{ name: "read_file", args: {} }] };
const answer: Msg = { role: "assistant", content: "Here is the project report." };
function presentation(msgs: Msg[]) {
  return runFailurePresentation(msgs, groupToolRuns(msgs, pairToolResults(msgs)));
}

describe("run failure presentation", () => {
  it("places a failure after received output at its activity header", () => {
    const msgs: Msg[] = [{ role: "user", content: "Report" }, work, answer, failed];
    expect(presentation(msgs).get(3)).toEqual({ hasOutput: true, activityStart: 1 });
  });

  it("does not describe reasoning or tool narration as received response text", () => {
    expect(presentation([work, failed]).get(1)).toEqual({ hasOutput: false, activityStart: 0 });
    expect(presentation([{ role: "assistant", content: "<think>Still thinking</think>" }, failed]).get(1)?.hasOutput).toBe(false);
  });

  it("does not borrow output or activity from a previous attempt", () => {
    const msgs: Msg[] = [work, answer, failed, { role: "user", content: "Continue" }, failed];
    expect(presentation(msgs).get(4)).toEqual({ hasOutput: false, activityStart: undefined });
    expect(presentation([work, answer, failed, failed]).get(3)).toEqual({ hasOutput: false, activityStart: undefined });
  });

  it("keeps received text when there was no activity fold", () => {
    expect(presentation([answer, failed]).get(1)).toEqual({ hasOutput: true, activityStart: undefined });
  });

  it("ignores queued prompts when finding the failed attempt", () => {
    const msgs: Msg[] = [work, { role: "user", content: "Next", queueState: "queued" }, answer, failed];
    expect(presentation(msgs).get(3)?.hasOutput).toBe(true);
  });
});
