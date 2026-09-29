// Typed frontend Adapter for the `app_storage_*` command family — the folders
// Klide writes for itself, measured.
//
// This is the disk half of the story Settings tells. The other half — the
// browser cache the conversation list reads — needs no IPC: it lives in
// localStorage, and `components/ai/storedConversations.ts` owns measuring and
// managing it.

import { invoke } from "@tauri-apps/api/core";

export type StorageDir = {
  /** Stable id to address this directory by in `revealStorageDir`. */
  kind: "runs" | "app-data";
  label: string;
  /** What lives here, in one line. */
  detail: string;
  path: string;
  files: number;
  bytes: number;
  /** True when this folder is where it is because someone chose it. */
  custom: boolean;
  /** Where it sits with no choice made — what "Use default" restores. */
  defaultPath: string;
  /** Set when a chosen folder was ignored (missing volume, gone read-only) and
   *  Klide fell back to the default. */
  warning?: string;
};

/** What changed after moving the transcript folder. */
export type RunsDirChange = {
  path: string;
  custom: boolean;
  movedFiles: number;
  movedBytes: number;
  /** Entries in the old folder that were not Klide's to move — anything the
   *  user keeps in a folder they chose. Reported rather than swept along. */
  leftBehind: number;
};

/** Measure the folders Klide owns. Walks the tree, so treat it as a fetch:
 *  call it when the section opens, not on every render. */
export function readStorageDirs(): Promise<StorageDir[]> {
  return invoke<StorageDir[]>("app_storage_dirs");
}

/** Open one of those folders in Finder. */
export function revealStorageDir(kind: StorageDir["kind"]): Promise<void> {
  return invoke<void>("app_storage_reveal", { kind });
}

/**
 * Point run transcripts at `path`. Rust validates the folder (absolute,
 * writable, not nested inside the current one) before anything moves, and
 * persists the choice only after a successful move — so a failure leaves every
 * transcript where the app is still looking for it.
 */
export function setRunsDir(path: string, moveExisting: boolean): Promise<RunsDirChange> {
  return invoke<RunsDirChange>("app_storage_set_runs_dir", { path, moveExisting });
}

/** Put transcripts back in Klide's own app data folder. `moveExisting` is the
 *  caller's to decide and worth asking about: the folder being left may be one
 *  the user picked and still keeps things in. */
export function resetRunsDir(moveExisting: boolean): Promise<RunsDirChange> {
  return invoke<RunsDirChange>("app_storage_reset_runs_dir", { moveExisting });
}

export type StoredRun = {
  id: string;
  title: string;
  updatedMs: number;
  bytes: number;
  transcriptBytes: number;
  supportingBytes: number;
};

export function readStoredRuns(): Promise<StoredRun[]> {
  return invoke<StoredRun[]>("app_storage_conversations");
}

export function deleteStoredRun(id: string): Promise<void> {
  return invoke<void>("app_storage_delete_conversation", { id });
}
