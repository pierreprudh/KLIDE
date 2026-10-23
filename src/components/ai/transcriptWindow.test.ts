import { describe, expect, it } from "vitest";
import type { Msg } from "./types";
import { transcriptWindowStart, TRANSCRIPT_PAGE_TURNS } from "./transcriptWindow";

function exchanges(count: number): Msg[] {
  return Array.from({ length: count }, (_, i): Msg[] => [
    { role: "user", content: `Question ${i}` },
    { role: "assistant", content: "Reading", toolCalls: [{ id: `call-${i}`, name: "read_file", args: {} }] },
    { role: "tool", content: "Result", toolName: "read_file", toolCallId: `call-${i}` },
    { role: "assistant", content: `Answer ${i}` },
  ]).flat();
}

describe("transcript rendering window", () => {
  it("retains complete exchanges, including tool calls and results", () => {
    const messages = exchanges(100);
    const start = transcriptWindowStart(messages);
    expect(start).toBe(76 * 4);
    expect(messages[start]).toEqual({ role: "user", content: "Question 76" });
    expect(messages.slice(start)).toHaveLength(24 * 4);
  });

  it("reveals earlier exchanges until the beginning is reachable", () => {
    const messages = exchanges(50);
    const first = transcriptWindowStart(messages);
    const earlier = transcriptWindowStart(messages, TRANSCRIPT_PAGE_TURNS, first);
    expect(earlier).toBe(10 * 4);
    expect(transcriptWindowStart(messages, TRANSCRIPT_PAGE_TURNS, earlier)).toBe(0);
    expect(messages).toHaveLength(200);
  });

  it("keeps the active answer mounted even with many queued prompts", () => {
    const messages: Msg[] = [
      ...exchanges(30),
      ...Array.from({ length: 40 }, (): Msg => ({ role: "user", content: "Next", queueState: "queued" })),
    ];
    expect(transcriptWindowStart(messages)).toBe(6 * 4);
  });

  it("counts observer and worker follow-ups as whole exchanges", () => {
    const messages: Msg[] = [
      ...exchanges(1),
      { role: "system", content: "Observer finished", observer: { shellId: "shell-1" } },
      { role: "assistant", content: "Observer answer" },
      { role: "system", content: "Worker finished", workerReport: { childRunId: "worker-1", ok: true } },
      { role: "assistant", content: "Worker answer" },
    ];
    expect(transcriptWindowStart(messages, 2)).toBe(4);
    expect(transcriptWindowStart(messages, 1)).toBe(6);
  });

  it("keeps short histories and a single long tool exchange intact", () => {
    expect(transcriptWindowStart([])).toBe(0);
    expect(transcriptWindowStart(exchanges(3))).toBe(0);
    const messages: Msg[] = [{ role: "user", content: "Work" }, ...Array.from({ length: 200 }, (): Msg => ({ role: "assistant", content: "Step" }))];
    expect(transcriptWindowStart(messages)).toBe(0);
  });
});
