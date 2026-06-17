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

export type MemoryEntry = {
  id: string;
  path: string;
  relPath: string;
  createdAtMs: number;
  dateIso: string;
  title: string;
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
  "id" | "path" | "relPath" | "createdAtMs" | "dateIso"
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

export function relativeMemoryTime(ts: number): string {
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}
