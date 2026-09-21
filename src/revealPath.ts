import { isTauri } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { errMessage } from "./errors";
import { notify } from "./toast";
import type { WrittenPath } from "./filePaths";

// The other door out of the app — `externalLink.ts` hands a URL to the browser,
// this hands a place on disk to the file manager. Nothing else calls
// `revealItemInDir`.
//
// Only a rooted path ever gets here (`filePaths.ts` decides), so there is no
// workspace to resolve against and no ambiguity about which place is meant —
// `~` is the one form still needing expansion.

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
 * Show a path in the system file manager — Finder on macOS — selecting the file
 * inside its folder, or opening the folder itself.
 *
 * Says so out loud when it can't: a model can write a path that was never
 * there, and silence would leave you clicking a word that does nothing.
 */
export async function revealPath(written: WrittenPath | string): Promise<boolean> {
  const raw = typeof written === "string" ? written : written.path;
  const full = await resolveWrittenPath(raw);
  if (!full) {
    notify(`Klide can't place ${raw}`, { tone: "warn" });
    return false;
  }
  // Outside the app (the preview harness, a test) there is no file manager to
  // hand it to. Say so rather than absorb the click.
  if (!isTauri()) {
    notify(`Klide opens ${full} in Finder from the app`, { tone: "info" });
    return false;
  }
  try {
    await revealItemInDir(full);
    return true;
  } catch (e) {
    notify(`Couldn't show ${raw}: ${errMessage(e)}`, { tone: "error" });
    return false;
  }
}
