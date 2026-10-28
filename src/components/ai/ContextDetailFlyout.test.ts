import { describe, expect, it } from "vitest";
import { contextFlyoutTop } from "./ContextDetailFlyout";

describe("context detail flyout placement", () => {
  it("aligns the header with its row when there is room", () => {
    expect(contextFlyoutTop(200, 100, 180, 820)).toBe(91);
  });

  it("moves a long skills breakdown above the bottom edge", () => {
    const parentTop = 430;
    const top = contextFlyoutTop(parentTop, 150, 180, 640);
    expect(parentTop + top + 180).toBe(632);
  });

  it("keeps the top visible when the parent extends above the viewport", () => {
    expect(-40 + contextFlyoutTop(-40, 20, 180, 640)).toBe(8);
  });

  it("repositions when streaming changes the rendered height", () => {
    expect(contextFlyoutTop(430, 150, 80, 640)).toBe(122);
    expect(contextFlyoutTop(430, 150, 180, 640)).toBe(22);
  });
});
