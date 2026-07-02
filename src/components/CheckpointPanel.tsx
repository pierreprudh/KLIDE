import { useCallback, useEffect, useMemo, useState } from "react";
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
};

export function CheckpointPanel({ runId }: Props) {
  const [entries, setEntries] = useState<CheckpointEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<CheckpointEntry | null>(null);
  const [reverting, setReverting] = useState<string | null>(null);
  const [revertingAll, setRevertingAll] = useState(false);
  const [revertingTurn, setRevertingTurn] = useState<number | null>(null);

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
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          onClick={() => void handleRevertAll()}
          disabled={revertingAll || !!reverting}
          style={{
            fontSize: 11,
            padding: "3px 8px",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--danger)",
            color: "var(--danger)",
            background: revertingAll
              ? "color-mix(in srgb, var(--danger) 12%, transparent)"
              : "transparent",
            cursor: revertingAll || !!reverting ? "default" : "pointer",
            opacity: revertingAll || !!reverting ? 0.6 : 1,
          }}
          onMouseEnter={(e) => {
            if (!revertingAll && !reverting)
              e.currentTarget.style.background = "color-mix(in srgb, var(--danger) 12%, transparent)";
          }}
          onMouseLeave={(e) => {
            if (!revertingAll && !reverting) e.currentTarget.style.background = "transparent";
          }}
        >
          {revertingAll ? "Reverting…" : "Revert all"}
        </button>
      </div>
      {groups.map(({ turn, entries: group }) => (
        <div key={turn}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              marginBottom: 6,
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
            <button
              onClick={() => void handleRevertTurn(turn, group)}
              disabled={revertingAll || revertingTurn === turn || !!reverting}
              style={{
                fontSize: 10,
                padding: "2px 6px",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--border)",
                color: "var(--fg-subtle)",
                background: revertingTurn === turn ? "var(--bg-hover)" : "transparent",
                cursor: revertingAll || revertingTurn === turn || !!reverting ? "default" : "pointer",
                opacity: revertingAll || revertingTurn === turn || !!reverting ? 0.6 : 1,
              }}
              onMouseEnter={(e) => {
                if (!revertingAll && revertingTurn !== turn && !reverting)
                  e.currentTarget.style.background = "var(--bg-hover)";
              }}
              onMouseLeave={(e) => {
                if (!revertingAll && revertingTurn !== turn && !reverting)
                  e.currentTarget.style.background = "transparent";
              }}
            >
              {revertingTurn === turn ? "…" : "Revert turn"}
            </button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {group.map((entry) => (
              <div
                key={entry.toolCallId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "5px 8px",
                  borderRadius: "var(--radius-sm)",
                  background: "var(--bg-elevated)",
                  border: "1px solid var(--border)",
                  fontSize: 12,
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    fontFamily: "var(--font-mono)",
                    color: entry.isCreate ? "var(--diff-add)" : "var(--accent)",
                    flexShrink: 0,
                  }}
                >
                  {entry.isCreate ? "add" : "edit"}
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontFamily: "var(--font-mono)",
                    color: "var(--fg)",
                  }}
                  title={entry.path}
                >
                  {entry.path}
                </span>
                <span style={{ fontSize: 10, color: "var(--fg-dim)", whiteSpace: "nowrap", flexShrink: 0 }}>
                  {relativeTime(entry.ts)}
                </span>
                <button
                  onClick={() => setPreview(entry)}
                  style={{
                    fontSize: 10,
                    padding: "2px 6px",
                    borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--border)",
                    color: "var(--fg-subtle)",
                    background: "transparent",
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  Diff
                </button>
                <button
                  onClick={() => void handleRevert(entry)}
                  disabled={reverting === entry.toolCallId}
                  style={{
                    fontSize: 10,
                    padding: "2px 6px",
                    borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--danger)",
                    color: "var(--danger)",
                    background: reverting === entry.toolCallId
                      ? "color-mix(in srgb, var(--danger) 12%, transparent)"
                      : "transparent",
                    cursor: reverting === entry.toolCallId ? "default" : "pointer",
                    opacity: reverting === entry.toolCallId ? 0.6 : 1,
                    flexShrink: 0,
                  }}
                  onMouseEnter={(e) => {
                    if (reverting !== entry.toolCallId)
                      e.currentTarget.style.background = "color-mix(in srgb, var(--danger) 12%, transparent)";
                  }}
                  onMouseLeave={(e) => {
                    if (reverting !== entry.toolCallId)
                      e.currentTarget.style.background = "transparent";
                  }}
                >
                  {reverting === entry.toolCallId ? "…" : "Revert"}
                </button>
              </div>
            ))}
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
