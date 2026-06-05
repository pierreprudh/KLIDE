import { useCallback, useEffect, useMemo, useState } from "react";
import { listCheckpoints, revertCheckpoint } from "../agent/client";
import type { CheckpointEntry } from "../agent/types";
import { DiffModal, type PendingEdit } from "./DiffModal";

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
    setReverting(entry.toolCallId);
    try {
      await revertCheckpoint(runId, entry.toolCallId);
      setEntries((prev) => prev.filter((e) => e.toolCallId !== entry.toolCallId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReverting(null);
    }
  }

  const groups = useMemo(() => groupByTurn(entries), [entries]);

  const muted = { fontSize: 12, color: "var(--fg-subtle)" } as const;

  if (loading) return <div style={muted}>Loading checkpoints…</div>;
  if (error) return <div style={{ ...muted, color: "var(--danger, #B42318)" }}>{error}</div>;
  if (entries.length === 0) return <div style={muted}>No file changes to revert.</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {groups.map(({ turn, entries: group }) => (
        <div key={turn}>
          <div
            style={{
              fontSize: 10,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "var(--fg-subtle)",
              fontFamily: "var(--font-mono)",
              marginBottom: 6,
            }}
          >
            Turn {turn} · {group.length} file{group.length === 1 ? "" : "s"}
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
                    fontSize: 9,
                    fontWeight: 600,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    fontFamily: "var(--font-mono)",
                    color: entry.isCreate ? "#3E7C5A" : "var(--accent)",
                    background: entry.isCreate
                      ? "color-mix(in srgb, #3E7C5A 12%, transparent)"
                      : "var(--accent-soft)",
                    padding: "1px 5px",
                    borderRadius: 3,
                    flexShrink: 0,
                  }}
                >
                  {entry.isCreate ? "Create" : "Edit"}
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
                    border: "1px solid var(--danger, #B42318)",
                    color: "var(--danger, #B42318)",
                    background: reverting === entry.toolCallId
                      ? "color-mix(in srgb, var(--danger, #B42318) 12%, transparent)"
                      : "transparent",
                    cursor: reverting === entry.toolCallId ? "default" : "pointer",
                    opacity: reverting === entry.toolCallId ? 0.6 : 1,
                    flexShrink: 0,
                  }}
                  onMouseEnter={(e) => {
                    if (reverting !== entry.toolCallId)
                      e.currentTarget.style.background = "color-mix(in srgb, var(--danger, #B42318) 12%, transparent)";
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
