// A folder nobody has trusted opens restricted: Klide reads and edits it, but
// runs none of the repository's own Git hooks or programs (Rust's
// `git/cmd.rs`). A notification says so, with one click to trust it. Rust
// owns the list.

import { useCallback, useEffect, useState } from "react";
import { trustWorkspaces, workspaceTrustStatus, type WorkspaceTrust } from "./ipc/workspaceTrust";
import { listen } from "@tauri-apps/api/event";
import { createListenerScope } from "./tauriEvents";
import { dismissToast, notify } from "./toast";
import { errMessage } from "./errors";

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

// Trust changed somewhere else (Settings › Trusted folders): the open
// folder's status is read again.
const trustListeners = new Set<() => void>();

/** Tell every open trust reader that the list changed. */
export function trustListChanged() {
  for (const listener of [...trustListeners]) listener();
}

/** The open folder's trust, and the one click that grants it. */
export function useWorkspaceTrust(root: string | null, onTrusted?: (root: string) => void) {
  const [trust, setTrust] = useState<{ root: string; value: WorkspaceTrust } | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const listener = () => setVersion((n) => n + 1);
    trustListeners.add(listener);
    return () => {
      trustListeners.delete(listener);
    };
  }, []);
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
  }, [root, version]);
  const trustFolder = useCallback(async () => {
    if (!root) return;
    await trustWorkspaces([root]);
    setTrust({ root, value: { trusted: true, gitPaused: false } });
    onTrusted?.(root);
    trustListChanged();
  }, [root, onTrusted]);
  const current = trust && trust.root === root ? trust.value : null;
  return { restricted: current ? !current.trusted : false, gitPaused: current?.gitPaused ?? false, trustFolder };
}

/** What the notification says about a restricted folder — on opening it, or
 *  `attempted` when something just tried to run there. */
export function restrictedFolderMessage(gitPaused: boolean, attempted = false): string {
  if (gitPaused) return "Restricted folder — Git is paused: its settings can run programs.";
  return attempted
    ? "Restricted folder — Its Git hooks were skipped. Trust it to run them."
    : "Restricted folder — Its Git hooks and programs are off.";
}

/** Whether a reminder from Rust (`workspace-trust:attempt`) is about the open
 *  folder — the folder itself, or somewhere inside it. */
export function attemptIsFor(root: string, attemptRoot: string): boolean {
  return attemptRoot === root || attemptRoot.startsWith(`${root.replace(/\/+$/, "")}/`);
}

/** While the open folder is restricted, a notification in the corner says so
 *  and offers Trust folder. It stays until answered or closed, and leaves with
 *  the folder. Mount-safe: the cleanup dismisses, a re-run shows it again. */
export function useRestrictedFolderToast(root: string | null, onTrusted?: (root: string) => void) {
  const { restricted, gitPaused, trustFolder } = useWorkspaceTrust(root, onTrusted);
  // Bumped when something tries to run here before it is trusted: the
  // notification comes back, even after it was closed.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!root || !restricted) return;
    const scope = createListenerScope();
    scope.add(
      listen<{ root: string; gitPaused: boolean }>("workspace-trust:attempt", (event) => {
        if (attemptIsFor(root, event.payload.root)) setAttempt((n) => n + 1);
      }),
    );
    return scope.dispose;
  }, [root, restricted]);
  useEffect(() => setAttempt(0), [root]);
  useEffect(() => {
    if (!root || !restricted) return;
    const id = notify(restrictedFolderMessage(gitPaused, attempt > 0), {
      tone: "info",
      duration: 0,
      action: {
        label: "Trust folder",
        primary: true,
        run: () => {
          trustFolder().then(
            () => notify("Folder trusted", { tone: "success" }),
            (error: unknown) => notify(`Couldn't trust this folder: ${errMessage(error)}`, { tone: "error" }),
          );
        },
      },
    });
    return () => dismissToast(id);
  }, [root, restricted, gitPaused, trustFolder, attempt]);
}
