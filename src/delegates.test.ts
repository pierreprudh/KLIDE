import { describe, expect, it } from "vitest";
import { DELEGATES, DELEGATE_IDS, delegateFacts, delegateLabel, isDelegateId } from "./delegates";

// Every source file under src/ (tests excluded), as text — Vite resolves the
// glob at build time, so no node:fs is needed in the browser-typed project.
const SOURCES = import.meta.glob<string>(["./**/*.ts", "./**/*.tsx", "!./**/*.test.ts", "!./**/*.test.tsx"], {
  query: "?raw",
  import: "default",
  eager: true,
});

function offenders(pattern: RegExp): string[] {
  return Object.entries(SOURCES)
    .filter(([path]) => path !== "./delegates.ts")
    .filter(([, text]) => pattern.test(text))
    .map(([path]) => path.replace(/^\.\//, ""))
    .sort();
}

describe("the delegate catalog", () => {
  it("answers ids, labels and facts from the one array", () => {
    expect(DELEGATE_IDS).toEqual(DELEGATES.map((d) => d.id));
    for (const d of DELEGATES) {
      expect(isDelegateId(d.id)).toBe(true);
      expect(delegateLabel(d.id)).toBe(d.label);
      expect(delegateFacts(d.id)).toEqual(d);
    }
    expect(isDelegateId("cli:mine")).toBe(false);
    expect(delegateLabel("cli:mine")).toBe("cli:mine");
  });

  it("is the only file that spells the delegate ids out as a list", () => {
    // A literal `["claude-code", "codex", …]` anywhere else is a second
    // registry that stops agreeing with this one the day a fifth CLI lands.
    // The Rust side pins this file to `delegate::ALL`
    // (`frontend_catalog_matches_all`); this pins the rest of src/ to it.
    expect(Object.keys(SOURCES).length).toBeGreaterThan(50);
    expect(offenders(/\[\s*"claude-code"\s*,\s*"codex"/)).toEqual([]);
  });

  it("has no second label table for a delegate", () => {
    // "Oh My Pi" is the label most likely to be retyped; every surface reads
    // it through delegateLabel / DELEGATES. agent/providers.ts keeps the
    // Provider catalog's own row (that registry is published from Rust
    // separately); its test pins that row to SOURCE_LABEL.
    expect(offenders(/"Oh My Pi"/)).toEqual(["agent/providers.ts"]);
  });
});
