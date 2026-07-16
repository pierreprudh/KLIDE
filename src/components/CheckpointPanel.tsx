import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { listCheckpoints, revertCheckpoint, revertRunCheckpoints } from "../agent/client";
import type { CheckpointEntry } from "../agent/types";
import { DiffModal, type PendingEdit } from "./DiffModal";
import { notify } from "../toast";

function relativeTime(ts: number): string {
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function extractTurn(toolCallId: string): number {
  const m = toolCallId.match(/^turn(\d+)/);
  return m ? Number(m[1]) : 0;
}

type GroupedCheckpoints = Array<{ turn: number; entries: CheckpointEntry[] }>;

function groupByTurn(entries: CheckpointEntry[]): GroupedCheckpoints {
  const map = new Map<number, CheckpointEntry[]>();
  for (const e of entries) {
    const turn = extractTurn(e.toolCallId);
    const arr = map.get(turn) ?? [];
    arr.push(e);
    map.set(turn, arr);
  }
  return Array.from(map.entries())
    .map(([turn, list]) => ({ turn, entries: list }))
    .sort((a, b) => b.turn - a.turn);
}

type Props = {
  runId: string;
  /** Mission Control supplies these to keep file inspection in its docked
   *  Artifact Inspector. Other hosts keep the existing modal fallback. */
  onOpenFile?: (entry: CheckpointEntry) => void;
  onOpenDiff?: (entry: CheckpointEntry) => void;
};

// Line glyphs on the 24-grid — the same icon idiom as the AI panel's action
// chips (undo arrow from the revert chip, plus-over-minus for diff).
function Glyph({ children, size = 13 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

// Eye — "view the diff" said plainly; the old plus-over-minus read cryptic.
const EyeGlyph = (
  <Glyph>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </Glyph>
);

// Row change marks — pencil for an edited file, plus for a created one.
const EditMarkGlyph = (
  <Glyph size={12}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </Glyph>
);

const AddMarkGlyph = (
  <Glyph size={12}>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </Glyph>
);

const RevertGlyph = (
  <Glyph>
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h11a5 5 0 0 1 0 10h-3" />
  </Glyph>
);

const revertGlyphSmall = (
  <Glyph size={11}>
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h11a5 5 0 0 1 0 10h-3" />
  </Glyph>
);

/* Borderless action — the checkpoint list reads as a quiet macOS-style list,
   so controls are glyphs (or glyph+word) that gain color on hover instead of
   boxed buttons. Destructive actions stay neutral at rest and only turn red
   when pointed at. Icon-only actions keep their label as tooltip + aria. */
function QuietAction({
  icon,
  label,
  showLabel = true,
  busyLabel = "…",
  danger,
  busy,
  disabled,
  onClick,
  size = 11,
}: {
  icon?: ReactNode;
  label: string;
  showLabel?: boolean;
  busyLabel?: string;
  danger?: boolean;
  busy?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  size?: number;
}) {
  const inactive = !!disabled || !!busy;
  const restColor = busy && danger ? "var(--danger)" : "var(--fg-subtle)";
  return (
    <button
      onClick={onClick}
      disabled={inactive}
      title={label}
      aria-label={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: size,
        fontWeight: 500,
        padding: showLabel ? "2px 5px" : 4,
        border: "none",
        background: "transparent",
        color: restColor,
        cursor: inactive ? "default" : "pointer",
        opacity: (disabled && !busy) || (busy && !showLabel) ? 0.5 : 1,
        transition: "color var(--motion-fast) var(--ease-out)",
      }}
      onMouseEnter={(e) => {
        if (!inactive) e.currentTarget.style.color = danger ? "var(--danger)" : "var(--fg)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = restColor;
      }}
    >
      {icon}
      {showLabel && (busy ? busyLabel : label)}
    </button>
  );
}

export function CheckpointPanel({ runId, onOpenFile, onOpenDiff }: Props) {
  const [entries, setEntries] = useState<CheckpointEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<CheckpointEntry | null>(null);
  const [reverting, setReverting] = useState<string | null>(null);
  const [revertingAll, setRevertingAll] = useState(false);
  const [revertingTurn, setRevertingTurn] = useState<number | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listCheckpoints(runId);
      setEntries(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleRevert(entry: CheckpointEntry) {
    // The blocking confirm can swallow mouseleave — drop hover state first so
    // row actions can't stay stuck visible after the dialog closes.
    setHoverId(null);
    // Match the bulk/turn paths: confirm before an overwrite that can't be
    // undone. Single-file revert was the one destructive path without a guard.
    if (!window.confirm(`Revert ${entry.path} to its checkpoint? This overwrites the current file and can't be undone.`)) return;
    setReverting(entry.toolCallId);
    try {
      await revertCheckpoint(runId, entry.toolCallId);
      setEntries((prev) => prev.filter((e) => e.toolCallId !== entry.toolCallId));
      notify(`Reverted ${entry.path}`, { tone: "success" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      notify(`Revert failed: ${err instanceof Error ? err.message : String(err)}`, { tone: "error" });
    } finally {
      setReverting(null);
    }
  }

  async function handleRevertAll() {
    setHoverId(null);
    if (!window.confirm(`Revert all ${entries.length} remaining file change${entries.length === 1 ? "" : "s"} for this run?`)) return;
    setRevertingAll(true);
    setError(null);
    try {
      await revertRunCheckpoints(runId);
      setEntries([]);
      notify("Reverted all file changes for this run", { tone: "success" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      notify(`Revert failed: ${err instanceof Error ? err.message : String(err)}`, { tone: "error" });
      await load();
    } finally {
      setRevertingAll(false);
    }
  }

  async function handleRevertTurn(turn: number, group: CheckpointEntry[]) {
    setHoverId(null);
    if (!window.confirm(`Revert ${group.length} file change${group.length === 1 ? "" : "s"} from turn ${turn}?`)) return;
    setRevertingTurn(turn);
    setError(null);
    try {
      for (const entry of group) {
        await revertCheckpoint(runId, entry.toolCallId);
      }
      const revertedIds = new Set(group.map((entry) => entry.toolCallId));
      setEntries((prev) => prev.filter((entry) => !revertedIds.has(entry.toolCallId)));
      notify(`Reverted ${group.length} file change${group.length === 1 ? "" : "s"} from turn ${turn}`, { tone: "success" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      notify(`Revert failed: ${err instanceof Error ? err.message : String(err)}`, { tone: "error" });
      await load();
    } finally {
      setRevertingTurn(null);
    }
  }

  const groups = useMemo(() => groupByTurn(entries), [entries]);

  const muted = { fontSize: 12, color: "var(--fg-subtle)" } as const;

  if (loading) return <div style={muted}>Loading checkpoints…</div>;
  if (error) return <div style={{ ...muted, color: "var(--danger)" }}>{error}</div>;
  if (entries.length === 0) return <div style={muted}>No file changes to revert.</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {groups.map(({ turn, entries: group }, groupIdx) => (
        <div key={turn}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              marginBottom: 2,
            }}
          >
            <div
              style={{
                fontSize: 10,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "var(--fg-subtle)",
                fontFamily: "var(--font-mono)",
              }}
            >
              Turn {turn} · {group.length} file{group.length === 1 ? "" : "s"}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
              <QuietAction
                icon={revertGlyphSmall}
                label="Revert turn"
                danger
                size={10}
                busy={revertingTurn === turn}
                disabled={revertingAll || !!reverting || (revertingTurn !== null && revertingTurn !== turn)}
                onClick={() => void handleRevertTurn(turn, group)}
              />
              {/* Run-level revert rides the first group header instead of
                  claiming its own row — one line of chrome, not two. */}
              {groupIdx === 0 && groups.reduce((n, g) => n + g.entries.length, 0) > group.length && (
                <QuietAction
                  icon={revertGlyphSmall}
                  label="Revert all"
                  busyLabel="Reverting…"
                  danger
                  size={10}
                  busy={revertingAll}
                  disabled={!!reverting || revertingTurn !== null}
                  onClick={() => void handleRevertAll()}
                />
              )}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {group.map((entry, idx) => {
              const rowBusy = reverting === entry.toolCallId;
              const showActions = hoverId === entry.toolCallId || rowBusy;
              return (
                <div
                  key={entry.toolCallId}
                  onMouseEnter={() => setHoverId(entry.toolCallId)}
                  onMouseLeave={() => setHoverId((prev) => (prev === entry.toolCallId ? null : prev))}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "5px 2px",
                    minHeight: 30,
                    borderTop:
                      idx === 0
                        ? "1px solid transparent"
                        : "1px solid color-mix(in srgb, var(--border) 55%, transparent)",
                    fontSize: 12,
                  }}
                >
                  <span
                    title={entry.isCreate ? "Added" : "Modified"}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: entry.isCreate ? "var(--success)" : "var(--accent)",
                      flexShrink: 0,
                      width: 14,
                    }}
                  >
                    {entry.isCreate ? AddMarkGlyph : EditMarkGlyph}
                  </span>
                  <button
                    type="button"
                    onClick={onOpenFile ? () => onOpenFile(entry) : undefined}
                    disabled={!onOpenFile}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      padding: 0,
                      border: "none",
                      background: "transparent",
                      textAlign: "left",
                      fontFamily: "var(--font-mono)",
                      fontSize: 12,
                      color: "var(--fg)",
                      cursor: onOpenFile ? "pointer" : "default",
                    }}
                    title={onOpenFile ? `Open ${entry.path} in the Artifact Inspector` : entry.path}
                  >
                    {entry.path}
                  </button>
                  {/* Right slot: timestamp at rest, actions while hovered.
                      Conditional render (not opacity stacking) so nothing can
                      bleed through; minWidth keeps the swap shift-free. */}
                  <span
                    style={{
                      display: "flex",
                      justifyContent: "flex-end",
                      alignItems: "center",
                      gap: 2,
                      minWidth: 64,
                      flexShrink: 0,
                    }}
                  >
                    {showActions ? (
                      <>
                        <QuietAction
                          icon={EyeGlyph}
                          label="View diff"
                          showLabel={false}
                          onClick={() => {
                            if (onOpenDiff) onOpenDiff(entry);
                            else setPreview(entry);
                          }}
                        />
                        <QuietAction
                          icon={RevertGlyph}
                          label="Revert file"
                          showLabel={false}
                          danger
                          busy={rowBusy}
                          disabled={revertingAll || revertingTurn !== null}
                          onClick={() => void handleRevert(entry)}
                        />
                      </>
                    ) : (
                      <span style={{ fontSize: 10, color: "var(--fg-dim)", whiteSpace: "nowrap" }}>
                        {relativeTime(entry.ts)}
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {preview && (
        <DiffModal
          edit={
            {
              path: preview.path,
              oldContent: preview.oldContent,
              newContent: preview.newContent,
              isCreate: preview.isCreate,
            } satisfies PendingEdit
          }
          onApply={() => setPreview(null)}
          onReject={() => setPreview(null)}
        />
      )}
    </div>
  );
}
