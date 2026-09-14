import { describe, expect, it } from "vitest";
import { NUDGE_LIMIT, resolveOverlaps, type Box } from "./visualTypeset";

const box = (left: number, top: number, width = 40, height = 10): Box => ({
  left,
  right: left + width,
  top,
  bottom: top + height,
});

describe("moving labels off each other", () => {
  it("leaves a drawing whose labels already clear alone", () => {
    expect(resolveOverlaps([box(0, 0), box(0, 40), box(80, 0)], NUDGE_LIMIT)).toEqual([0, 0, 0]);
  });

  it("holds the first label and moves the later one", () => {
    // The first mention is usually what the later caption hangs off.
    const [first, second] = resolveOverlaps([box(0, 0), box(10, 4)], NUDGE_LIMIT);
    expect(first).toBe(0);
    expect(second).toBeGreaterThan(0);
  });

  it("takes the shorter way out", () => {
    // Sitting just above the other, the way out is up.
    const [, up] = resolveOverlaps([box(0, 20), box(10, 13)], NUDGE_LIMIT);
    expect(up).toBeLessThan(0);
    // Sitting just below it, down.
    const [, down] = resolveOverlaps([box(0, 20), box(10, 27)], NUDGE_LIMIT);
    expect(down).toBeGreaterThan(0);
  });

  it("does not move a label across the drawing to fix a small overlap", () => {
    // Two labels almost exactly on top of each other would need a full line's
    // shift; moving one that far strands it away from what it labels.
    expect(resolveOverlaps([box(0, 0, 40, 40), box(0, 0, 40, 40)], 5)).toEqual([0, 0]);
  });

  it("never moves further than the limit, however crowded", () => {
    const stack = Array.from({ length: 8 }, (_, i) => box(0, i));
    for (const dy of resolveOverlaps(stack, NUDGE_LIMIT)) expect(Math.abs(dy)).toBeLessThanOrEqual(NUDGE_LIMIT);
  });

  it("ignores labels that never share a column", () => {
    expect(resolveOverlaps([box(0, 0), box(100, 0)], NUDGE_LIMIT)).toEqual([0, 0]);
  });

  it("settles: running it on the result changes nothing more", () => {
    const boxes = [box(0, 0), box(10, 4), box(20, 8)];
    const first = resolveOverlaps(boxes, NUDGE_LIMIT);
    const moved = boxes.map((b, i) => ({ ...b, top: b.top + first[i], bottom: b.bottom + first[i] }));
    expect(resolveOverlaps(moved, NUDGE_LIMIT)).toEqual([0, 0, 0]);
  });
});
