import { useEffect, useRef, useState, useCallback } from "react";
import { listWorkspaceFiles } from "./ai/tool-execution";

type CommandItem = {
  id: string;
  label: string;
  shortcut?: string;
  action: () => void;
};

type FileItem = {
  path: string;
  dir: string;
  base: string;
};

type Props = {
  workspaceRoot: string | null;
  commands: CommandItem[];
  onOpenFile: (path: string, content: string) => void;
  initialQuery?: string;
};

function fuzzyScore(needle: string, hay: string): number {
  const n = needle.toLowerCase();
  const h = hay.toLowerCase();
  const base = h.split("/").pop() ?? h;
  if (base === n) return 100;
  if (base.startsWith(n)) return 80;
  if (h.startsWith(n)) return 70;
  if (h.includes(n)) return 50;
  if (isSubsequence(n, h)) return 20;
  return -1;
}

function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++;
  }
  return i === needle.length;
}

const RECENT_FILES_KEY = "klide.recentFiles";

function loadRecentFiles(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_FILES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveRecentFile(path: string) {
  const recent = loadRecentFiles().filter((p) => p !== path);
  recent.unshift(path);
  localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(recent.slice(0, 20)));
}

function pathToFile(path: string): FileItem {
  const idx = path.lastIndexOf("/");
  return {
    path,
    dir: idx >= 0 ? path.slice(0, idx + 1) : "",
    base: idx >= 0 ? path.slice(idx + 1) : path,
  };
}

export function CommandPalette({ workspaceRoot, commands, onOpenFile, initialQuery }: Props) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [filesLoaded, setFilesLoaded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const isCommandMode = query.startsWith(">");
  const searchQuery = isCommandMode ? query.slice(1).trimStart() : query;

  useEffect(() => {
    inputRef.current?.focus();
    const sel = inputRef.current?.value.length ?? 0;
    inputRef.current?.setSelectionRange(sel, sel);
  }, []);

  useEffect(() => {
    if (filesLoaded || !workspaceRoot) return;
    let cancelled = false;
    void (async () => {
      try {
        const all = await listWorkspaceFiles(workspaceRoot);
        if (cancelled) return;
        setFiles(all.map(pathToFile));
        setFilesLoaded(true);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [workspaceRoot, filesLoaded]);

  const recentFiles: FileItem[] = isCommandMode ? [] : (query.length === 0 ? loadRecentFiles().map(pathToFile) : []);

  const filteredCommands = isCommandMode || (!filesLoaded && query.length > 0)
    ? commands
        .map((cmd) => ({ ...cmd, score: fuzzyScore(searchQuery, cmd.label) }))
        .filter((c) => c.score >= 0)
        .sort((a, b) => b.score - a.score)
    : [];

  const filteredFiles = !isCommandMode && filesLoaded
    ? files
        .map((f) => ({ ...f, score: fuzzyScore(query, f.path) }))
        .filter((f) => f.score >= 0)
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return a.path.length - b.path.length;
        })
        .slice(0, 15)
    : [];

  const totalResults = isCommandMode ? filteredCommands.length : recentFiles.length > 0 ? recentFiles.length : filteredFiles.length;

  const selectedIdxSafe = Math.max(0, Math.min(selectedIdx, Math.max(totalResults - 1, 0)));

  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  // Clicks pass their row index explicitly: setSelectedIdx(i) hasn't
  // re-rendered yet when the same tick calls execute(), so reading
  // selectedIdxSafe here would act on the previous selection.
  const execute = useCallback((idx?: number) => {
    const at = idx ?? selectedIdxSafe;
    if (isCommandMode && filteredCommands.length > 0) {
      filteredCommands[at]?.action();
    } else if (!isCommandMode) {
      const items = recentFiles.length > 0 && query.length === 0 ? recentFiles : filteredFiles;
      if (items.length > 0) {
        const f = items[at] ?? items[0];
        saveRecentFile(f.path);
        void (async () => {
          try {
            const { readTextFile } = await import("@tauri-apps/plugin-fs");
            const content = await readTextFile(`${workspaceRoot}/${f.path}`);
            onOpenFile(f.path, content);
            window.dispatchEvent(new CustomEvent("command-palette-close"));
          } catch {}
        })();
      }
    }
  }, [isCommandMode, filteredCommands, filteredFiles, recentFiles, query, selectedIdxSafe, workspaceRoot, onOpenFile]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        display: "flex",
        justifyContent: "center",
        paddingTop: "18vh",
        background: "color-mix(in srgb, var(--bg) 60%, transparent)",
        backdropFilter: "blur(2px) saturate(1.4)",
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          window.dispatchEvent(new CustomEvent("command-palette-close"));
        }
      }}
    >
      <div
        style={{
          width: "min(560px, 90vw)",
          maxHeight: "min(420px, 60vh)",
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--border-strong)",
          borderRadius: "var(--radius-lg)",
          background: "var(--bg-elevated)",
          boxShadow: "0 16px 48px rgba(38, 38, 32, 0.22)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 14px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <svg
            width="15" height="15" viewBox="0 0 24 24"
            fill="none" stroke="var(--fg-dim)" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
            style={{ flexShrink: 0 }}
          >
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelectedIdx((i) => Math.min(i + 1, Math.max(totalResults - 1, 0)));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelectedIdx((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                execute();
              } else if (e.key === "Escape") {
                e.preventDefault();
                window.dispatchEvent(new CustomEvent("command-palette-close"));
              }
            }}
            placeholder={isCommandMode ? "Type a command…" : filesLoaded ? "Search files by name…" : "Loading files…"}
            spellCheck={false}
            autoComplete="off"
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              background: "transparent",
              color: "var(--fg-strong)",
              font: "inherit",
              fontSize: 14,
            }}
          />
          {!isCommandMode && (
            <span
              style={{
                fontSize: 10,
                color: "var(--fg-dim)",
                flexShrink: 0,
                letterSpacing: "0.04em",
              }}
            >
              {query.length === 0 ? "recent" : "&gt; for commands"}
            </span>
          )}
        </div>

        <div style={{ flex: 1, overflow: "auto", overscrollBehavior: "contain", padding: 4 }}>
          {/* Recent files (shown when query is empty) */}
          {!isCommandMode && recentFiles.length > 0 && (
            <>
              <div style={{ padding: "4px 12px 2px", color: "var(--fg-dim)", fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", fontWeight: 600 }}>
                Recent
              </div>
              {recentFiles.map((f, i) => (
                <div
                  key={`recent-${f.path}`}
                  onMouseEnter={() => setSelectedIdx(i)}
                  onClick={() => { setSelectedIdx(i); execute(i); }}
                  style={{
                    display: "flex", alignItems: "baseline", gap: 4, padding: "7px 12px",
                    borderRadius: "var(--radius-sm)", cursor: "pointer", overflow: "hidden",
                    background: i === selectedIdxSafe ? "var(--bg-hover)" : "transparent",
                  }}
                >
                  <span style={{ color: "var(--fg-strong)", fontSize: 13, fontWeight: 500, flexShrink: 0 }}>{f.base}</span>
                  {f.dir && <span style={{ color: "var(--fg-dim)", fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.dir}</span>}
                </div>
              ))}
            </>
          )}

          {/* Commands */}
          {isCommandMode && filteredCommands.length === 0 && searchQuery && (
            <div style={{ padding: "14px 12px", color: "var(--fg-subtle)", fontSize: 12, textAlign: "center" }}>
              No matching commands
            </div>
          )}
          {isCommandMode && filteredCommands.map((cmd, i) => (
            <div
              key={cmd.id}
              onMouseEnter={() => setSelectedIdx(i)}
              onClick={() => { setSelectedIdx(i); execute(i); }}
              style={{
                display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
                padding: "7px 12px", borderRadius: "var(--radius-sm)", cursor: "pointer",
                background: i === selectedIdxSafe ? "var(--bg-hover)" : "transparent",
                color: "var(--fg-strong)", fontSize: 13,
              }}
            >
              <span>{cmd.label}</span>
              {cmd.shortcut && (
                <span style={{ fontSize: 11, color: "var(--fg-dim)", letterSpacing: "0.03em" }}>{cmd.shortcut}</span>
              )}
            </div>
          ))}

          {/* File results */}
          {!isCommandMode && (recentFiles.length === 0 || query.length > 0) &&
            filteredFiles.map((f, i) => (
              <div
                key={f.path}
                onMouseEnter={() => setSelectedIdx(i)}
                onClick={() => { setSelectedIdx(i); execute(i); }}
                style={{
                  display: "flex", alignItems: "baseline", gap: 4, padding: "7px 12px",
                  borderRadius: "var(--radius-sm)", cursor: "pointer", overflow: "hidden",
                  background: i === selectedIdxSafe ? "var(--bg-hover)" : "transparent",
                }}
              >
                <span style={{ color: "var(--fg-strong)", fontSize: 13, fontWeight: 500, flexShrink: 0 }}>{f.base}</span>
                {f.dir && <span style={{ color: "var(--fg-dim)", fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.dir}</span>}
              </div>
            ))}

          {/* Loading state */}
          {!isCommandMode && !filesLoaded && (
            <div style={{ padding: "14px 12px", color: "var(--fg-subtle)", fontSize: 12, textAlign: "center" }}>
              Indexing workspace…
            </div>
          )}

          {/* No results */}
          {!isCommandMode && filesLoaded && query.length > 0 && filteredFiles.length === 0 && recentFiles.length === 0 && (
            <div style={{ padding: "14px 12px", color: "var(--fg-subtle)", fontSize: 12, textAlign: "center" }}>
              No files matching "{query}"
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
