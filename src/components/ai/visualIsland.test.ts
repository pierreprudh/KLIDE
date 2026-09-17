import { describe, expect, it } from "vitest";

import { drawnExtent } from "./VisualIsland";

describe("drawnExtent", () => {
  const box = { left: 100, top: 50, width: 720, height: 400 };

  it("takes the union of what was painted, in unscaled px, relative to the box", () => {
    const e = drawnExtent([
      { left: 120, top: 60, right: 460, bottom: 200 },
      { left: 140, top: 210, right: 500, bottom: 300 },
    ], box, 1);
    expect(e).toEqual({ left: 20, top: 10, width: 380, height: 240 });
  });

  it("undoes the scale already applied to the drawing", () => {
    const e = drawnExtent([{ left: 110, top: 55, right: 450, bottom: 255 }], box, 0.5);
    expect(e).toEqual({ left: 20, top: 10, width: 680, height: 400 });
  });

  it("falls back to the layout box when nothing measurable was painted", () => {
    expect(drawnExtent([{ left: 0, top: 0, right: 0, bottom: 0 }], box, 1)).toEqual({ left: 0, top: 0, width: 720, height: 400 });
  });
});
