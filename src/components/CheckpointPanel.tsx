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

// Same thin caret as the Mission Control disclosure — rotates 90° when the
// turn group is expanded.
const CaretGlyph = (
  <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
    <path d="M3.5 2L7 5L3.5 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
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
  // Per-turn expansion overrides; a turn with no entry falls back to the
  // default of "latest turn open, older turns folded".
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

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
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {groups.map(({ turn, entries: group }, groupIdx) => {
        const open = expanded[turn] ?? groupIdx === 0;
        const toggle = () => setExpanded((prev) => ({ ...prev, [turn]: !open }));
        return (
        <div key={turn} className="klide-checkpoint-group">
          <div
            className="klide-checkpoint-header"
            role="button"
            tabIndex={0}
            aria-expanded={open}
            onClick={toggle}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggle();
              }
            }}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              padding: "4px 2px",
              userSelect: "none",
            }}
          >
            <span
              className="klide-checkpoint-label"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
                fontSize: 10,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "var(--fg-subtle)",
                fontFamily: "var(--font-mono)",
              }}
            >
              <span className="klide-checkpoint-caret">{CaretGlyph}</span>
              Turn {turn} · {group.length} file{group.length === 1 ? "" : "s"}
            </span>
            {/* Turn-level reverts stay invisible until the group is pointed
                at (or holds focus) — the header reads as pure label at rest.
                Clicks here must not toggle the fold. */}
            <span
              className="klide-checkpoint-turn-actions"
              data-busy={revertingTurn === turn || revertingAll}
              style={{ display: "flex", alignItems: "center", gap: 2 }}
              onClick={(e) => e.stopPropagation()}
            >
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
            </span>
          </div>
          <div className="klide-checkpoint-body" data-open={open}>
          <div>
          <div style={{ display: "flex", flexDirection: "column", padding: "2px 0 0" }}>
            {group.map((entry, idx) => {
              const rowBusy = reverting === entry.toolCallId;
              return (
                <div
                  key={entry.toolCallId}
                  className="klide-checkpoint-row"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "5px 8px",
                    minHeight: 30,
                    borderTop:
                      idx === 0
                        ? "1px solid transparent"
                        : "1px solid color-mix(in srgb, var(--border) 55%, transparent)",
                    fontSize: 12,
                    animationDelay: `${Math.min(groupIdx * 3 + idx, 10) * 22}ms`,
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
                  {/* Right slot: timestamp at rest, actions on hover. Both
                      are stacked in one grid cell and crossfaded in CSS; the
                      hidden layer keeps pointer-events off so nothing can
                      bleed through, and the shared cell keeps it shift-free. */}
                  <span className="klide-checkpoint-swap" style={{ minWidth: 64, flexShrink: 0 }}>
                    <span
                      className="klide-checkpoint-time"
                      data-hidden={rowBusy}
                      style={{ fontSize: 10, color: "var(--fg-dim)", whiteSpace: "nowrap" }}
                    >
                      {relativeTime(entry.ts)}
                    </span>
                    <span
                      className="klide-checkpoint-actions"
                      data-busy={rowBusy}
                      style={{ display: "flex", alignItems: "center", gap: 2 }}
                    >
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
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
          </div>
          </div>
        </div>
        );
      })}

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
