// A folder nobody has trusted opens restricted: Klide reads and edits it, but
// runs none of the repository's own Git hooks or programs (Rust's
// `git/cmd.rs`). One click on the banner trusts it. Rust owns the list.

import { useCallback, useEffect, useState } from "react";
import { trustWorkspaces, workspaceTrustStatus, type WorkspaceTrust } from "./ipc/workspaceTrust";

const MIGRATED_KEY = "klide.trust.migrated.v1";
/** The 2026-11-13 activation consent's list; folded into Rust's once. */
const LEGACY_KEY = "klide.trustedWorkspaces.v1";

function readList(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

let migration: Promise<void> | null = null;

/** On the first launch with trust, every folder already in recents (and every
 *  one the older consent approved) is trusted, once. Later folders start
 *  restricted. A failed grant is retried next launch. */
export function migrateTrustOnce(
  recents: readonly string[],
  grant: (roots: string[]) => Promise<void> = trustWorkspaces,
): Promise<void> {
  if (migration) return migration;
  migration = (async () => {
    try {
      if (localStorage.getItem(MIGRATED_KEY)) return;
    } catch {
      return;
    }
    const roots = [...new Set([...recents, ...readList(LEGACY_KEY)])].filter((root) => root.startsWith("/"));
    try {
      if (roots.length) await grant(roots);
      localStorage.setItem(MIGRATED_KEY, "1");
    } catch {
      /* Not marked: tried again next launch. */
    }
  })();
  return migration;
}

/** Test seam: forget that this session already ran the migration. */
export function resetTrustMigrationForTests() {
  migration = null;
}

/** Before a link switches to a folder that is not trusted. Declining opens
 *  nothing and queues nothing; accepting opens it restricted. */
export async function confirmLinkedFolder(
  root: string,
  status: (root: string) => Promise<WorkspaceTrust> = workspaceTrustStatus,
): Promise<boolean> {
  await migration;
  const trust = await status(root).catch(() => null);
  if (trust?.trusted) return true;
  return window.confirm(
    `Open this folder from a link?\n\n${root}\n\nIt opens restricted: Klide runs none of the repository's own Git hooks or programs until you trust it.`,
  );
}

/** The open folder's trust, and the banner's one click. */
export function useWorkspaceTrust(root: string | null, onTrusted?: (root: string) => void) {
  const [trust, setTrust] = useState<{ root: string; value: WorkspaceTrust } | null>(null);
  useEffect(() => {
    if (!root) return;
    let live = true;
    void (async () => {
      await migration;
      const value = await workspaceTrustStatus(root).catch(() => null);
      if (live && value) setTrust({ root, value });
    })();
    return () => {
      live = false;
    };
  }, [root]);
  const trustFolder = useCallback(async () => {
    if (!root) return;
    await trustWorkspaces([root]);
    setTrust({ root, value: { trusted: true, gitPaused: false } });
    onTrusted?.(root);
  }, [root, onTrusted]);
  const current = trust && trust.root === root ? trust.value : null;
  return { restricted: current ? !current.trusted : false, gitPaused: current?.gitPaused ?? false, trustFolder };
}
