import { expect, it } from "vitest";
import { participantStats } from "./participantStats";
it("uses the latest measured response rather than claiming a task total", () => {
  expect(participantStats([
    { role: "assistant", content: "old", meta: { tokens: 1000, exact: true } },
    { role: "assistant", content: "new", meta: { tokens: 12, exact: true, modelMs: 1500, costUsd: 0.002 } },
  ])).toBe("Last response · 12 tokens · 1.5s model · <$0.01");
});
it("keeps missing stats unavailable and preserves estimates and zero values", () => {
  expect(participantStats([])).toBe("Stats unavailable");
  expect(participantStats([{ role: "assistant", content: "", meta: { tokens: 0, costUsd: 0 } }])).toBe("Last response · ~0 tokens · $0");
});
