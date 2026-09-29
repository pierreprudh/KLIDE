// Storage — where a conversation lives, how much room it takes, and what you
// can throw away.
//
// Klide keeps a conversation twice, and the two copies are not equals:
//
//  · the **local cache** — the browser's localStorage index the Focus rail and
//    the AI panel's history read from. It shares one ~5 MB quota with every
//    other Klide key, and when a write no longer fits, the oldest snapshots are
//    evicted to make room. That is the number this section makes visible,
//    because it used to be invisible until a toast said 33 threads were gone.
//  · the **Run transcripts** on disk — the durable record Mission Control
//    reads. Saved conversations can be explicitly deleted after confirmation.
//
// Cache cleanup and permanent disk deletion are separate, explicitly labelled actions.
//
// The transcripts, being the copy that matters, also get to live where you
// want: the runs folder is choosable, and changing it carries the existing
// transcripts across. Rust owns validating and moving — this file only asks.

import { useCallback, useEffect, useState } from "react";
import {
  cachedConversationSizes,
  clearStoredConversations,
  dropCachedImages,
  forgetStoredConversation,
  localCacheUsage,
  type CachedConversationSize,
} from "../ai/storedConversations";
import { deleteKlideConvo } from "../../klideConvos";
import {
  readStorageDirs,
  readStoredRuns,
  deleteStoredRun,
  type StoredRun,
  resetRunsDir,
  revealStorageDir,
  setRunsDir,
  type RunsDirChange,
  type StorageDir,
} from "../../ipc/storage";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { relativeTime } from "../ai/utils";
import { errMessage } from "../../errors";
import { notify } from "../../toast";
import { CodeText, GhostButton, LinkButton, Panel, Row, SettingBlock } from "./controls";

/** What a webview gives the whole origin. Not readable at runtime — WebKit
 *  reports no quota — so the meter measures against the figure the platform
 *  actually enforces, and says it is approximate. */
const CACHE_QUOTA_BYTES = 5_000_000;

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 KB";
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}

/** A hairline fill, not a progress bar: it reports pressure, and turns from
 *  quiet to warning only once the quota is genuinely close. */
function CacheMeter({ used, quota }: { used: number; quota: number }) {
  const ratio = Math.max(0, Math.min(1, used / quota));
  const tight = ratio >= 0.8;
  return (
    <div style={{ display: "grid", gap: 6, minWidth: 180 }}>
      <div
        role="meter"
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Local cache used"
        style={{ height: 3, borderRadius: 2, background: "var(--border)", overflow: "hidden" }}
      >
        <div
          style={{
            width: `${Math.max(ratio * 100, ratio > 0 ? 2 : 0)}%`,
            height: "100%",
            background: tight ? "var(--warning)" : "var(--fg-subtle)",
            transition: "width var(--motion-med) var(--ease-out)",
          }}
        />
      </div>
      <div style={{ fontSize: 11.5, color: tight ? "var(--warning)" : "var(--fg-subtle)", textAlign: "right" }}>
        {formatBytes(used)} of about {formatBytes(quota)}
      </div>
    </div>
  );
}

export function StorageSection() {
  const [sizes, setSizes] = useState<CachedConversationSize[]>([]);
  const [used, setUsed] = useState(0);
  const [dirs, setDirs] = useState<StorageDir[] | null>(null);
  const [dirsError, setDirsError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [diskRuns, setDiskRuns] = useState<StoredRun[]>([]);
  const [diskError, setDiskError] = useState<string | null>(null);
  const [diskLoading, setDiskLoading] = useState(true);
  const [diskLimit, setDiskLimit] = useState(20);
  const [deleting, setDeleting] = useState<string | null>(null);
  const refreshRuns = useCallback(async () => {
    setDiskLoading(true);
    try { setDiskRuns(await readStoredRuns()); setDiskError(null); }
    catch (error) { setDiskError(errMessage(error)); }
    finally { setDiskLoading(false); }
  }, []);

  // A move walks the filesystem; the row says so instead of looking idle.
  const [movingRuns, setMovingRuns] = useState(false);

  const refreshCache = useCallback(() => {
    setSizes(cachedConversationSizes());
    setUsed(localCacheUsage().bytes);
  }, []);

  // One fetch path for the folder rows, used on mount and after every move, so
  // the measured numbers and the shown path can never come from two readers
  // that disagree.
  const refreshDirs = useCallback(async () => {
    try {
      setDirs(await readStorageDirs());
      setDirsError(null);
    } catch (e) {
      setDirsError(errMessage(e));
    }
  }, []);

  useEffect(() => {
    refreshCache();
    void refreshDirs();
    void refreshRuns();
  }, [refreshCache, refreshDirs, refreshRuns]);

  function reportChange(change: RunsDirChange) {
    const moved =
      change.movedFiles > 0
        ? ` — moved ${change.movedFiles} item${
            change.movedFiles === 1 ? "" : "s"
          } (${formatBytes(change.movedBytes)})`
        : "";
    // Klide only ever moves its own transcripts and run folders. Anything else
    // in a folder the user chose stays where they put it — said out loud, so
    // "where did the rest go?" is never the question.
    const left =
      change.leftBehind > 0
        ? `. ${change.leftBehind} item${
            change.leftBehind === 1 ? "" : "s"
          } that were not Klide's stayed in the old folder`
        : "";
    notify(`Transcripts now live in ${change.path}${moved}${left}.`, { tone: "success" });
  }

  /** Ask before carrying transcripts across, and say what will not travel.
   *  Declining is a real choice: pointing Klide at a folder that already holds
   *  transcripts (a synced drive, a restored backup) should not drag the old
   *  ones in on top of them. */
  async function confirmMove(runs: StorageDir, destination: string): Promise<boolean> {
    if (runs.files === 0) return true;
    return confirm(
      `Move the ${runs.files} existing transcript file${
        runs.files === 1 ? "" : "s"
      } (${formatBytes(runs.bytes)}) into ${destination}? Anything else in the current folder stays where it is.`,
      { title: "Move existing transcripts?", kind: "info" },
    );
  }

  /** Choose a folder, then offer to bring the existing transcripts along. */
  async function chooseRunsDir(runs: StorageDir) {
    const picked = await open({
      directory: true,
      title: "Choose where Klide keeps run transcripts",
    });
    if (typeof picked !== "string") return;
    const moveExisting = await confirmMove(runs, "the new folder");
    setMovingRuns(true);
    try {
      reportChange(await setRunsDir(picked, moveExisting));
      await Promise.all([refreshDirs(), refreshRuns()]);
    } catch (e) {
      notify(errMessage(e), { tone: "error" });
    } finally {
      setMovingRuns(false);
    }
  }

  async function restoreDefaultRunsDir(runs: StorageDir) {
    // Asked, exactly as choosing a folder is. This is the direction that empties
    // a folder the user picked, so doing it unprompted was the wrong default.
    const moveExisting = await confirmMove(runs, "Klide's own folder");
    setMovingRuns(true);
    try {
      reportChange(await resetRunsDir(moveExisting));
      await Promise.all([refreshDirs(), refreshRuns()]);
    } catch (e) {
      notify(errMessage(e), { tone: "error" });
    } finally {
      setMovingRuns(false);
    }
  }

  async function removeDiskRun(run: StoredRun) {
    const approved = await confirm(
      `Permanently delete “${run.title}” (${formatBytes(run.bytes)})? This removes its saved messages, checkpoints and retained tool output, including any evidence used by Mission Control. Project files and the provider’s own history stay in place. This cannot be undone.`,
      { title: "Delete saved conversation?", kind: "warning" },
    );
    if (!approved) return;
    setDeleting(run.id);
    try {
      await deleteStoredRun(run.id);
      forgetStoredConversation(run.id);
      deleteKlideConvo(run.id);
      refreshCache();
      notify("Saved conversation deleted.", { tone: "success" });
    } catch (error) { notify(errMessage(error), { tone: "error" }); }
    finally {
      await Promise.all([refreshDirs(), refreshRuns()]);
      setDeleting(null);
    }
  }

  const photoBytes = sizes.reduce((sum, s) => sum + s.imageBytes, 0);
  const withPhotos = sizes.filter((s) => s.imageBytes > 0).length;
  const shown = expanded ? sizes : sizes.slice(0, 6);

  function forget(row: CachedConversationSize) {
    forgetStoredConversation(row.id);
    // The AI panel's own delete does both writes; a Settings delete that only
    // touched localStorage would leave the row on Mission Control's board.
    deleteKlideConvo(row.id);
    refreshCache();
  }

  return (
    <>
      <SettingBlock title="Saved conversations">
        <Panel>
          <Row title="Conversation storage"
            description="Saved messages, streaming activity, checkpoints and retained tool output. Background conversations are saved here so you can reopen them. History stays until you delete it."
            control={<LinkButton disabled={diskLoading || deleting !== null || movingRuns} onClick={() => { refreshCache(); void refreshDirs(); void refreshRuns(); }}>Refresh</LinkButton>} />
          {diskError ? <Row title="Could not load saved conversations" description={diskError} control={null} />
            : diskLoading && diskRuns.length === 0 ? <Row title="Measuring saved conversations…" description="Reading saved history sizes." control={null} />
            : <Row title={`${diskRuns.length} saved conversation${diskRuns.length === 1 ? "" : "s"}`}
                description="Largest first. Deletion is available when all conversations have finished or stopped."
                control={<CodeText>{formatBytes(diskRuns.reduce((sum, run) => sum + run.bytes, 0))}</CodeText>} />}
          {!diskError && diskRuns.slice(0, diskLimit).map(run => <Row key={run.id} title={run.title || "Untitled conversation"}
            description={`${relativeTime(run.updatedMs)} · ${formatBytes(run.transcriptBytes)} messages and activity · ${formatBytes(run.supportingBytes)} supporting data`}
            control={<div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <CodeText>{formatBytes(run.bytes)}</CodeText>
              <LinkButton disabled={deleting !== null || movingRuns || diskLoading} onClick={() => void removeDiskRun(run)}>{deleting === run.id ? "Deleting…" : "Delete…"}</LinkButton>
            </div>} />)}
          {!diskError && diskRuns.length > diskLimit && <Row title={`${diskRuns.length - diskLimit} more conversations`} description="Continue through the list by size." control={<GhostButton onClick={() => setDiskLimit(limit => limit + 20)}>Show more</GhostButton>} />}
        </Panel>
      </SettingBlock>

      <SettingBlock title="Local conversation cache">
        <Panel>
          <Row
            title="Cache used"
            description={
              sizes.length === 0
                ? "Nothing cached. Your runs are still on disk — see the folders below."
                : `${sizes.length} conversation${sizes.length === 1 ? "" : "s"} in the history list${
                    withPhotos > 0
                      ? `, ${withPhotos} carrying ${formatBytes(photoBytes)} of photos`
                      : ""
                  }. Shared with every other Klide key in this webview.`
            }
            control={<CacheMeter used={used} quota={CACHE_QUOTA_BYTES} />}
          />
          <Row
            title="Drop cached photos"
            description="Frees the image bytes in the list above. The photos stay in their run transcripts, and each message still names the file it carried."
            control={
              <LinkButton
                disabled={photoBytes === 0}
                onClick={() => {
                  const freed = dropCachedImages();
                  refreshCache();
                  notify(
                    freed > 0
                      ? `Freed ${formatBytes(freed)} of cached photos.`
                      : "No cached photos to drop.",
                    { tone: "info" },
                  );
                }}
              >
                {photoBytes > 0 ? `Free ${formatBytes(photoBytes)}` : "Nothing to free"}
              </LinkButton>
            }
          />
          <Row
            title="Clear the history list"
            description="Empties the local index only. Every run keeps its transcript on disk, and Mission Control still lists them."
            control={
              <LinkButton
                disabled={sizes.length === 0}
                onClick={() => {
                  const count = sizes.length;
                  clearStoredConversations();
                  refreshCache();
                  notify(`Cleared ${count} cached conversation${count === 1 ? "" : "s"}.`, {
                    tone: "info",
                  });
                }}
              >
                Clear
              </LinkButton>
            }
          />
        </Panel>
      </SettingBlock>

      {sizes.length > 0 && (
        <SettingBlock title="What is taking the room">
          <Panel>
            {shown.map((row) => (
              <Row
                key={row.id}
                title={row.title}
                description={`${relativeTime(row.updatedAt)} · ${row.messages} message${
                  row.messages === 1 ? "" : "s"
                }${row.imageBytes > 0 ? ` · ${formatBytes(row.imageBytes)} of photos` : ""}`}
                control={
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <CodeText>{formatBytes(row.bytes)}</CodeText>
                    <LinkButton onClick={() => forget(row)}>Forget</LinkButton>
                  </div>
                }
              />
            ))}
            {sizes.length > shown.length && (
              <Row
                title="More conversations"
                description={`${sizes.length - shown.length} smaller thread${
                  sizes.length - shown.length === 1 ? "" : "s"
                } not listed.`}
                control={<GhostButton onClick={() => setExpanded(true)}>Show all</GhostButton>}
              />
            )}
          </Panel>
        </SettingBlock>
      )}

      <SettingBlock title="On disk">
        <Panel>
          {dirsError ? (
            <Row
              title="Could not measure Klide's folders"
              description={dirsError}
              control={null}
            />
          ) : dirs === null ? (
            <Row title="Measuring…" description="Walking Klide's app data folder." control={null} />
          ) : (
            dirs.map((dir) => {
              const movable = dir.kind === "runs";
              return (
                <Row
                  key={dir.kind}
                  title={dir.label}
                  description={
                    // The warning comes first when there is one: a folder that
                    // was ignored matters more than how big the fallback is.
                    dir.warning
                      ? dir.warning
                      : `${dir.detail} — ${dir.files} file${
                          dir.files === 1 ? "" : "s"
                        }, ${formatBytes(dir.bytes)}.${
                          movable && dir.custom ? " You chose this folder." : ""
                        }`
                  }
                  control={
                    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                      <span
                        title={dir.path}
                        style={{
                          color: dir.warning ? "var(--warning)" : "var(--fg-subtle)",
                          fontFamily: "var(--font-mono)",
                          fontSize: 11.5,
                          maxWidth: movable ? 200 : 300,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          direction: "rtl",
                          textAlign: "left",
                        }}
                      >
                        {dir.path}
                      </span>
                      {movable && (
                        <LinkButton disabled={movingRuns || deleting !== null} onClick={() => void chooseRunsDir(dir)}>
                          {movingRuns ? "Moving…" : "Change…"}
                        </LinkButton>
                      )}
                      {movable && dir.custom && (
                        <LinkButton disabled={movingRuns || deleting !== null} onClick={() => void restoreDefaultRunsDir(dir)}>
                          Use default
                        </LinkButton>
                      )}
                      <GhostButton
                        onClick={() => {
                          void revealStorageDir(dir.kind).catch((e) =>
                            notify(errMessage(e), { tone: "error" }),
                          );
                        }}
                      >
                        Reveal
                      </GhostButton>
                    </div>
                  }
                />
              );
            })
          )}
        </Panel>
      </SettingBlock>
    </>
  );
}
