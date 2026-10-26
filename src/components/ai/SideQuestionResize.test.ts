import { describe, expect, it } from "vitest";
import { sideQuestionSizeBounds } from "./SideQuestionResize";

describe("side question resize limits", () => {
  it("keeps room for both chats near the desktop breakpoint", () => {
    const bounds = sideQuestionSizeBounds(720, 800);
    expect(bounds.stacked).toBe(false);
    expect(bounds.minimum / 100 * 720).toBeCloseTo(240);
    expect((100 - bounds.maximum) / 100 * 720).toBeCloseTo(280);
  });
  it("uses the height when chats stack in a narrow window", () => {
    const bounds = sideQuestionSizeBounds(500, 500);
    expect(bounds.stacked).toBe(true);
    expect(bounds.minimum / 100 * 500).toBeGreaterThanOrEqual(160);
    expect((100 - bounds.maximum) / 100 * 500).toBeGreaterThanOrEqual(160);
  });
  it("bounds the split in large and tiny windows", () => {
    expect(sideQuestionSizeBounds(1600, 900)).toEqual({ stacked: false, minimum: 25, maximum: 65 });
    const tiny = sideQuestionSizeBounds(300, 0);
    expect(tiny.minimum).toBeLessThan(tiny.maximum);
    expect(Number.isFinite(tiny.minimum + tiny.maximum)).toBe(true);
  });
});
