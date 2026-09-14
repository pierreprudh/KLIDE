import { describe, expect, it } from "vitest";
import { viewerDrawingWidth } from "./visualLayout";

describe("fullscreen visual sizing", () => {
  it("limits enlargement of a short drawing", () => {
    expect(viewerDrawingWidth(640, 120, 1600, 900)).toBe(960);
  });
  it("fits tall drawings to the available height", () => {
    const width = viewerDrawingWidth(600, 1200, 1100, 560);
    expect(width).toBe(280);
    expect(width * 1200 / 600).toBe(560);
  });
  it("fits a narrow viewport without retaining the inline scroll floor", () => {
    expect(viewerDrawingWidth(640, 120, 320, 520)).toBe(320);
  });
  it("bounds wide drawings and handles missing dimensions", () => {
    expect(viewerDrawingWidth(2000, 200, 1800, 900)).toBe(1120);
    expect(viewerDrawingWidth(0, 0, 640, 480)).toBe(640);
  });
});
