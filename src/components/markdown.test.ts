import { describe, expect, it } from "vitest";
import { visualBlocksOf } from "./markdown";

describe("visualBlocksOf", () => {
  it("finds closed visual fences with renderable markup, in order", () => {
    const text = "Here.\n\n```svg\n<svg viewBox=\"0 0 10 10\"><rect width=\"4\" height=\"4\"/></svg>\n```\n\nAnd code:\n\n```ts\nconst a = 1;\n```\n\n```html\n<div>hi</div>\n```\n";
    const out = visualBlocksOf(text);
    expect(out.map((v) => [v.key, v.lang, v.kind])).toEqual([["visual-1", "svg", "drawing"], ["visual-5", "html", "drawing"]]);
    expect(out[1].code).toBe("<div>hi</div>");
  });

  it("leaves a fence that is still streaming, and one that holds only prose", () => {
    expect(visualBlocksOf("```svg\n<svg viewBox=\"0 0 1 1\"></svg>")).toEqual([]);
    expect(visualBlocksOf("```html\njust words\n```")).toEqual([]);
  });
});
