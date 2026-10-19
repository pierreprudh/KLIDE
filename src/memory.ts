// Project Memory — durable notes that survive across sessions. A memory
// entry is one markdown file in `<workspace>/.klide/memory/`, written by
// the AI panel's "Summarize and hand off" action (or any future automatic
// summarizer). The goal is that a future agent — yours or Klide's — can
// pick up exactly where the last one stopped without rereading the whole
// transcript.
//
// Frontend consumers: the MemoryPanel sidebar (lists entries, opens them
// in the editor) and the AiPanel "Summarize" action (writes a new entry).
// Future: auto-inject recent entries into the harness system prompt.

import { invoke } from "@tauri-apps/api/core";

export type MemoryKind =
  | "run"
  | "handoff"
  | "decision"
  | "convention"
  | "fact"
  | "failure"
  | "pattern";

export type MemoryReviewState = "proposed" | "reviewed" | "superseded" | "stale";

export type MemorySourceType = "run" | "transcript" | "commit" | "file";

export type MemorySourceRef = {
  sourceType: MemorySourceType;
  id: string;
  label?: string;
  path?: string;
  lineStart?: number;
  lineEnd?: number;
};

export type MemoryEntry = {
  schemaVersion: number;
  id: string;
  path: string;
  relPath: string;
  createdAtMs: number;
  dateIso: string;
  title: string;
  kind: MemoryKind;
  reviewState: MemoryReviewState;
  tags: string[];
  sourceRefs: MemorySourceRef[];
  supersedes: string | null;
  goal: string;
  plan: string[];
  decisions: string[];
  filesTouched: string[];
  nextSteps: string[];
  notes: string;
  runId: string | null;
  provider: string | null;
  model: string | null;
  mode: string | null;
  status: string | null;
};

export type MemoryInput = Omit<
  MemoryEntry,
  | "schemaVersion"
  | "id"
  | "path"
  | "relPath"
  | "createdAtMs"
  | "dateIso"
  | "reviewState"
>;

// Read the most-recent memory entries (newest first). Empty when the
// workspace has no `.klide/memory/` yet — callers should treat that as
// the "first session" state.
export async function listMemory(
  workspaceRoot: string,
  limit = 50
): Promise<MemoryEntry[]> {
  return invoke<MemoryEntry[]>("memory_list", { workspaceRoot, limit });
}

// Durable memory changed (a note was written). Surfaces let across-surface
// listeners — e.g. Mission Control's "memory saved" chip — refresh without
// each one polling. `writeMemory` is the single write chokepoint, so firing
// here covers every path (manual Summarize, draft accept, MC "Save memory").
const memoryChangeListeners = new Set<() => void>();
export function subscribeMemoryChanged(fn: () => void): () => void {
  memoryChangeListeners.add(fn);
  return () => {
    memoryChangeListeners.delete(fn);
  };
}

// Persist a structured memory note. Returns the saved entry (the Rust side
// fills in id, path, dates). Throws if the workspace isn't open.
export async function writeMemory(
  workspaceRoot: string,
  input: MemoryInput
): Promise<MemoryEntry> {
  const entry = await invoke<MemoryEntry>("memory_write", { workspaceRoot, input });
  for (const fn of memoryChangeListeners) fn();
  return entry;
}

// Read the raw markdown for a given relative path. Used by the editor
// when the user clicks "Open" on a memory entry.
export async function readMemory(
  workspaceRoot: string,
  relPath: string
): Promise<string> {
  return invoke<string>("memory_read", { workspaceRoot, relPath });
}

/** Kept under its own name for the Memory surface's call sites; the rule is the
 *  shared one. */
export { relativeTime as relativeMemoryTime } from "./time";

export type MemoryProposal = MemoryInput & {
  draftId: string;
  createdAtMs: number;
  workspaceRoot: string;
  why: string;
  evidence: string;
  evidenceHash: string;
};

export function listMemoryProposals(workspaceRoot: string): Promise<MemoryProposal[]> {
  return invoke("memory_proposals_list", { workspaceRoot });
}

/** Only the operator's review UI calls this; agents have no publication tool. */
export async function reviewMemoryProposal(
  workspaceRoot: string,
  draftId: string,
  edits: Pick<MemoryInput, "title" | "notes" | "goal" | "decisions"> | null,
): Promise<MemoryEntry | null> {
  const entry = await invoke<MemoryEntry | null>("memory_proposal_review", { workspaceRoot, draftId, edits });
  if (entry) for (const fn of memoryChangeListeners) fn();
  return entry;
}
