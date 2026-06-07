import { useEffect, useMemo, useState } from "react";
import {
  listMemory,
  readMemory,
  relativeMemoryTime,
  type MemoryEntry,
} from "../memory";

type Props = {
  workspaceRoot: string | null;
  /** When set, the entry's markdown opens in the editor as a tab. */
  onOpenInEditor?: (path: string, content: string) => void;
  /** When a new entry is written (e.g. by the AI panel's Summarize action),
   *  bump this counter to force a refresh. */
  refreshKey?: number;
  width: number;
  visible: boolean;
  fill?: boolean;
};

function RefreshIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 4v5h-5" />
    </svg>
  );
}

function BookmarkIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z" />
    </svg>
  );
}

// Project Memory — the durable end-of-session notes that survive across
// agent runs. Each entry is one markdown file in `.klide/memory/` and the
// list is the reverse-chronological breadcrumb of what the user (and their
// agents) have been working on. Click a row to open the file in the
// editor; the AI panel's "Summarize" action writes here.
export function MemoryPanel({
  workspaceRoot,
  onOpenInEditor,
  refreshKey = 0,
  width,
  visible,
  fill,
}: Props) {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  async function refresh() {
    if (!workspaceRoot) return;
    setLoading(true);
    setError(null);
    try {
      const list = await listMemory(workspaceRoot);
      setEntries(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [workspaceRoot, refreshKey]);

  async function openEntry(entry: MemoryEntry) {
    if (!onOpenInEditor || !workspaceRoot) return;
    setOpening(entry.id);
    try {
      // Read the markdown and hand it to the editor pipeline. We pass
      // content directly so the file doesn't need to be re-read by Rust
      // for the new tab — and so the editor's working copy is the one we
      // just rendered.
      const content = await readMemory(workspaceRoot, entry.relPath);
      onOpenInEditor(entry.path, content);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpening(null);
    }
  }

  const empty = useMemo(
    () => !loading && entries.length === 0,
    [loading, entries]
  );

  return (
    <aside
      className="floating-panel"
      style={{
        width: fill ? "100%" : width,
        height: fill ? "100%" : undefined,
        margin: fill ? 0 : "4px 0 4px 4px",
        display: fill || visible ? "flex" : "none",
        flexDirection: "column",
        flexShrink: 0,
        overflow: "hidden",
      }}
    >
      <header
        style={{
          height: 36,
          padding: "0 8px 0 12px",
          fontSize: 11,
          color: "var(--fg-subtle)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          fontWeight: 500,
          borderBottom: "1px solid var(--border)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <BookmarkIcon />
          <span>Project Memory</span>
        </span>
        {workspaceRoot && (
          <button
            aria-label="Refresh project memory"
            title={loading ? "Refreshing" : "Refresh"}
            disabled={loading}
            onClick={() => void refresh()}
            style={{
              width: 24,
              height: 24,
              display: "grid",
              placeItems: "center",
              color: "var(--fg-subtle)",
              opacity: loading ? 0.45 : 1,
            }}
          >
            <RefreshIcon />
          </button>
        )}
      </header>

      {!workspaceRoot && (
        <div
          style={{
            flex: 1,
            display: "grid",
            placeItems: "center",
            padding: 18,
            color: "var(--fg-subtle)",
            textAlign: "center",
            lineHeight: 1.55,
            fontSize: 12,
          }}
        >
          Open a folder to start a project memory.
        </div>
      )}

      {workspaceRoot && error && (
        <div
          style={{
            padding: "10px 12px",
            fontSize: 11,
            color: "var(--danger, #B42318)",
            borderBottom: "1px solid var(--border)",
          }}
        >
          {error}
        </div>
      )}

      {workspaceRoot && empty && (
        <div
          style={{
            flex: 1,
            display: "grid",
            placeItems: "center",
            padding: 18,
            color: "var(--fg-subtle)",
            textAlign: "center",
            lineHeight: 1.55,
            fontSize: 12,
          }}
        >
          <div>
            <div
              style={{
                color: "var(--fg-strong)",
                marginBottom: 6,
                fontWeight: 500,
              }}
            >
              No memory yet
            </div>
            Click <span style={{ color: "var(--fg-strong)" }}>Summarize</span>{" "}
            in the AI panel header to write the first handoff note. Future
            agents — and future you — can pick up where this session stopped
            without rereading the whole transcript.
          </div>
        </div>
      )}

      {workspaceRoot && !empty && (
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "8px 8px 16px",
          }}
        >
          {entries.map((entry) => (
            <button
              key={entry.id}
              onClick={() => void openEntry(entry)}
              disabled={opening === entry.id || !onOpenInEditor}
              title={entry.relPath}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "8px 10px",
                marginBottom: 6,
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--border)",
                background: "var(--bg-elevated)",
                cursor: onOpenInEditor ? "pointer" : "default",
                opacity: opening === entry.id ? 0.6 : 1,
                transition: "background var(--motion-fast) var(--ease-out)",
              }}
              onMouseEnter={(e) => {
                if (onOpenInEditor)
                  e.currentTarget.style.background = "var(--bg-hover)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "var(--bg-elevated)";
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  marginBottom: 3,
                }}
              >
                <span
                  style={{
                    fontSize: 12.5,
                    color: "var(--fg-strong)",
                    fontWeight: 500,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    flex: 1,
                  }}
                >
                  {entry.title}
                </span>
                <span
                  style={{
                    fontSize: 10,
                    color: "var(--fg-subtle)",
                    fontFamily: "var(--font-mono)",
                    flexShrink: 0,
                  }}
                >
                  {relativeMemoryTime(entry.createdAtMs)}
                </span>
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: "var(--fg-subtle)",
                  lineHeight: 1.5,
                  overflow: "hidden",
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                }}
              >
                {entry.goal || entry.notes || entry.relPath}
              </div>
              {(entry.provider || entry.model) && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    marginTop: 5,
                    fontSize: 10,
                    color: "var(--fg-dim)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {entry.provider && <span>{entry.provider}</span>}
                  {entry.provider && entry.model && <span>·</span>}
                  {entry.model && <span>{entry.model}</span>}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}
