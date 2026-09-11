import { describe, expect, it } from "vitest";
import {
  reflectionBarLevel,
  reflectionCaption,
  reflectionLevelWithin,
  sortReflectionLevels,
  storedReflectionLevel,
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

  describe("reconciling a stored level with a model's set", () => {
    // What Codex publishes for gpt-6-astra: no `minimal`, and a `max` that
    // sits one step ABOVE `xhigh`.
    const codex = ["low", "medium", "high", "xhigh", "max", "ultra"];
    const wire = ["minimal", "low", "medium", "high", "xhigh"];

    it("keeps a level the model publishes", () => {
      expect(reflectionLevelWithin("max", codex)).toBe("max");
      expect(reflectionLevelWithin("minimal", wire)).toBe("minimal");
    });

    it("never downgrades a real `max` into `xhigh`", () => {
      // The regression this guards: `max` was an older Klide name for `xhigh`,
      // so the old normalizer rewrote it unconditionally. On a Codex model
      // that silently runs the task one level weaker than asked.
      expect(reflectionLevelWithin("max", codex)).not.toBe("xhigh");
    });

    it("still translates the legacy names where they were only names", () => {
      // `max` and `off` are not levels a Klide-wire model publishes, so a
      // value stored by an older build still lands where it meant to.
      expect(reflectionLevelWithin("max", wire)).toBe("xhigh");
      expect(reflectionLevelWithin("off", wire)).toBe("minimal");
    });

    it("reads a level this model never offered as Auto", () => {
      // A level carried over from another model — sending it would make the
      // provider reject the run.
      expect(reflectionLevelWithin("minimal", codex)).toBeUndefined();
      expect(reflectionLevelWithin("ultra", wire)).toBeUndefined();
      // `off` has nowhere to land when the set has no `minimal` either.
      expect(reflectionLevelWithin("off", codex)).toBeUndefined();
      // No set yet (the probe is still in flight) offers nothing.
      expect(reflectionLevelWithin("medium", [])).toBeUndefined();
      expect(reflectionLevelWithin(undefined, codex)).toBeUndefined();
    });

    it("reads a blank or missing stored value as no level at all", () => {
      expect(storedReflectionLevel(null)).toBeUndefined();
      expect(storedReflectionLevel("")).toBeUndefined();
      expect(storedReflectionLevel("   ")).toBeUndefined();
      // Anything else comes back verbatim: reconciling it is the set's job,
      // and that needs the name the user actually stored.
      expect(storedReflectionLevel(" max ")).toBe("max");
      expect(storedReflectionLevel("ultra")).toBe("ultra");
    });
  });

  it("captions every level, including one it has no words for", () => {
    expect(reflectionCaption("ultra")).toContain("delegation");
    expect(reflectionCaption("glacial")).toBe("Reasoning effort");
  });
});
