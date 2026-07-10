import { describe, expect, it } from "vitest";
import type { MemoryEntry } from "./memory";
import {
  isEmptyMemoryQuery,
  matchesMemoryQuery,
  memoryMatchNote,
  parseMemoryQuery,
} from "./memorySearch";

const entry = (over: Partial<MemoryEntry>): MemoryEntry => ({
  id: "2026-07-10-1000-note",
  path: "/ws/.klide/memory/note.md",
  relPath: ".klide/memory/note.md",
  createdAtMs: 0,
  dateIso: "2026-07-10T10:00:00Z",
  title: "Ship the advisor",
  goal: "Wire the advisor seam",
  plan: [],
  decisions: [],
  filesTouched: [],
  nextSteps: [],
  notes: "",
  runId: null,
  provider: null,
  model: null,
  mode: null,
  status: null,
  ...over,
});

describe("parseMemoryQuery", () => {
  it("splits facet prefixes from bare terms", () => {
    const q = parseMemoryQuery("  pty file:src/pty.rs run:ses_ab decision:fold ");
    expect(q.text).toEqual(["pty"]);
    expect(q.file).toEqual(["src/pty.rs"]);
    expect(q.run).toEqual(["ses_ab"]);
    expect(q.decision).toEqual(["fold"]);
  });

  it("a bare prefix with no value is a plain term, and empty input is empty", () => {
    expect(parseMemoryQuery("file:").text).toEqual(["file:"]);
    expect(isEmptyMemoryQuery(parseMemoryQuery("   "))).toBe(true);
  });
});

describe("matchesMemoryQuery", () => {
  const note = entry({
    decisions: ["Keep the two transcript folds separate"],
    filesTouched: ["src-tauri/src/pty.rs", "src/App.tsx"],
    runId: "ses_abc123",
  });

  it("facet terms only match their facet", () => {
    expect(matchesMemoryQuery(note, parseMemoryQuery("file:pty.rs"))).toBe(true);
    expect(matchesMemoryQuery(note, parseMemoryQuery("file:advisor"))).toBe(false);
    expect(matchesMemoryQuery(note, parseMemoryQuery("run:abc123"))).toBe(true);
    expect(matchesMemoryQuery(note, parseMemoryQuery("decision:folds"))).toBe(true);
    // "advisor" is in the title, but decision: scopes to decisions only.
    expect(matchesMemoryQuery(note, parseMemoryQuery("decision:advisor"))).toBe(false);
  });

  it("bare terms match anywhere and are AND'd", () => {
    expect(matchesMemoryQuery(note, parseMemoryQuery("pty.rs"))).toBe(true);
    expect(matchesMemoryQuery(note, parseMemoryQuery("advisor folds"))).toBe(true);
    expect(matchesMemoryQuery(note, parseMemoryQuery("advisor missing-term"))).toBe(false);
  });

  it("mixed facet + bare terms must all land", () => {
    expect(matchesMemoryQuery(note, parseMemoryQuery("file:pty.rs advisor"))).toBe(true);
    expect(matchesMemoryQuery(note, parseMemoryQuery("file:pty.rs nothere"))).toBe(false);
  });
});

describe("memoryMatchNote", () => {
  const note = entry({
    decisions: ["Keep the two transcript folds separate"],
    filesTouched: ["src-tauri/src/pty.rs"],
    runId: "ses_abc123",
  });

  it("explains facet hits with the matched value", () => {
    expect(memoryMatchNote(note, parseMemoryQuery("file:pty"))).toBe(
      "file src-tauri/src/pty.rs"
    );
    expect(memoryMatchNote(note, parseMemoryQuery("run:abc"))).toBe("run ses_abc123");
    expect(memoryMatchNote(note, parseMemoryQuery("decision:folds"))).toContain(
      "decision Keep the two"
    );
  });

  it("explains bare-term hits only when the visible fields don't", () => {
    // "advisor" already shows in the title — no note needed.
    expect(memoryMatchNote(note, parseMemoryQuery("advisor"))).toBeNull();
    // "pty" only lives in the files — surface it.
    expect(memoryMatchNote(note, parseMemoryQuery("pty"))).toBe(
      "file src-tauri/src/pty.rs"
    );
    expect(memoryMatchNote(note, parseMemoryQuery(""))).toBeNull();
  });
});
