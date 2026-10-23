import { invoke } from "@tauri-apps/api/core";
import type { MemoryInput } from "./memory";

export type SharedNoteSet = {
  id: string;
  title: string;
  body: string;
  conversationIds: string[];
  archived: boolean;
  updatedAtMs: number;
};
export type SharedNotesStore = { revision: number; sets: SharedNoteSet[] };
export type SharedNotesAction =
  | { type: "create"; title: string; conversationId: string }
  | { type: "edit"; id: string; title: string; body: string }
  | { type: "attach"; id: string | null; conversationId: string }
  | { type: "archive"; id: string; archived: boolean }
  | { type: "delete"; id: string };

export function readSharedNotes(workspaceRoot: string): Promise<SharedNotesStore> {
  return invoke("shared_notes_read", { workspaceRoot });
}

export function applySharedNotes(workspaceRoot: string, expectedRevision: number, action: SharedNotesAction): Promise<SharedNotesStore> {
  return invoke("shared_notes_apply", { workspaceRoot, expectedRevision, action });
}

export function sharedNotesTerminalPrompt(workspaceRoot: string, conversationId: string, text: string): Promise<string> {
  return invoke("shared_notes_terminal_prompt", { workspaceRoot, conversationId, text });
}

export function sharedNotesForConversation(store: SharedNotesStore, conversationId: string): SharedNoteSet | undefined {
  return store.sets.find(set => set.conversationIds.includes(conversationId));
}

/** An operator-selected lesson is still a draft. The existing Memory review
 * surface decides whether it becomes knowledge; this helper never publishes. */
export function sharedNoteLesson(set: SharedNoteSet, title: string, lesson: string): MemoryInput {
  return {
    title: title.trim(), kind: "decision", notes: lesson.trim(),
    tags: ["shared-notes"], supersedes: null,
    sourceRefs: [{ sourceType: "file", id: set.id, path: ".klide/shared-notes/state.json", label: `Shared notes: ${set.title}, updated ${set.updatedAtMs} (working context, not independently verified evidence)` }],
    goal: "", plan: [], decisions: [], filesTouched: [], nextSteps: [],
    runId: null, provider: null, model: null, mode: null, status: null,
  };
}
