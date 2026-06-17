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

import type { MemoryInput } from "./memory";

export type MemoryDraft = MemoryInput & {
  /** Local draft id — distinct from the durable memory entry id. */
  draftId: string;
  createdAtMs: number;
  /** Project this draft belongs to; drafts are shown per-workspace. */
  workspaceRoot: string;
};

const STORAGE_KEY = "klide.memoryDrafts";

let drafts: MemoryDraft[] = load();
const subscribers = new Set<() => void>();

function load(): MemoryDraft[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MemoryDraft[]) : [];
  } catch {
    return [];
  }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    /* storage full or unavailable — drafts stay in-memory for this session */
  }
}

function emitChange() {
  for (const fn of subscribers) fn();
}

function genId(): string {
  return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function subscribeMemoryDrafts(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

// Stable snapshot for useSyncExternalStore — the reference only changes when
// the list actually changes (every mutation replaces the array). Consumers
// filter by workspace in a useMemo to avoid breaking snapshot stability.
export function getMemoryDrafts(): MemoryDraft[] {
  return drafts;
}

export function addMemoryDraft(
  input: MemoryInput,
  workspaceRoot: string
): MemoryDraft {
  const draft: MemoryDraft = {
    ...input,
    draftId: genId(),
    createdAtMs: Date.now(),
    workspaceRoot,
  };
  drafts = [draft, ...drafts];
  persist();
  emitChange();
  return draft;
}

export function updateMemoryDraft(draftId: string, patch: Partial<MemoryInput>) {
  drafts = drafts.map((d) => (d.draftId === draftId ? { ...d, ...patch } : d));
  persist();
  emitChange();
}

export function removeMemoryDraft(draftId: string) {
  drafts = drafts.filter((d) => d.draftId !== draftId);
  persist();
  emitChange();
}
