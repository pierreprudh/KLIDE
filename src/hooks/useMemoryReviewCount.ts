// How many Project Memory notes in this Workspace are waiting for review —
// the number the Library row says out loud ("3 to review").
//
// Two kinds of draft wait: the renderer's own (src/memoryDrafts.ts, already a
// subscribable store) and the Rust-owned proposals, which only a command can
// list. MemoryPanel polls proposals every 2 s, but only while it is open; the
// rail is always mounted, so it asks far less often and again whenever the
// window comes back to the front — a proposal that lands while you are in
// another app is counted by the time you look.

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { listMemoryProposals } from "../memory";
import { getMemoryDrafts, MEMORY_DRAFT_TTL, subscribeMemoryDrafts, type MemoryDraft } from "../memoryDrafts";

const PROPOSAL_POLL_MS = 20_000;

/** Same rule MemoryPanel applies: this Workspace's drafts, and an automatic
 *  one only until it expires. */
export function pendingLocalDrafts(drafts: MemoryDraft[], workspaceRoot: string, now: number): number {
  return drafts.filter(
    (d) => d.workspaceRoot === workspaceRoot && (!d.automatic || now - d.createdAtMs < MEMORY_DRAFT_TTL),
  ).length;
}

export function useMemoryReviewCount(workspaceRoot: string | null): number {
  const localDrafts = useSyncExternalStore(subscribeMemoryDrafts, getMemoryDrafts);
  const [proposals, setProposals] = useState(0);

  useEffect(() => {
    setProposals(0);
    if (!workspaceRoot) return;
    let disposed = false;
    const load = () => {
      listMemoryProposals(workspaceRoot)
        .then((items) => { if (!disposed) setProposals(items.length); })
        // A failed read leaves the last count; the Memory tab reports errors.
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, PROPOSAL_POLL_MS);
    window.addEventListener("focus", load);
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [workspaceRoot]);

  const local = useMemo(
    () => (workspaceRoot ? pendingLocalDrafts(localDrafts, workspaceRoot, Date.now()) : 0),
    [localDrafts, workspaceRoot],
  );
  return local + proposals;
}
