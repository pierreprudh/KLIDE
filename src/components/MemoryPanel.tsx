import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  listMemory,
  readMemory,
  relativeMemoryTime,
  type MemoryEntry,
} from "../memory";

type Props = {
  workspaceRoot: string | null;
  /** Open a memory entry's raw markdown as an editor tab. */
  onOpenInEditor?: (path: string, content: string) => void;
  /** Bumped when the AI panel writes a new entry, to force a refresh. */
  refreshKey?: number;
  width: number;
  visible: boolean;
  fill?: boolean;
};

/* ------------------------------------------------------------------ icons */

function RefreshIcon() {
  return (
    <svg
      width="14"
      height="14"
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

function SearchIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.2-3.2" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  );
}

function CodeIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 8l-4 4 4 4" />
      <path d="M15 8l4 4-4 4" />
    </svg>
  );
}

function FileIcon() {
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
      <path d="M7 3.5h7l4 4V20H7z" />
      <path d="M14 3.5v4h4" />
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

/* --------------------------------------------------- tiny inline markdown */

let mdKey = 0;
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      out.push(
        <strong key={mdKey++} style={{ color: "var(--fg-strong)", fontWeight: 600 }}>
          {m[1]}
        </strong>
      );
    } else {
      out.push(
        <code
          key={mdKey++}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            background: "var(--bg-elevated)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-xs)",
            padding: "1px 5px",
          }}
        >
          {m[2]}
        </code>
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderInlineMarkdown(text: string): ReactNode {
  return <>{inline(text)}</>;
}

/* -------------------------------------------------------- shared styles */

function iconBtn(active: boolean): React.CSSProperties {
  return {
    width: 28,
    height: 28,
    display: "grid",
    placeItems: "center",
    color: active ? "var(--fg-strong)" : "var(--fg-subtle)",
    background: "transparent",
  };
}
function segBtn(active: boolean): React.CSSProperties {
  return {
    width: 28,
    height: 24,
    display: "grid",
    placeItems: "center",
    borderRadius: "var(--radius-xs)",
    color: active ? "var(--fg-strong)" : "var(--fg-subtle)",
    background: active ? "var(--bg-hover)" : "transparent",
  };
}
function pillStyle(): React.CSSProperties {
  return {
    fontSize: 9.5,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    color: "var(--fg-dim)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-xs)",
    padding: "1px 5px",
  };
}

/* ============================================================== panel === */

export function MemoryPanel({
  workspaceRoot,
  onOpenInEditor,
  refreshKey = 0,
  width: _width,
  visible,
  fill,
}: Props) {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rawContent, setRawContent] = useState<string | null>(null);
  const [rawLoading, setRawLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [rawView, setRawView] = useState(false);

  async function refresh() {
    if (!workspaceRoot) return;
    setLoading(true);
    setError(null);
    try {
      const list = await listMemory(workspaceRoot);
      setEntries(list);
      if (list.length && !list.some((e) => e.id === selectedId)) {
        setSelectedId(list[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [workspaceRoot, refreshKey]);

  // Load raw markdown on selection (for the "Source" tab).
  useEffect(() => {
    if (!workspaceRoot || !selectedId) {
      setRawContent(null);
      return;
    }
    const entry = entries.find((e) => e.id === selectedId);
    if (!entry) {
      setRawContent(null);
      return;
    }
    setRawLoading(true);
    setRawContent(null);
    readMemory(workspaceRoot, entry.relPath)
      .then((c) => {
        if (!cancelled) setRawContent(c);
      })
      .catch(() => {
        if (!cancelled) setRawContent(null);
      })
      .finally(() => {
        if (!cancelled) setRawLoading(false);
      });
    let cancelled = false;
    return () => {
      cancelled = true;
    };
  }, [workspaceRoot, selectedId, entries]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (e) =>
        e.title.toLowerCase().includes(q) ||
        e.goal.toLowerCase().includes(q) ||
        e.notes.toLowerCase().includes(q) ||
        e.decisions.some((d) => d.toLowerCase().includes(q))
    );
  }, [entries, query]);

  const selected = entries.find((e) => e.id === selectedId) ?? null;

  async function openInEditor(entry: MemoryEntry) {
    if (!onOpenInEditor || !workspaceRoot) return;
    try {
      const content = await readMemory(workspaceRoot, entry.relPath);
      onOpenInEditor(entry.path, content);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <aside
      className="floating-panel"
      style={{
        width: fill ? "100%" : _width,
        height: fill ? "100%" : undefined,
        margin: fill ? 0 : "4px 0 4px 4px",
        display: fill || visible ? "flex" : "none",
        flexDirection: "column",
        flexShrink: 0,
        overflow: "hidden",
      }}
    >
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        {/* -------- list -------- */}
        <div
          style={{
            width: 270,
            flexShrink: 0,
            borderRight: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          <div
            style={{
              height: 44,
              flexShrink: 0,
              padding: "0 8px 0 14px",
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                flex: 1,
                fontSize: 11,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "var(--fg-subtle)",
                fontWeight: 500,
              }}
            >
              <BookmarkIcon />
              {entries.length} {entries.length === 1 ? "entry" : "entries"}
            </span>
            <button
              onClick={() => setSearchOpen((o) => !o)}
              aria-label="Search"
              style={iconBtn(searchOpen)}
              onMouseEnter={(e) =>
                (e.currentTarget.style.color = "var(--fg-strong)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.color = searchOpen
                  ? "var(--fg-strong)"
                  : "var(--fg-subtle)")
              }
            >
              <SearchIcon />
            </button>
            <button
              onClick={() => void refresh()}
              aria-label="Refresh"
              title={loading ? "Refreshing" : "Refresh"}
              style={iconBtn(false)}
              onMouseEnter={(e) =>
                (e.currentTarget.style.color = "var(--fg-strong)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.color = "var(--fg-subtle)")
              }
            >
              <RefreshIcon />
            </button>
          </div>
          {searchOpen && (
            <div style={{ padding: "0 10px 8px" }}>
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter…"
                style={{
                  width: "100%",
                  fontSize: 12,
                  padding: "6px 9px",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-sm)",
                  background: "var(--bg)",
                  color: "var(--fg-strong)",
                  outline: "none",
                }}
              />
            </div>
          )}
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "2px 8px 10px",
              minHeight: 0,
            }}
          >
            {!workspaceRoot && (
              <div
                style={{
                  padding: "14px 8px",
                  color: "var(--fg-subtle)",
                  fontSize: 12,
                  lineHeight: 1.55,
                }}
              >
                Open a folder to start a project memory.
              </div>
            )}
            {workspaceRoot && error && (
              <div
                style={{
                  padding: "10px 8px",
                  color: "var(--danger, #B42318)",
                  fontSize: 12,
                }}
              >
                {error}
              </div>
            )}
            {workspaceRoot && !error && filtered.length === 0 && (
              <div
                style={{
                  padding: "14px 8px",
                  color: "var(--fg-subtle)",
                  fontSize: 12,
                  lineHeight: 1.55,
                }}
              >
                {entries.length === 0
                  ? "No memory yet. Click Summarize in the AI panel to write the first handoff note."
                  : "No entries match this filter."}
              </div>
            )}
            {filtered.map((e) => {
              const active = e.id === selectedId;
              return (
                <div
                  key={e.id}
                  onClick={() => setSelectedId(e.id)}
                  style={{
                    padding: "10px 11px",
                    marginBottom: 5,
                    cursor: "pointer",
                    borderRadius: "var(--radius-md)",
                    border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                    background: active ? "var(--accent-soft)" : "var(--bg)",
                    transition:
                      "border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)",
                  }}
                  onMouseEnter={(ev) => {
                    if (!active) ev.currentTarget.style.background = "var(--bg-hover)";
                  }}
                  onMouseLeave={(ev) => {
                    if (!active) ev.currentTarget.style.background = "var(--bg)";
                  }}
                >
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      color: "var(--fg-strong)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {e.title}
                  </div>
                  {(e.goal || e.notes) && (
                    <div
                      style={{
                        fontSize: 11.5,
                        color: "var(--fg-subtle)",
                        marginTop: 4,
                        lineHeight: 1.45,
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {e.goal || e.notes}
                    </div>
                  )}
                  <div
                    style={{
                      marginTop: 7,
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      flexWrap: "wrap",
                    }}
                  >
                    {e.mode && <span style={pillStyle()}>{e.mode}</span>}
                    {e.provider && (
                      <span
                        style={{
                          fontSize: 10.5,
                          color: "var(--fg-dim)",
                          fontFamily: "var(--font-mono)",
                        }}
                      >
                        {e.provider}
                      </span>
                    )}
                    {e.provider && e.model && (
                      <span style={{ color: "var(--fg-dim)" }}>·</span>
                    )}
                    {e.model && (
                      <span
                        style={{
                          fontSize: 10.5,
                          color: "var(--fg-dim)",
                          fontFamily: "var(--font-mono)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          maxWidth: 110,
                        }}
                      >
                        {e.model}
                      </span>
                    )}
                    <span
                      style={{
                        marginLeft: "auto",
                        fontSize: 10.5,
                        color: "var(--fg-dim)",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      {relativeMemoryTime(e.createdAtMs)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* -------- detail -------- */}
        <div style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
          {!selected ? (
            <EmptyDetail />
          ) : (
            <MemoryDetail
              entry={selected}
              rawView={rawView}
              setRawView={setRawView}
              rawContent={rawContent}
              rawLoading={rawLoading}
              onOpenInEditor={() => void openInEditor(selected)}
            />
          )}
        </div>
      </div>
    </aside>
  );
}

/* ============================================================ detail === */

function MemoryDetail({
  entry,
  rawView,
  setRawView,
  rawContent,
  rawLoading,
  onOpenInEditor,
}: {
  entry: MemoryEntry;
  rawView: boolean;
  setRawView: (v: boolean) => void;
  rawContent: string | null;
  rawLoading: boolean;
  onOpenInEditor: () => void;
}) {
  return (
    <div style={{ padding: "22px 26px", maxWidth: 760 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <h2
          style={{
            flex: 1,
            minWidth: 0,
            margin: 0,
            fontSize: 19,
            fontWeight: 600,
            color: "var(--fg-strong)",
            letterSpacing: "-0.01em",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {entry.title}
        </h2>
        <button
          onClick={onOpenInEditor}
          style={{
            height: 28,
            padding: "0 12px",
            borderRadius: "var(--radius-sm)",
            fontSize: 12.5,
            color: "var(--fg)",
            background: "transparent",
            border: "1px solid var(--border)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--bg-hover)";
            e.currentTarget.style.color = "var(--fg-strong)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "var(--fg)";
          }}
        >
          Open in editor
        </button>
      </div>

      <div
        style={{
          marginTop: 10,
          fontSize: 12,
          color: "var(--fg-subtle)",
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          alignItems: "center",
        }}
      >
        <span>Written {relativeMemoryTime(entry.createdAtMs)}</span>
        {entry.mode && (
          <>
            <span style={{ color: "var(--fg-dim)" }}>·</span>
            <span>{entry.mode}</span>
          </>
        )}
        {entry.provider && (
          <>
            <span style={{ color: "var(--fg-dim)" }}>·</span>
            <span>{entry.provider}</span>
          </>
        )}
        {entry.model && (
          <>
            <span style={{ color: "var(--fg-dim)" }}>·</span>
            <span style={{ fontFamily: "var(--font-mono)" }}>{entry.model}</span>
          </>
        )}
      </div>

      {/* segmented Preview / Source view */}
      <div
        style={{
          marginTop: 18,
          display: "flex",
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <span
          style={{
            fontSize: 10.5,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "var(--fg-subtle)",
            fontWeight: 500,
          }}
        >
          Note
        </span>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", gap: 2 }}>
          <button
            onClick={() => setRawView(false)}
            aria-label="Preview"
            title="Preview"
            style={segBtn(!rawView)}
            onMouseEnter={(e) => {
              if (rawView) e.currentTarget.style.color = "var(--fg-strong)";
            }}
            onMouseLeave={(e) => {
              if (rawView) e.currentTarget.style.color = "var(--fg-strong)";
              else e.currentTarget.style.color = "var(--fg-subtle)";
            }}
          >
            <EyeIcon />
          </button>
          <button
            onClick={() => setRawView(true)}
            aria-label="Source"
            title="Source"
            style={segBtn(rawView)}
            onMouseEnter={(e) => {
              if (!rawView) e.currentTarget.style.color = "var(--fg-strong)";
            }}
            onMouseLeave={(e) => {
              if (rawView) e.currentTarget.style.color = "var(--fg-strong)";
              else e.currentTarget.style.color = "var(--fg-subtle)";
            }}
          >
            <CodeIcon />
          </button>
        </div>
      </div>

      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-md)",
          background: "var(--bg)",
          padding: "16px 20px",
        }}
      >
        {rawView ? (
          rawLoading ? (
            <div style={{ color: "var(--fg-subtle)", fontSize: 12 }}>
              Loading source…
            </div>
          ) : rawContent ? (
            <pre
              style={{
                margin: 0,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                lineHeight: 1.65,
                color: "var(--fg)",
              }}
            >
              {rawContent}
            </pre>
          ) : (
            <div style={{ color: "var(--fg-subtle)", fontSize: 12 }}>
              Could not read the source file.
            </div>
          )
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {entry.goal && (
              <Section title="Goal">{renderInlineMarkdown(entry.goal)}</Section>
            )}
            {entry.plan.length > 0 && (
              <Section title="Plan">
                <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.55 }}>
                  {entry.plan.map((line, i) => (
                    <li key={i} style={{ fontSize: 13, color: "var(--fg)" }}>
                      {renderInlineMarkdown(line)}
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            {entry.decisions.length > 0 && (
              <Section title="Decisions">
                <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.55 }}>
                  {entry.decisions.map((line, i) => (
                    <li key={i} style={{ fontSize: 13, color: "var(--fg)" }}>
                      {renderInlineMarkdown(line)}
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            {entry.filesTouched.length > 0 && (
              <Section title="Files touched">
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 6,
                    marginTop: 2,
                  }}
                >
                  {entry.filesTouched.map((path) => (
                    <FileChip key={path} path={path} />
                  ))}
                </div>
              </Section>
            )}
            {entry.nextSteps.length > 0 && (
              <Section title="Next steps">
                <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.55 }}>
                  {entry.nextSteps.map((line, i) => (
                    <li key={i} style={{ fontSize: 13, color: "var(--fg)" }}>
                      {renderInlineMarkdown(line)}
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            {entry.notes && (
              <Section title="Notes">
                <p
                  style={{
                    margin: 0,
                    fontSize: 13,
                    lineHeight: 1.6,
                    color: "var(--fg)",
                  }}
                >
                  {renderInlineMarkdown(entry.notes)}
                </p>
              </Section>
            )}
            {nothingToShow(entry) && (
              <div style={{ color: "var(--fg-subtle)", fontSize: 13 }}>
                This entry has no content yet.
              </div>
            )}
          </div>
        )}
      </div>

      <div
        style={{
          marginTop: 14,
          fontSize: 11,
          color: "var(--fg-dim)",
          fontFamily: "var(--font-mono)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {entry.relPath}
      </div>
    </div>
  );
}

function nothingToShow(e: MemoryEntry): boolean {
  return (
    !e.goal &&
    e.plan.length === 0 &&
    e.decisions.length === 0 &&
    e.filesTouched.length === 0 &&
    e.nextSteps.length === 0 &&
    !e.notes
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 10.5,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--fg-subtle)",
          fontWeight: 500,
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function FileChip({ path }: { path: string }) {
  return (
    <span
      title={path}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 11,
        fontFamily: "var(--font-mono)",
        color: "var(--fg-subtle)",
        background: "var(--bg-elevated)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-xs)",
        padding: "2px 7px",
        maxWidth: "100%",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      <FileIcon />
      {path}
    </span>
  );
}

function EmptyDetail() {
  return (
    <div
      style={{
        height: "100%",
        display: "grid",
        placeItems: "center",
        color: "var(--fg-subtle)",
        textAlign: "center",
        padding: 24,
      }}
    >
      <div>
        <div
          style={{
            color: "var(--fg)",
            marginBottom: 8,
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          No memory selected
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.55, maxWidth: 280 }}>
          Pick an entry on the left to read its handoff note. Each entry is
          one markdown file in <code>.klide/memory/</code> — a future agent
          can pick up where the last session stopped.
        </div>
      </div>
    </div>
  );
}
