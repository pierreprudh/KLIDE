import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStorage } from "./testStorage";
import type { MemoryInput } from "./memory";
const note = (notes: string): MemoryInput => ({ title: notes, kind: "decision", notes, tags: [], sourceRefs: [], supersedes: null, goal: "", plan: [], decisions: [], filesTouched: [], nextSteps: [], runId: null, provider: null, model: null, mode: null, status: null });
beforeEach(() => { vi.resetModules(); vi.stubGlobal("localStorage", memoryStorage()); });
describe("quiet memory inbox", () => {
  it("deduplicates, suppresses dismissed proposals, and scopes to workspace", async () => {
    const store = await import("./memoryDrafts");
    const first = store.addMemoryDraft(note("Use Rust"), "/a", { automatic: true })!;
    expect(store.addMemoryDraft(note("use rust!"), "/a", { automatic: true })).toBeNull();
    store.dismissMemoryDraft(first);
    expect(store.addMemoryDraft(note("Use Rust"), "/a", { automatic: true })).toBeNull();
    expect(store.addMemoryDraft(note("Use Rust"), "/b", { automatic: true })).not.toBeNull();
    vi.resetModules();
    const restored = await import("./memoryDrafts");
    expect(restored.getMemoryDrafts()).toHaveLength(1);
    expect(restored.addMemoryDraft(note("Use Rust"), "/a", { automatic: true })).toBeNull();
  });
  it("expires only automatic proposals and keeps manual drafts", async () => {
    const store = await import("./memoryDrafts");
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    store.addMemoryDraft(note("automatic"), "/a", { automatic: true });
    store.addMemoryDraft(note("manual"), "/a");
    clock.mockReturnValue(1000 + store.MEMORY_DRAFT_TTL + 1);
    store.addMemoryDraft(note("fresh"), "/a", { automatic: true });
    expect(store.getMemoryDrafts().map((d) => d.notes)).toEqual(["fresh", "manual"]);
    clock.mockRestore();
  });
  it("caps automatic proposals without deleting accepted-for-review work", async () => {
    const store = await import("./memoryDrafts");
    for (let i = 0; i < 10; i++) store.addMemoryDraft(note(`lesson ${i}`), "/a", { automatic: true });
    expect(store.addMemoryDraft(note("overflow"), "/a", { automatic: true })).toBeNull();
    expect(store.getMemoryDrafts()).toHaveLength(10);
  });
});
