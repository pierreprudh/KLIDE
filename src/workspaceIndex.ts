// Does the open repository contain this path?
//
// A model writes `src/App.tsx` when it means this project and `harness/` when
// it means the one it was just reading about, in the same voice. Only the
// repository can tell those apart, so an answer's relative paths are checked
// against the same file walk `⌘P` uses — one walk per project, cached, shared
// by every message on screen.
//
// Deliberately lazy: nothing walks until a conversation actually names a
// relative path. A project whose answers only talk about other repositories
// never pays for the index.

import { listWorkspaceFiles } from "./components/ai/workspaceFiles";

type Index = {
  /** Every file the walk found, workspace-relative. */
  files: Set<string>;
  /** Every folder on the way to one, so `docs/` is recognised as well. */
  dirs: Set<string>;
};

let root: string | null = null;
let index: Index | null = null;
let loading: Promise<void> | null = null;
let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version += 1;
  for (const l of listeners) l();
}

/** Build the folder set implied by a list of files. */
export function foldersOf(files: readonly string[]): Set<string> {
  const dirs = new Set<string>();
  for (const file of files) {
    let cut = file.indexOf("/");
    while (cut > 0) {
      dirs.add(file.slice(0, cut));
      cut = file.indexOf("/", cut + 1);
    }
  }
  return dirs;
}

/** App calls this when the open project changes, and with `null` on close. */
export function setIndexedProject(next: string | null): void {
  if (next === root) return;
  root = next;
  index = null;
  loading = null;
  emit();
}

/**
 * Start the walk if it hasn't run for this project. Safe to call from a render
 * — it returns immediately and notifies subscribers when the answer lands.
 */
export function ensureWorkspaceIndex(): void {
  if (!root || index || loading) return;
  const walked = root;
  loading = listWorkspaceFiles(walked)
    .then((files) => {
      // The project changed while we walked; that walk is about a different
      // repository now and must not answer for this one.
      if (root !== walked) return;
      index = { files: new Set(files), dirs: foldersOf(files) };
      emit();
    })
    .catch(() => {
      if (root === walked) loading = null;
    });
}

/**
 * Stand in for the walk with a known file list — the seam the preview harness
 * and the specs use, since neither has a Tauri backend to walk with.
 */
export function primeWorkspaceIndex(project: string, files: readonly string[]): void {
  root = project;
  loading = null;
  index = { files: new Set(files), dirs: foldersOf(files) };
  emit();
}

/** Re-render when the index lands, or when the project changes under it. */
export function subscribeWorkspaceIndex(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A version that changes whenever the answer below could change. */
export function workspaceIndexVersion(): number {
  return version;
}

/**
 * Whether the open repository holds this path — a file it walked, or a folder
 * on the way to one. `null` while the walk is still out: not "no", so a caller
 * can leave the span as prose until it knows rather than flash a link away.
 */
export function repoHasPath(path: string): boolean | null {
  if (!root) return false;
  if (!index) return null;
  const rel = path.replace(/^\.\//u, "").replace(/\/+$/u, "");
  if (!rel) return false;
  return index.files.has(rel) || index.dirs.has(rel);
}
