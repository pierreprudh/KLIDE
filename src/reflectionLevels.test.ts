import { describe, expect, it } from "vitest";
import {
  reflectionBarLevel,
  reflectionCaption,
  sortReflectionLevels,
} from "./reflectionLevels";

describe("reflection levels", () => {
  it("places a level inside its own set, not on a fixed scale", () => {
    // The glyph has five bars. A Klide-wire model's five levels map one to
    // one; a six-level Codex model still reads weakest→strongest, and its top
    // level still lands on the top bar.
    const wire = ["minimal", "low", "medium", "high", "xhigh"];
    expect(wire.map((l) => reflectionBarLevel(l, wire))).toEqual([1, 2, 3, 4, 5]);

    const codex = ["low", "medium", "high", "xhigh", "max", "ultra"];
    expect(reflectionBarLevel("low", codex)).toBe(1);
    expect(reflectionBarLevel("ultra", codex)).toBe(5);
    expect(reflectionBarLevel("high", codex)).toBeLessThan(reflectionBarLevel("max", codex));
  });

  it("reads Auto for no level, and for one this model never offered", () => {
    const codex = ["low", "medium", "high"];
    expect(reflectionBarLevel(undefined, codex)).toBe(0);
    // `minimal` is a Klide-wire level; no Codex model publishes it.
    expect(reflectionBarLevel("minimal", codex)).toBe(0);
  });

  it("orders a set weakest first and keeps levels it has never seen", () => {
    expect(sortReflectionLevels(["ultra", "medium", "minimal"])).toEqual([
      "minimal",
      "medium",
      "ultra",
    ]);
    expect(sortReflectionLevels(["glacial", "low"])).toEqual(["low", "glacial"]);
  });

  it("captions every level, including one it has no words for", () => {
    expect(reflectionCaption("ultra")).toContain("delegation");
    expect(reflectionCaption("glacial")).toBe("Reasoning effort");
  });
});
