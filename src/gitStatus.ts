// The one git-status store: one poll per workspace root, one snapshot
// everyone reads, and an identity that only changes when the status does.
//
// App used to own this as component state — a `setInterval` calling
// `git_status` every three seconds and storing whatever came back. Every
// answer was a fresh object, so every tick re-rendered App and, through its
// props, every surface under it, whether or not a single file had changed.
// Here the poll runs once per root while anyone is listening, the parsed
// status is compared field by field with the last one, and a subscriber is
// only woken when something is different. Three seconds of nothing is now
// three seconds of nothing.
//
// Consumers read through `useGitStatus(root)`; actions that know they just
// changed the tree (a stage, a merge, a Delegate exit) call
// `refreshGitStatus(root)` for an immediate re-read instead of waiting a tick.

import { useCallback, useSyncExternalStore } from "react";
import { gitStatus as fetchGitStatus } from "./ipc/git";
import type { GitStatus } from "./gitTypes";

export const GIT_STATUS_POLL_MS = 3_000;

type Entry = {
  status: GitStatus | null;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  /** The read in flight, so two callers in the same tick share one `git status`. */
  inflight: Promise<void> | null;
};

const entries = new Map<string, Entry>();

function entryFor(root: string): Entry {
  let entry = entries.get(root);
  if (!entry) {
    entry = { status: null, listeners: new Set(), timer: null, inflight: null };
    entries.set(root, entry);
  }
  return entry;
}

/** Field-by-field equality: same branch, same files in the same order with
 *  the same marks. `git status --short` is deterministic in its ordering, so
 *  order is part of "the same". */
export function sameGitStatus(a: GitStatus | null, b: GitStatus | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.branch !== b.branch || a.files.length !== b.files.length) return false;
  for (let i = 0; i < a.files.length; i++) {
    const x = a.files[i];
    const y = b.files[i];
    if (x.path !== y.path || x.status !== y.status || x.staged !== y.staged) return false;
  }
  return true;
}

function publish(entry: Entry, next: GitStatus | null) {
  if (sameGitStatus(entry.status, next)) return;
  entry.status = next;
  for (const fn of entry.listeners) fn();
}

/** Re-read the status of `root` now. Resolves once subscribers have been
 *  told (or once nothing needed telling). A failed read reads as "no status",
 *  the same as a folder that is not a repository. */
export function refreshGitStatus(root: string | null): Promise<void> {
  if (!root) return Promise.resolve();
  const entry = entryFor(root);
  if (entry.inflight) return entry.inflight;
  entry.inflight = fetchGitStatus(root)
    .then(
      (status) => publish(entry, status),
      () => publish(entry, null),
    )
    .finally(() => {
      entry.inflight = null;
    });
  return entry.inflight;
}

/** The last status read for `root`, or `null` before the first read. */
export function getGitStatus(root: string | null): GitStatus | null {
  if (!root) return null;
  return entries.get(root)?.status ?? null;
}

/** Follow `root`: the first subscriber starts the poll (and an immediate
 *  read), the last one leaving stops it. `fn` fires only on a real change. */
export function subscribeGitStatus(root: string, fn: () => void): () => void {
  const entry = entryFor(root);
  entry.listeners.add(fn);
  if (entry.timer === null) {
    void refreshGitStatus(root);
    entry.timer = setInterval(() => void refreshGitStatus(root), GIT_STATUS_POLL_MS);
  }
  return () => {
    entry.listeners.delete(fn);
    if (entry.listeners.size === 0 && entry.timer !== null) {
      clearInterval(entry.timer);
      entry.timer = null;
    }
  };
}

const noop = () => {};

/** The status of `root`, kept fresh while this component is mounted. Renders
 *  again only when the branch or the changed-file list actually differs. */
export function useGitStatus(root: string | null): GitStatus | null {
  const subscribe = useCallback(
    (fn: () => void) => (root ? subscribeGitStatus(root, fn) : noop),
    [root],
  );
  const getSnapshot = useCallback(() => getGitStatus(root), [root]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Test-only: forget every root so one test's poll cannot leak into the next. */
export function resetGitStatusStoreForTests() {
  for (const entry of entries.values()) {
    if (entry.timer !== null) clearInterval(entry.timer);
  }
  entries.clear();
}
