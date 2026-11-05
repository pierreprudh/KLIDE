import { describe, expect, it } from "vitest";
import { pendingLocalDrafts } from "./useMemoryReviewCount";
import { MEMORY_DRAFT_TTL, type MemoryDraft } from "../memoryDrafts";

const now = 1_800_000_000_000;
function draft(over: Partial<MemoryDraft>): MemoryDraft {
  return {
    draftId: Math.random().toString(36),
    workspaceRoot: "/w/klide",
    createdAtMs: now,
    title: "t",
    kind: "handoff",
    tags: [],
    sourceRefs: [],
    supersedes: null,
    ...over,
  } as MemoryDraft;
}

describe("pendingLocalDrafts", () => {
  it("counts only this workspace's drafts", () => {
    const drafts = [draft({}), draft({}), draft({ workspaceRoot: "/w/site" })];
    expect(pendingLocalDrafts(drafts, "/w/klide", now)).toBe(2);
  });

  it("drops an automatic draft once it has expired, as the Memory tab does", () => {
    const drafts = [
      draft({ automatic: true, createdAtMs: now - MEMORY_DRAFT_TTL - 1 }),
      draft({ automatic: true, createdAtMs: now - 1000 }),
      draft({ createdAtMs: now - MEMORY_DRAFT_TTL * 2 }),
    ];
    expect(pendingLocalDrafts(drafts, "/w/klide", now)).toBe(2);
  });
});
