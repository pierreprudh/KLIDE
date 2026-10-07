// Pending Project Memory drafts awaiting review.
//
// When a Klide run settles "done" (and auto-memory is on), the harness
// generates a structured note but does NOT write it to `.klide/memory/`
// straight away — it parks it here as a draft. The user then accepts, edits,
// or skips it from the Memory modal before it becomes durable. This keeps the
// durable store clean (no half-baked auto-notes) while still capturing the
// session while it's fresh.
//
// Module-level + localStorage-backed (like `tasks.ts`, but persisted) so a
// draft survives a panel close, a view switch, and an app restart — a run
// that finished while you were away is still waiting when you come back.
// Drafts carry their `workspaceRoot` so they stay scoped to the project that
// produced them.

import { memoryFingerprint } from "./memoryLearning";
import type { MemoryInput } from "./memory";
import { createPersistedStore } from "./persistedStore";

export type MemoryDraft = MemoryInput & {
  /** Local draft id — distinct from the durable memory entry id. */
  draftId: string;
  automatic?: boolean;
  why?: string;
  evidence?: string;
  createdAtMs: number;
  /** Project this draft belongs to; drafts are shown per-workspace. */
  workspaceRoot: string;
};

export const MAX_PENDING_MEMORY = 10;
export const MEMORY_DRAFT_TTL = 30 * 24 * 60 * 60 * 1000;

const dismissed = createPersistedStore<Record<string, string[]>>({
  key: "klide.dismissedMemoryLessons",
  validate: (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, items]) => Array.isArray(items))
      .map(([workspace, items]) => [workspace, (items as unknown[]).filter((item): item is string => typeof item === "string").slice(0, 100)]));
  },
});

const STORAGE_KEY = "klide.memoryDrafts";

const store = createPersistedStore<MemoryDraft[]>({
  key: STORAGE_KEY,
  // Drafts persisted before MemoryInput gained kind/tags/sourceRefs/supersedes
  // still live in localStorage without them; backfill so the type's promise
  // holds at runtime and an accepted legacy draft writes a well-formed entry.
  validate: (parsed) => {
    if (!Array.isArray(parsed)) return [];
    return (parsed as Array<Partial<MemoryDraft> | null>)
      .filter(
        (d): d is Partial<MemoryDraft> =>
          !!d && typeof d === "object" && typeof d.draftId === "string"
      )
      .map(
        (d) =>
          ({
            kind: "handoff",
            tags: [],
            sourceRefs: [],
            supersedes: null,
            ...d,
          }) as MemoryDraft
      );
  },
});

function genId(): string {
  return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function subscribeMemoryDrafts(fn: () => void): () => void {
  return store.subscribe(fn);
}

// Stable snapshot for useSyncExternalStore — the reference only changes when
// the list actually changes (every mutation replaces the array). Consumers
// filter by workspace in a useMemo to avoid breaking snapshot stability.
export function getMemoryDrafts(): MemoryDraft[] {
  return store.get();
}

export function addMemoryDraft(
  input: MemoryInput,
  workspaceRoot: string,
  options: { automatic?: boolean; why?: string; evidence?: string } = {},
): MemoryDraft | null {
  const fingerprint = memoryFingerprint(input);
  const active = store.get().filter((d) => !d.automatic || Date.now() - d.createdAtMs < MEMORY_DRAFT_TTL);
  if (options.automatic && (
    (dismissed.get()[workspaceRoot] ?? []).includes(fingerprint) ||
    active.some((d) => d.workspaceRoot === workspaceRoot && memoryFingerprint(d) === fingerprint) ||
    active.filter((d) => d.workspaceRoot === workspaceRoot).length >= MAX_PENDING_MEMORY
  )) return null;
  const draft: MemoryDraft = {
    ...input,
    ...options,
    draftId: genId(),
    createdAtMs: Date.now(),
    workspaceRoot,
  };
  store.mutate(() => [draft, ...active]);
  return draft;
}

export function updateMemoryDraft(draftId: string, patch: Partial<MemoryInput>) {
  store.mutate((drafts) => drafts.map((d) => (d.draftId === draftId ? { ...d, ...patch } : d)));
}

export function removeMemoryDraft(draftId: string) {
  store.mutate((drafts) => drafts.filter((d) => d.draftId !== draftId));
}

export function dismissMemoryDraft(draft: MemoryDraft) {
  if (draft.automatic) {
    dismissed.mutate((all) => ({ ...all, [draft.workspaceRoot]:
      [...new Set([memoryFingerprint(draft), ...(all[draft.workspaceRoot] ?? [])])].slice(0, 100) }));
  }
  removeMemoryDraft(draft.draftId);
}
