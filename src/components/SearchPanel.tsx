import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

type SearchMatch = {
  file: string;
  line: number;
  column: number;
  content: string;
};

type SearchResult = {
  matches: SearchMatch[];
  fileCount: number;
  capped: boolean;
};

type Props = {
  workspaceRoot: string | null;
  visible: boolean;
  onClose: () => void;
  onOpenFile: (path: string, content: string) => void;
};

export function SearchPanel({ workspaceRoot, visible, onClose, onOpenFile }: Props) {
  const [pattern, setPattern] = useState("");
  const [include, setInclude] = useState("");
  const [results, setResults] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (visible) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [visible]);

  async function doSearch() {
    if (!workspaceRoot || !pattern.trim()) return;
    setSearching(true);
    setError("");
    try {
      const result = await invoke<SearchResult>("search_in_files", {
        workspaceRoot,
        pattern: pattern.trim(),
        include: include.trim() || null,
      });
      setResults(result);
    } catch (e) {
      if ((e as any)?.toString) {
        setError((e as any).toString());
      }
    } finally {
      setSearching(false);
    }
  }

  async function openMatch(m: SearchMatch) {
    try {
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      const content = await readTextFile(`${workspaceRoot}/${m.file}`);
      onOpenFile(m.file, content);
    } catch {}
  }

  if (!visible) return null;

  return (
    <div
      className="floating-panel"
      style={{
        display: "flex",
        flexDirection: "column",
        margin: "4px 4px 0 4px",
        overflow: "hidden",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <svg
          width="14" height="14" viewBox="0 0 24 24"
          fill="none" stroke="var(--fg-dim)" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
          style={{ flexShrink: 0 }}
        >
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
        <input
          ref={inputRef}
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") doSearch();
            if (e.key === "Escape") onClose();
          }}
          placeholder="Find in files..."
          spellCheck={false}
          autoComplete="off"
          style={{
            flex: 1,
            border: "none",
            outline: "none",
            background: "transparent",
            color: "var(--fg-strong)",
            font: "inherit",
            fontSize: 13,
          }}
        />
        <input
          value={include}
          onChange={(e) => setInclude(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") doSearch(); }}
          placeholder="*.ts"
          spellCheck={false}
          autoComplete="off"
          style={{
            width: 72,
            border: "none",
            outline: "none",
            background: "transparent",
            color: "var(--fg-subtle)",
            font: "inherit",
            fontSize: 12,
          }}
        />
        <button
          onClick={onClose}
          style={{
            width: 22, height: 22, display: "grid", placeItems: "center",
            borderRadius: "var(--radius-xs)", color: "var(--fg-dim)", background: "transparent",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--fg-strong)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-dim)"; e.currentTarget.style.background = "transparent"; }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "0 4px" }}>
        {searching && (
          <div style={{ padding: "14px 12px", color: "var(--fg-subtle)", fontSize: 12, textAlign: "center" }}>
            Searching...
          </div>
        )}
        {error && (
          <div style={{ padding: "14px 12px", color: "var(--danger)", fontSize: 12, textAlign: "center" }}>
            {error}
          </div>
        )}
        {results && !searching && (
          <>
            <div style={{ padding: "6px 10px", color: "var(--fg-subtle)", fontSize: 11, display: "flex", justifyContent: "space-between" }}>
              <span>{results.fileCount} file{results.fileCount !== 1 ? "s" : ""} — {results.matches.length} match{results.matches.length !== 1 ? "es" : ""}{results.capped ? " (capped at 500)" : ""}</span>
            </div>
            {results.matches.length === 0 && (
              <div style={{ padding: "14px 12px", color: "var(--fg-subtle)", fontSize: 12, textAlign: "center" }}>
                No matches for "{pattern}"
              </div>
            )}
            {results.matches.map((m, i) => (
              <div
                key={i}
                onClick={() => openMatch(m)}
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1fr) auto minmax(0, 2fr)",
                  gap: 10,
                  padding: "4px 10px",
                  borderRadius: "var(--radius-xs)",
                  cursor: "pointer",
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  alignItems: "baseline",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                <span
                  style={{
                    color: "var(--accent)",
                    fontWeight: 500,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {m.file}
                </span>
                <span style={{ color: "var(--fg-dim)", textAlign: "right", flexShrink: 0 }}>
                  {m.line}:{m.column}
                </span>
                <span
                  style={{
                    color: "var(--fg)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {m.content.trimStart()}
                </span>
              </div>
            ))}
          </>
        )}
        {!results && !searching && !error && (
          <div style={{ padding: "14px 12px", color: "var(--fg-subtle)", fontSize: 12, textAlign: "center" }}>
            Type a pattern and press Enter to search
          </div>
        )}
      </div>
    </div>
  );
}
