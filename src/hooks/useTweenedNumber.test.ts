import { describe, expect, it } from "vitest";
import { tweenAt } from "./useTweenedNumber";

describe("tweenAt", () => {
  it("starts on the old value and lands on the new one", () => {
    expect(tweenAt(100, 200, 0, 360)).toBe(100);
    expect(tweenAt(100, 200, 360, 360)).toBe(200);
    expect(tweenAt(100, 200, 1000, 360)).toBe(200);
  });

  it("eases out: more than half the distance is covered by half the time", () => {
    const mid = tweenAt(0, 100, 180, 360);
    expect(mid).toBeGreaterThan(50);
    expect(mid).toBeLessThan(100);
  });

  it("moves monotonically toward the target in either direction", () => {
    let last = 0;
    for (let ms = 0; ms <= 360; ms += 30) {
      const v = tweenAt(0, 100, ms, 360);
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
    expect(tweenAt(100, 0, 90, 360)).toBeLessThan(100);
    expect(tweenAt(100, 0, 90, 360)).toBeGreaterThan(0);
  });

  it("snaps when there is no duration", () => {
    expect(tweenAt(1, 9, 0, 0)).toBe(9);
  });
});
