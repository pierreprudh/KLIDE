import { isTauri } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { errMessage } from "./errors";
import { notify } from "./toast";
import { repoHasPath } from "./workspaceIndex";
import type { WrittenPath } from "./filePaths";

// The other door out of the app — `externalLink.ts` hands a URL to the browser,
// this one opens a place a model named in an answer.
//
// Where it opens depends on what the place is. A file this repository holds
// belongs in a tab: Klide is an editor, and bouncing to Finder for a file it
// can already show would be the worse answer. Anything else — another
// project's folder, a file outside the workspace, a directory — goes to the
// file manager, which is the only thing that can show it.
//
// Only App can open a tab, so it registers the opener the same way it
// registers the Settings one, and this module asks for it when a click lands.

type WorkspaceOpener = (path: string, line: number | null) => Promise<void>;

let workspaceRoot: string | null = null;
let openInEditor: WorkspaceOpener | null = null;

/** App calls this when the open project changes, and with `null` on close. */
export function registerWorkspaceOpener(
  root: string | null,
  opener: WorkspaceOpener | null,
): void {
  workspaceRoot = root;
  openInEditor = opener;
}

/** Absolute form of a path a model wrote, or null when it can't be placed. */
export async function resolveWrittenPath(path: string): Promise<string | null> {
  if (!path.startsWith("~")) return path;
  try {
    const home = (await homeDir()).replace(/\/+$/u, "");
    return `${home}${path.slice(1) || "/"}`;
  } catch {
    return null;
  }
}

/**
 * The path relative to a project root, when the place is inside it — the form
 * every editor surface in Klide takes. Null when it is somewhere else.
 */
export function workspaceRelative(path: string, root: string | null): string | null {
  if (!root) return null;
  const base = root.replace(/\/+$/u, "");
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) || null : null;
}

/**
 * Open a place a model named: a tab when this repository holds the file, the
 * file manager otherwise.
 *
 * Says so out loud when it can't. A model can write a path that was never
 * there, and silence would leave you clicking a word that does nothing.
 */
export async function openWrittenPath(written: WrittenPath): Promise<boolean> {
  // A relative path is only ever offered once the index recognised it, so it
  // is already this project's and needs no resolving.
  const relative = written.rooted
    ? workspaceRelative((await resolveWrittenPath(written.path)) ?? written.path, workspaceRoot)
    : written.path.replace(/^\.\//u, "");

  if (relative && openInEditor && repoHasPath(relative)) {
    try {
      await openInEditor(relative, written.line);
      return true;
    } catch {
      // A folder, a binary, or a file that moved since the walk: the file
      // manager can still show it, so fall through instead of reporting.
    }
  }
  return revealPath(written.path);
}

/** Show a place in the system file manager — Finder on macOS. */
export async function revealPath(raw: string): Promise<boolean> {
  const full = await resolveWrittenPath(raw);
  if (!full) {
    notify(`Klide can't place ${raw}`, { tone: "warn" });
    return false;
  }
  const rooted = full.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(full);
  const target = rooted || !workspaceRoot
    ? full
    : `${workspaceRoot.replace(/\/+$/u, "")}/${full.replace(/^\/+/u, "")}`;
  // Outside the app (the preview harness, a test) there is no file manager to
  // hand it to. Say so rather than absorb the click.
  if (!isTauri()) {
    notify(`Klide opens ${target} in Finder from the app`, { tone: "info" });
    return false;
  }
  try {
    await revealItemInDir(target);
    return true;
  } catch (e) {
    notify(`Couldn't show ${raw}: ${errMessage(e)}`, { tone: "error" });
    return false;
  }
}
