import { describe, expect, it } from "vitest";
import { memoryFingerprint, parseMemoryLessons } from "./memoryLearning";
const origin = { runId: "run-1", provider: "ollama", model: "test", mode: "goal" };
const evidence = "Use the Rust memory engine for storage.";
const lesson = { title: "Memory ownership", kind: "decision", notes: evidence, why: "Preserves a single authority", evidence };
describe("selective memory extraction", () => {
  it("requires evidence present in the bounded transcript", () => {
    expect(parseMemoryLessons(JSON.stringify([lesson]), evidence, origin)[0].sourceRefs[0].id).toBe("run-1");
    expect(parseMemoryLessons(JSON.stringify([lesson]), "unrelated", origin)).toEqual([]);
    expect(parseMemoryLessons("not JSON", evidence, origin)).toEqual([]);
    expect(parseMemoryLessons("[]", evidence, origin)).toEqual([]);
  });
  it("limits output and rejects routine handoffs and oversized lessons", () => {
    expect(parseMemoryLessons(JSON.stringify([lesson, lesson, lesson]), evidence, origin)).toHaveLength(2);
    expect(parseMemoryLessons(JSON.stringify([{ ...lesson, kind: "handoff" }]), evidence, origin)).toEqual([]);
    expect(parseMemoryLessons(JSON.stringify([{ ...lesson, notes: "x".repeat(1001) }]), evidence, origin)).toEqual([]);
  });
  it("normalizes punctuation and case for duplicate detection", () => {
    expect(memoryFingerprint({ notes: "Use Rust!" })).toBe(memoryFingerprint({ notes: "use rust." }));
  });
});
