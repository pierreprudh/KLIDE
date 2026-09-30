import { describe, expect, it } from "vitest";
import { humanTokens, resetLabel, usageTone } from "./usage";

describe("usage presentation", () => {
  it("says a Codex window reset since the reading instead of showing a stale time", () => {
    expect(resetLabel({ label: "Session", percent: 0, resetsAtMs: null, seenAtMs: 1 })).toBe("Reset since last run");
  });
  it("marks a reset already in the past as in progress", () => {
    expect(resetLabel({ label: "Weekly", percent: 40, resetsAtMs: 1_000, seenAtMs: null }, 2_000)).toBe("Resetting…");
  });
  it("turns severe at the same thresholds as the island", () => {
    expect([usageTone(69), usageTone(70), usageTone(90)]).toEqual(["calm", "warning", "danger"]);
  });
  it("shortens token counts", () => {
    expect([humanTokens(4_044_730), humanTokens(812_400), humanTokens(90)]).toEqual(["4.0M", "812K", "90"]);
  });
});
