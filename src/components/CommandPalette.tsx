import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { listWorkspaceFiles } from "./ai/workspaceFiles";
import { readWorkspaceTextFile } from "../workspaceFs";
import { isSpreadsheetPath } from "../spreadsheets/paths";
import { Z } from "../zLayers";
import { fileMatchRank } from "../fileSearch";
import { SearchIcon } from "../icons";
import { Kbd } from "./Kbd";
import { FileTypeIcon } from "./fileMarks";

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

type Row =
  | { kind: "heading"; key: string; label: string }
  | {
      kind: "item";
      key: string;
      index: number;
      title: string;
      /** A file row's name, for its type icon. */
      file?: string;
      detail?: string;
      hint?: string;
      keys?: string[];
    };

/** "View: Git Review" → category "View", name "Git Review". */
export function splitCommandLabel(label: string): { category: string | null; name: string } {
  const at = label.indexOf(": ");
  if (at <= 0) return { category: null, name: label };
  return { category: label.slice(0, at), name: label.slice(at + 2) };
}

/** "⌘⇧F" → ["⌘", "⇧", "F"]; a named key ("Esc") stays whole. */
export function splitShortcut(shortcut: string): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < shortcut.length && "⌘⇧⌥⌃".includes(shortcut[i])) keys.push(shortcut[i++]);
  const rest = shortcut.slice(i);
  if (rest) keys.push(rest);
  return keys;
}

/** Stable grouping: categories in order of first appearance, commands kept
 *  in the host's order within each. */
export function groupByCategory<T extends { label: string }>(commands: T[]): T[] {
  const order: string[] = [];
  const byCategory = new Map<string, T[]>();
  for (const cmd of commands) {
    const category = splitCommandLabel(cmd.label).category ?? "";
    if (!byCategory.has(category)) {
      byCategory.set(category, []);
      order.push(category);
    }
    byCategory.get(category)!.push(cmd);
  }
  return order.flatMap((category) => byCategory.get(category)!);
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
        .map((cmd) => ({ ...cmd, rank: fileMatchRank(cmd.label, searchQuery) }))
        .filter((c): c is typeof c & { rank: number } => c.rank !== null)
        .sort((a, b) => a.rank - b.rank)
    : [];

  const filteredFiles = !isCommandMode && filesLoaded
    ? files
        .map((f) => ({ ...f, rank: fileMatchRank(f.path, query) }))
        .filter((f): f is typeof f & { rank: number } => f.rank !== null)
        .sort((a, b) => a.rank - b.rank || a.path.length - b.path.length)
        .slice(0, 15)
    : [];

  // Commands read "Category: Name". With nothing typed they are grouped under
  // their category in the order the host lists them; a search ranks them flat
  // and names the category beside each row instead.
  const groupCommands = isCommandMode && searchQuery.length === 0;
  const orderedCommands = groupCommands ? groupByCategory(filteredCommands) : filteredCommands;
  const showRecent = !isCommandMode && recentFiles.length > 0 && query.length === 0;
  const fileItems = showRecent ? recentFiles : filteredFiles;

  const totalResults = isCommandMode ? orderedCommands.length : fileItems.length;

  const selectedIdxSafe = Math.max(0, Math.min(selectedIdx, Math.max(totalResults - 1, 0)));

  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  // Clicks pass their row index explicitly: setSelectedIdx(i) hasn't
  // re-rendered yet when the same tick calls execute(), so reading
  // selectedIdxSafe here would act on the previous selection.
  const execute = useCallback((idx?: number) => {
    const at = idx ?? selectedIdxSafe;
    if (isCommandMode && orderedCommands.length > 0) {
      orderedCommands[at]?.action();
    } else if (!isCommandMode) {
      if (fileItems.length > 0) {
        const f = fileItems[at] ?? fileItems[0];
        saveRecentFile(f.path);
        void (async () => {
          try {
            if (!workspaceRoot) return;
            const content = isSpreadsheetPath(f.path) ? "" : await readWorkspaceTextFile(workspaceRoot, f.path);
            onOpenFile(f.path, content);
            window.dispatchEvent(new CustomEvent("command-palette-close"));
          } catch {}
        })();
      }
    }
  }, [isCommandMode, orderedCommands, fileItems, selectedIdxSafe, workspaceRoot, onOpenFile]);

  const close = useCallback(() => {
    window.dispatchEvent(new CustomEvent("command-palette-close"));
  }, []);

  // The card's height follows its content: measured from the inner column,
  // animated only after the first measurement so it opens at its size.
  const rootRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [sized, setSized] = useState(false);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => setHeight(el.offsetHeight + 2);
    measure();
    const frame = requestAnimationFrame(() => setSized(true));
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  // One highlight that slides to the selected row; it only animates once it
  // has been placed, so it never sweeps in from the top on open.
  const listRef = useRef<HTMLDivElement>(null);
  const rowEls = useRef<(HTMLDivElement | null)[]>([]);
  const [indicator, setIndicator] = useState<{ top: number; height: number } | null>(null);
  const [ready, setReady] = useState(false);

  // One row model for the list: headings carry no index, items carry the
  // index Enter and click act on.
  const rows: Row[] = [];
  if (isCommandMode) {
    let group: string | null = null;
    orderedCommands.forEach((cmd, index) => {
      const { category, name } = splitCommandLabel(cmd.label);
      if (groupCommands && category && category !== group) {
        group = category;
        rows.push({ kind: "heading", key: `h:${category}`, label: category });
      }
      rows.push({
        kind: "item",
        key: `c:${cmd.id}`,
        index,
        title: name,
        hint: groupCommands ? undefined : category ?? undefined,
        keys: cmd.shortcut ? splitShortcut(cmd.shortcut) : undefined,
      });
    });
  } else if (fileItems.length > 0) {
    rows.push({ kind: "heading", key: "h:files", label: showRecent ? "Recent" : "Files" });
    fileItems.forEach((f, index) => {
      rows.push({ kind: "item", key: `f:${f.path}`, index, file: f.base, title: f.base, detail: f.dir || undefined });
    });
  }
  const rowsKey = rows.map((row) => row.key).join("|");

  useLayoutEffect(() => {
    const el = rowEls.current[selectedIdxSafe];
    if (!el || totalResults === 0) {
      setIndicator(null);
      return;
    }
    setIndicator({ top: el.offsetTop, height: el.offsetHeight });
    el.scrollIntoView({ block: "nearest" });
  }, [selectedIdxSafe, rowsKey, totalResults]);
  useEffect(() => {
    if (!indicator || ready) return;
    const frame = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(frame);
  }, [indicator, ready]);

  const emptyText = isCommandMode
    ? searchQuery ? "No matching commands" : null
    : !filesLoaded
      ? "Indexing workspace…"
      : query.length > 0 ? `No files matching "${query}"` : null;

  return (
    <div
      className="klide-cmd-scrim"
      style={{ zIndex: Z.popover }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="klide-cmd"
        role="dialog"
        aria-label={isCommandMode ? "Commands" : "Go to file"}
        data-sized={sized || undefined}
        data-ready={ready || undefined}
        style={{ height: height ?? undefined }}
      >
        <div ref={rootRef} className="klide-cmd-root">
          <div className="klide-cmd-header">
            <SearchIcon size={15} />
            <input
              ref={inputRef}
              className="klide-cmd-input"
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
                  close();
                }
              }}
              placeholder={isCommandMode ? "Type a command…" : filesLoaded ? "Search files by name…" : "Loading files…"}
              spellCheck={false}
              autoComplete="off"
              aria-activedescendant={totalResults > 0 ? `klide-cmd-${selectedIdxSafe}` : undefined}
            />
            {!isCommandMode && <span className="klide-cmd-mode">&gt; commands</span>}
            <button className="klide-cmd-esc" onClick={close} aria-label="Close">Esc</button>
          </div>

          {(rows.length > 0 || emptyText) && (
            <div ref={listRef} className="klide-cmd-list" role="listbox">
              {indicator && rows.length > 0 && (
                <div
                  className="klide-cmd-indicator"
                  style={{ transform: `translateY(${indicator.top}px)`, height: indicator.height }}
                />
              )}
              {rows.map((row) =>
                row.kind === "heading" ? (
                  <div key={row.key} className="klide-cmd-heading">{row.label}</div>
                ) : (
                  <div
                    key={row.key}
                    id={`klide-cmd-${row.index}`}
                    ref={(el) => { rowEls.current[row.index] = el; }}
                    className="klide-cmd-option"
                    role="option"
                    aria-selected={row.index === selectedIdxSafe}
                    data-active={row.index === selectedIdxSafe || undefined}
                    onMouseMove={() => { if (row.index !== selectedIdxSafe) setSelectedIdx(row.index); }}
                    onClick={() => { setSelectedIdx(row.index); execute(row.index); }}
                  >
                    {row.file && <FileTypeIcon name={row.file} size={15} />}
                    <div className="klide-cmd-label">
                      <span>{row.title}</span>
                      {row.detail && <small>{row.detail}</small>}
                    </div>
                    {row.hint && <span className="klide-cmd-hint">{row.hint}</span>}
                    {row.keys && <Kbd keys={row.keys} />}
                  </div>
                ),
              )}
              {rows.length === 0 && emptyText && <div className="klide-cmd-empty">{emptyText}</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
