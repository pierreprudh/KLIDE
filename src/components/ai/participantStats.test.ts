import { describe, expect, it } from "vitest";
import { METRIC_GAP as G, participantStats, workerRunStats } from "./participantStats";
it("uses the latest measured response rather than claiming a task total", () => {
  expect(participantStats([
    { role: "assistant", content: "old", meta: { tokens: 1000, exact: true } },
    { role: "assistant", content: "new", meta: { tokens: 12, exact: true, modelMs: 1500, costUsd: 0.002 } },
  ])).toBe(`Last response${G}12 tokens${G}1.5s model${G}<$0.01`);
});
it("keeps missing stats unavailable and preserves estimates and zero values", () => {
  expect(participantStats([])).toBe("Stats unavailable");
  expect(participantStats([{ role: "assistant", content: "", meta: { tokens: 0, costUsd: 0 } }])).toBe(`Last response${G}~0 tokens${G}$0`);
});

describe("workerRunStats", () => {
  it("reads duration, messages, tokens and cost off a worker's run record", () => {
    expect(workerRunStats({ messageCount: 3, inputTokens: 14005, outputTokens: 2000, costUsd: 0.34, createdMs: 0, updatedMs: 7_700 }))
      .toBe(`7.7s${G}3 messages${G}16,005 tokens${G}$0.34`);
    expect(workerRunStats({ messageCount: 1, costUsd: null, createdMs: 0, updatedMs: 125_000 }))
      .toBe(`2m 5s${G}1 message`);
  });

  it("says so when the record holds nothing", () => {
    expect(workerRunStats({ messageCount: 0, createdMs: 5, updatedMs: 5 })).toBe("Stats unavailable");
  });
});
