import { confirm, open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, FocusEvent, KeyboardEvent } from "react";
import { ContextMenu, MenuItem } from "./ContextMenu";
import { FileTypeIcon } from "./fileMarks";
import type { GitFile, GitStatus } from "../gitTypes";

type Props = {
  onOpen: (path: string, content: string) => void;
  onRootChange: (root: string | null) => void;
  onEntryRenamed?: (oldPath: string, newPath: string) => void;
  onEntryDeleted?: (path: string) => void;
  onFilePreview?: (path: string) => void;
  /** The currently-open tab's path, used to highlight the active row. */
  activePath?: string | null;
  visible: boolean;
  width: number;
  workspaceRoot: string | null;
  fill?: boolean;
  /** Show dotfiles in the tree. Defaults to true (Settings → General). */
  showHidden?: boolean;
};

type TreeEntry = {
  name: string;
  isDirectory: boolean;
  virtual?: boolean;
};

type GitDecoration = {
  label: string;
  color: string;
  title: string;
};

type MenuTarget = {
  x: number;
  y: number;
  path: string;
  isDirectory: boolean;
};

type Editing =
  | { mode: "rename"; path: string }
  | { mode: "create"; parent: string; isDirectory: boolean };

function ChevronRight() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}

function KebabIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="5" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="12" cy="19" r="1.5" />
    </svg>
  );
}

function FilePlusIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M12 11v6" />
      <path d="M9 14h6" />
    </svg>
  );
}

function FolderPlusIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7.5C3 6.4 3.9 5.5 5 5.5h3.5l2 2H19c1.1 0 2 .9 2 2v7c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2v-9z" />
      <path d="M12 11v6" />
      <path d="M9 14h6" />
    </svg>
  );
}

function FolderOpenSmall() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7.5C3 6.4 3.9 5.5 5 5.5h3.5l2 2H19c1.1 0 2 .9 2 2v7c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2v-9z" />
      <path d="M3 14h5l1.5-3h7L18 14" />
    </svg>
  );
}

function FolderRow({ open }: { open: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--fg-subtle)" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <path
        fill="none"
        d="M3 7.5C3 6.4 3.9 5.5 5 5.5h3.5l2 2H19c1.1 0 2 .9 2 2v7c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2v-9z"
      />
      {open && <path d="M3.5 10h17" opacity="0.45" />}
    </svg>
  );
}

// The icon set itself lives in fileMarks.tsx (shared with the tab strip).
function FileRow({ name }: { name: string }) {
  return <FileTypeIcon name={name} />;
}

function joinPath(root: string, name: string): string {
  return `${root.replace(/\/$/, "")}/${name}`;
}

function relativePath(root: string, path: string): string {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

function parentPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function gitLabel(status: string): string {
  if (status === "??") return "U";
  if (status.includes("M")) return "M";
  if (status.includes("A")) return "A";
  if (status.includes("D")) return "D";
  if (status.includes("R")) return "R";
  return status.trim() || "-";
}

function gitDecorationForLabel(label: string): GitDecoration | null {
  if (label === "M") {
    return { label, color: "var(--warning)", title: "Modified" };
  }
  if (label === "A" || label === "U") {
    return {
      label,
      color: "var(--success)",
      title: label === "U" ? "Untracked" : "Added",
    };
  }
  if (label === "D") {
    return { label, color: "var(--danger)", title: "Deleted" };
  }
  if (label === "R") {
    // No dedicated semantic token for "renamed"; the "R" letter carries the
    // meaning, so the accent keeps it theme-aware and distinct from D/M.
    return { label, color: "var(--accent)", title: "Renamed" };
  }
  return null;
}

function gitDecoration(
  root: string,
  path: string,
  isDirectory: boolean,
  gitFiles: GitFile[]
): GitDecoration | null {
  const rel = relativePath(root, path);
  const exact = gitFiles.find((file) => file.path.replace(/\/$/, "") === rel);
  if (exact) return gitDecorationForLabel(gitLabel(exact.status));

  if (!isDirectory) {
    const untrackedParent = gitFiles.find(
      (file) => file.status === "??" && file.path.endsWith("/") && rel.startsWith(file.path)
    );
    return untrackedParent ? gitDecorationForLabel("U") : null;
  }

  const child = gitFiles.find((file) => file.path.startsWith(`${rel}/`));
  return child ? gitDecorationForLabel(gitLabel(child.status)) : null;
}

function gitVirtualEntries(
  root: string,
  basePath: string,
  existingNames: Set<string>,
  gitFiles: GitFile[]
): TreeEntry[] {
  const baseRel = relativePath(root, basePath);
  const virtual = new Map<string, TreeEntry>();

  for (const file of gitFiles) {
    if (gitLabel(file.status) !== "D" || file.path.includes(" -> ")) continue;

    const parent = parentPath(file.path);
    if (parent === baseRel) {
      const name = file.path.split("/").pop();
      if (name && !existingNames.has(name)) {
        virtual.set(name, { name, isDirectory: false, virtual: true });
      }
      continue;
    }

    if (baseRel === "" || parent.startsWith(`${baseRel}/`)) {
      const remainder = baseRel === "" ? parent : parent.slice(baseRel.length + 1);
      const nextDir = remainder.split("/").filter(Boolean)[0];
      if (nextDir && !existingNames.has(nextDir)) {
        virtual.set(nextDir, { name: nextDir, isDirectory: true, virtual: true });
      }
    }
  }

  return Array.from(virtual.values());
}

function expandedStoreKey(root: string): string {
  return `klide-expanded-folders:${root}`;
}

function loadExpanded(root: string | null): Set<string> {
  if (!root) return new Set();
  try {
    const raw = localStorage.getItem(expandedStoreKey(root));
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function InlineNameInput({
  defaultValue,
  onCommit,
  onCancel,
}: {
  defaultValue: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  // The input commits on both Enter and blur; Enter unmounts it, which
  // fires blur too — this flag makes sure we only commit once.
  const doneRef = useRef(false);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    // Select the basename but not the extension (like VS Code's rename).
    const dot = defaultValue.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : defaultValue.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function commit(value: string) {
    if (doneRef.current) return;
    doneRef.current = true;
    onCommit(value);
  }

  function cancel() {
    if (doneRef.current) return;
    doneRef.current = true;
    onCancel();
  }

  return (
    <input
      ref={inputRef}
      defaultValue={defaultValue}
      spellCheck={false}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit(e.currentTarget.value);
        else if (e.key === "Escape") cancel();
      }}
      onBlur={(e) => commit(e.currentTarget.value)}
      style={{
        flex: 1,
        minWidth: 0,
        font: "inherit",
        fontSize: 13,
        color: "var(--fg-strong)",
        background: "var(--bg)",
        border: "1px solid var(--accent)",
        borderRadius: "var(--radius-xs)",
        padding: "0 4px",
        outline: "none",
      }}
    />
  );
}

export function Sidebar({
  onOpen,
  onRootChange,
  onEntryRenamed,
  onEntryDeleted,
  onFilePreview,
  activePath,
  visible,
  width,
  workspaceRoot,
  fill,
  showHidden = true,
}: Props) {
  const root = workspaceRoot;
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [children, setChildren] = useState<Record<string, TreeEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => loadExpanded(root));
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [dirErrors, setDirErrors] = useState<Record<string, string>>({});
  const [gitFiles, setGitFiles] = useState<GitFile[]>([]);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [fsNotice, setFsNotice] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  // Keyboard navigation over the visible rows. Rows carry tabIndex={-1}
  // (roving focus): the tree container is the single tab stop and forwards
  // focus to the active row; arrows walk the flattened visible list read
  // straight from the DOM, so no parallel index has to stay in sync with
  // the expand/collapse state.
  function visibleRows(): HTMLElement[] {
    const el = treeRef.current;
    return el
      ? Array.from(el.querySelectorAll<HTMLElement>('.klide-explorer-row[data-nav="true"]'))
      : [];
  }

  function handleTreeFocus(event: FocusEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    const rows = visibleRows();
    const active = rows.find((row) => row.dataset.active === "true");
    (active ?? rows[0])?.focus();
  }

  function handleTreeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (editing) return; // the inline rename/create input owns the keys
    const rows = visibleRows();
    if (rows.length === 0) return;
    const current =
      document.activeElement instanceof HTMLElement &&
      rows.includes(document.activeElement)
        ? document.activeElement
        : null;
    const index = current ? rows.indexOf(current) : -1;
    const focusRow = (i: number) =>
      rows[Math.max(0, Math.min(rows.length - 1, i))]?.focus();

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusRow(index + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusRow(index - 1);
        break;
      case "Home":
        event.preventDefault();
        focusRow(0);
        break;
      case "End":
        event.preventDefault();
        focusRow(rows.length - 1);
        break;
      case "ArrowRight":
        if (current?.dataset.dir !== "true") return;
        event.preventDefault();
        if (current.dataset.expanded === "true") focusRow(index + 1);
        else current.click();
        break;
      case "ArrowLeft": {
        if (!current) return;
        event.preventDefault();
        if (current.dataset.dir === "true" && current.dataset.expanded === "true") {
          current.click(); // collapse
        } else {
          // Walk out to the enclosing folder's row: li > div.row, li > ul.
          current
            .closest("ul")
            ?.closest("li")
            ?.querySelector<HTMLElement>(":scope > .klide-explorer-row")
            ?.focus();
        }
        break;
      }
      case "Enter":
      case " ":
        if (!current) return;
        event.preventDefault();
        current.click();
        break;
    }
  }

  // File-operation errors surface here instead of dying in the console.
  useEffect(() => {
    if (!fsNotice) return;
    const timer = setTimeout(() => setFsNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [fsNotice]);

  function reportFsError(prefix: string, e: unknown) {
    console.error(prefix, e);
    setFsNotice(`${prefix}: ${e instanceof Error ? e.message : String(e)}`);
  }

  async function refreshGitStatus(workspaceRoot: string): Promise<GitFile[]> {
    try {
      const status = await invoke<GitStatus>("git_status", { workspaceRoot });
      setGitFiles(status.files);
      return status.files;
    } catch {
      setGitFiles([]);
      return [];
    }
  }

  async function pickFolder() {
    const picked = await open({ directory: true });
    if (typeof picked !== "string") return;
    setEntries(await invoke<TreeEntry[]>("list_dir", { workspaceRoot: picked, path: picked }));
    setChildren({});
    setExpanded(loadExpanded(picked));
    setLoadingDirs(new Set());
    setDirErrors({});
    refreshGitStatus(picked);
    onRootChange(picked);
  }

  // Re-read the workspace tree from disk. Used both for the initial
  // useEffect load and for the header "Refresh" button. Re-loads the
  // root + every currently-expanded child, and the git status alongside.
  async function refreshTree() {
    if (!root) return;
    setLoadingDirs(new Set());
    setDirErrors({});
    const expandedPaths = Array.from(expanded);
    try {
      const [next, _git, refreshedChildren] = await Promise.all([
        invoke<TreeEntry[]>("list_dir", { workspaceRoot: root, path: root }),
        refreshGitStatus(root),
        Promise.all(
          expandedPaths.map(async (path) => {
            try {
              return [path, await invoke<TreeEntry[]>("list_dir", { workspaceRoot: root, path })] as const;
            } catch {
              return null;
            }
          })
        ),
      ]);
      setEntries(next);
      setGitFiles(_git);
      setChildren(
        Object.fromEntries(
          refreshedChildren.filter(
            (entry): entry is readonly [string, TreeEntry[]] => entry !== null
          )
        )
      );
    } catch (e) {
      console.error("Unable to load workspace root:", e);
      setEntries([]);
    }
  }

  useEffect(() => {
    if (!root) {
      setEntries([]);
      setChildren({});
      setExpanded(new Set());
      setGitFiles([]);
      return;
    }

    const nextExpanded = loadExpanded(root);
    setExpanded(nextExpanded);
    setChildren({});
    void refreshTree();
  }, [root]);

  useEffect(() => {
    if (!root) return;
    localStorage.setItem(
      expandedStoreKey(root),
      JSON.stringify(Array.from(expanded))
    );
  }, [root, expanded]);

  useEffect(() => {
    if (!root) return;
    let cancelled = false;

    const refresh = async () => {
      try {
        const [next] = await Promise.all([
          invoke<TreeEntry[]>("list_dir", { workspaceRoot: root, path: root }),
          refreshGitStatus(root),
        ]);
        const expandedPaths = Array.from(expanded);
        const refreshedChildren = await Promise.all(
          expandedPaths.map(async (path) => {
            try {
              return [path, await invoke<TreeEntry[]>("list_dir", { workspaceRoot: root, path })] as const;
            } catch {
              return null;
            }
          })
        );
        if (!cancelled) {
          setEntries(next);
          setChildren((cur) => ({
            ...cur,
            ...Object.fromEntries(
              refreshedChildren.filter(
                (entry): entry is readonly [string, TreeEntry[]] => entry !== null
              )
            ),
          }));
        }
      } catch (e) {
        console.error("readDir failed during periodic refresh:", e);
      }
    };

    const interval = window.setInterval(refresh, 3_000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [root, expanded]);

  async function pick(path: string) {
    try {
      const content = await invoke<string>("read_text_file", { workspaceRoot: root, path });
      onOpen(path, content);
    } catch (e) {
      console.error("Failed to open file:", e);
    }
  }

  async function toggleFolder(path: string, isVirtualFolder = false) {
    const next = new Set(expanded);
    if (next.has(path)) {
      next.delete(path);
      setExpanded(next);
      return;
    }

    next.add(path);
    setExpanded(next);
    if (isVirtualFolder) {
      setChildren((cur) => ({ ...cur, [path]: cur[path] ?? [] }));
      return;
    }
    if (!(path in children) || dirErrors[path]) {
      setLoadingDirs((cur) => new Set(cur).add(path));
      setDirErrors((cur) => {
        const { [path]: _removed, ...rest } = cur;
        return rest;
      });
      try {
        const nextChildren = await invoke<TreeEntry[]>("list_dir", { workspaceRoot: root, path });
        setChildren((cur) => ({ ...cur, [path]: nextChildren }));
        setDirErrors((cur) => {
          const { [path]: _removed, ...rest } = cur;
          return rest;
        });
      } catch (e) {
        console.error("readDir failed:", e);
        setDirErrors((cur) => ({
          ...cur,
          [path]: e instanceof Error ? e.message : String(e),
        }));
      } finally {
        setLoadingDirs((cur) => {
          const next = new Set(cur);
          next.delete(path);
          return next;
        });
      }
    }
  }

  function startCreate(parent: string, isDirectory: boolean) {
    // Make sure the target folder is open so the input row is visible.
    if (parent !== root && !expanded.has(parent)) void toggleFolder(parent);
    setEditing({ mode: "create", parent, isDirectory });
  }

  async function commitCreate(parent: string, rawName: string, isDirectory: boolean) {
    setEditing(null);
    const name = rawName.trim();
    if (!name || name.includes("/") || !root) return;
    const target = joinPath(parent, name);
    try {
      // Rust-side command: existence check + workspace-root guard included.
      await invoke("create_entry", {
        workspaceRoot: root,
        path: target,
        isDirectory,
      });
      // Optimistically add the node; the periodic refresh will reconcile later.
      const newEntry: TreeEntry = { name, isDirectory };
      if (parent === root) {
        setEntries((cur) =>
          cur.some((e) => e.name === name) ? cur : [...cur, newEntry]
        );
      } else {
        setChildren((cur) => {
          const list = cur[parent];
          if (!list || list.some((e) => e.name === name)) return cur;
          return { ...cur, [parent]: [...list, newEntry] };
        });
      }
      if (!isDirectory) pick(target); // open the fresh file right away
    } catch (e) {
      reportFsError("Create failed", e);
    }
  }

  async function commitRename(path: string, rawName: string) {
    setEditing(null);
    const name = rawName.trim();
    if (!name || name.includes("/") || !root) return;
    // Note: parentPath() is for git-relative paths and drops the leading
    // slash, so compute the absolute parent directly here.
    const target = `${path.slice(0, path.lastIndexOf("/"))}/${name}`;
    if (target === path) return;
    try {
      await invoke("rename_entry", { workspaceRoot: root, from: path, to: target });
      // Optimistically rename the node in local state. Re-key any loaded child
      // listings that lived under the old path so expanded folders survive it.
      const parent = path.slice(0, path.lastIndexOf("/"));
      const oldName = path.split("/").pop() ?? path;
      if (parent === root) {
        setEntries((cur) =>
          cur.map((e) => (e.name === oldName ? { ...e, name } : e))
        );
      }
      setChildren((cur) => {
        const next: Record<string, TreeEntry[]> = {};
        for (const [dir, list] of Object.entries(cur)) {
          const key =
            dir === path
              ? target
              : dir.startsWith(`${path}/`)
                ? target + dir.slice(path.length)
                : dir;
          next[key] =
            dir === parent
              ? list.map((e) => (e.name === oldName ? { ...e, name } : e))
              : list;
        }
        return next;
      });
      // Keep renamed folders (and anything expanded inside them) open.
      setExpanded((cur) => {
        const next = new Set<string>();
        for (const p of cur) {
          if (p === path) next.add(target);
          else if (p.startsWith(`${path}/`)) next.add(target + p.slice(path.length));
          else next.add(p);
        }
        return next;
      });
      onEntryRenamed?.(path, target);
    } catch (e) {
      reportFsError("Rename failed", e);
    }
  }

  async function deleteEntry(path: string, isDirectory: boolean) {
    if (!root) return;
    const name = path.split("/").pop() ?? path;
    const ok = await confirm(
      isDirectory
        ? `Delete folder "${name}" and all its contents?`
        : `Delete "${name}"?`,
      { title: "Delete", kind: "warning" }
    );
    if (!ok) return;
    try {
      await invoke("delete_entry", { workspaceRoot: root, path });
      // Optimistically prune the tree; the periodic refresh will reconcile
      // later. Splice the node out of local state the way commitRename does.
      const parent = path.slice(0, path.lastIndexOf("/"));
      if (parent === root) {
        setEntries((cur) => cur.filter((e) => joinPath(root, e.name) !== path));
      }
      setChildren((cur) => {
        const next: Record<string, TreeEntry[]> = {};
        for (const [dir, list] of Object.entries(cur)) {
          // Drop any loaded listings for the deleted folder and its descendants.
          if (dir === path || dir.startsWith(`${path}/`)) continue;
          // Remove the deleted node from its parent's listing.
          next[dir] =
            dir === parent
              ? list.filter((e) => joinPath(dir, e.name) !== path)
              : list;
        }
        return next;
      });
      // Drop stale expanded entries so they don't linger in localStorage.
      setExpanded(
        (cur) =>
          new Set(
            Array.from(cur).filter((p) => p !== path && !p.startsWith(`${path}/`))
          )
      );
      onEntryDeleted?.(path);
    } catch (e) {
      reportFsError("Delete failed", e);
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard
      .writeText(text)
      .catch((e) => reportFsError("Copy failed", e));
  }

  function menuItems(target: MenuTarget): MenuItem[] {
    const { path, isDirectory } = target;
    const isRoot = path === root;
    const items: MenuItem[] = [];

    if (isDirectory) {
      items.push(
        { type: "item", label: "New File…", onSelect: () => startCreate(path, false) },
        { type: "item", label: "New Folder…", onSelect: () => startCreate(path, true) },
        { type: "separator" }
      );
    }

    items.push({ type: "item", label: "Copy Path", onSelect: () => copyToClipboard(path) });
    if (root && !isRoot) {
      items.push({
        type: "item",
        label: "Copy Relative Path",
        onSelect: () => copyToClipboard(relativePath(root, path)),
      });
    }
    items.push({
      type: "item",
      label: "Reveal in Finder",
      onSelect: () => {
        invoke("reveal_entry", { path }).catch((e) =>
          reportFsError("Reveal failed", e)
        );
      },
    });

    if (!isDirectory && onFilePreview) {
      items.push({
        type: "item",
        label: "Quick View",
        onSelect: () => onFilePreview(path),
      });
    }

    if (!isRoot) {
      items.push(
        { type: "separator" },
        {
          type: "item",
          label: "Rename…",
          onSelect: () => setEditing({ mode: "rename", path }),
        },
        {
          type: "item",
          label: "Delete",
          danger: true,
          onSelect: () => void deleteEntry(path, isDirectory),
        }
      );
    }

    return items;
  }

  function renderEntries(list: TreeEntry[], basePath: string, depth = 0) {
    const existingNames = new Set(list.map((entry) => entry.name));
    let mergedEntries =
      root == null
        ? list
        : [
            ...list,
            ...gitVirtualEntries(root, basePath, existingNames, gitFiles),
          ];
    if (!showHidden) {
      mergedEntries = mergedEntries.filter((e) => !e.name.startsWith("."));
    }

    // Indent per depth. The grid is fixed (chevron + icon + name +
    // decoration), and the *whole row* is offset by `depth` levels
    // via padding-left. Linear's tree does it this way too.
    const indent = 8 + depth * 14;

    // Input row for "New File…" / "New Folder…" targeting this folder.
    const createRow =
      editing?.mode === "create" && editing.parent === basePath ? (
        <li key="__create__">
          <div
            className="klide-explorer-row"
            data-editing="true"
            style={{ paddingLeft: indent, gridTemplateColumns: `16px 16px 1fr` }}
          >
            <span className="klide-explorer-chevron" />
            <span className="klide-explorer-icon">
              {editing.isDirectory ? <FolderRow open={false} /> : <FileRow name="" />}
            </span>
            <InlineNameInput
              defaultValue=""
              onCommit={(name) => void commitCreate(basePath, name, editing.isDirectory)}
              onCancel={() => setEditing(null)}
            />
          </div>
        </li>
      ) : null;

    const rows = mergedEntries
      .slice()
      .sort(
        (a, b) =>
          Number(b.isDirectory) - Number(a.isDirectory) ||
          a.name.localeCompare(b.name)
      )
      .map((e) => {
        const isDir = e.isDirectory;
        const isVirtual = e.virtual === true;
        const path = joinPath(basePath, e.name);
        const isExpanded = expanded.has(path);
        const nested = children[path];
        const isLoading = loadingDirs.has(path);
        const error = dirErrors[path];
        const decoration = root
          ? gitDecoration(root, path, isDir, gitFiles)
          : null;
        const isActive = activePath != null && path === activePath;
        return (
          <li key={path}>
            <div
              className="klide-explorer-row"
              role="treeitem"
              tabIndex={-1}
              aria-level={depth + 1}
              aria-expanded={isDir ? isExpanded : undefined}
              aria-selected={isActive}
              data-nav="true"
              data-active={isActive}
              data-virtual={isVirtual}
              data-dir={isDir}
              data-expanded={isDir ? isExpanded : undefined}
              onClick={() => {
                if (isDir) toggleFolder(path, isVirtual);
                else if (!isVirtual) pick(path);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (isVirtual) return; // deleted-file ghosts have no disk entry
                setMenu({ x: event.clientX, y: event.clientY, path, isDirectory: isDir });
              }}
              style={{
                paddingLeft: indent,
                color: decoration ? decoration.color : isDir ? "var(--fg)" : "var(--fg-strong)",
                cursor: isVirtual && !isDir ? "default" : "pointer",
              }}
            >
              <span className="klide-explorer-chevron" data-open={isExpanded}>
                {isDir ? <ChevronRight /> : null}
              </span>
              <span className="klide-explorer-icon">
                {isDir ? <FolderRow open={isExpanded} /> : <FileRow name={e.name} />}
              </span>
              {editing?.mode === "rename" && editing.path === path ? (
                <InlineNameInput
                  defaultValue={e.name}
                  onCommit={(name) => void commitRename(path, name)}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <span className="klide-explorer-name">{e.name}</span>
              )}
              {decoration && (
                <span
                  className="klide-explorer-decoration"
                  style={{ color: decoration.color }}
                >
                  {decoration.label}
                </span>
              )}
            </div>
            {isDir && isExpanded && (
              <ul
                role="group"
                // Indent guide x-position: this folder's chevron centre
                // (row padding 8 + depth*14, chevron column is 16px wide).
                style={{ "--guide-x": `${16 + depth * 14}px` } as CSSProperties}
              >
                {isLoading ? (
                  <li>
                    <div
                      className="klide-explorer-row"
                      style={{ paddingLeft: indent + 22, cursor: "default" }}
                    >
                      <span className="klide-explorer-chevron" />
                      <span className="klide-explorer-icon" />
                      <span
                        className="klide-explorer-name"
                        style={{ color: "var(--fg-dim)", fontStyle: "italic" }}
                      >
                        Loading…
                      </span>
                    </div>
                  </li>
                ) : error ? (
                  <li>
                    <div
                      className="klide-explorer-row"
                      data-clickable="true"
                      onClick={async (event) => {
                        event.stopPropagation();
                        setLoadingDirs((cur) => new Set(cur).add(path));
                        try {
                          const nextChildren = await invoke<TreeEntry[]>("list_dir", { workspaceRoot: root, path });
                          setChildren((cur) => ({ ...cur, [path]: nextChildren }));
                          setDirErrors((cur) => {
                            const { [path]: _removed, ...rest } = cur;
                            return rest;
                          });
                        } finally {
                          setLoadingDirs((cur) => {
                            const next = new Set(cur);
                            next.delete(path);
                            return next;
                          });
                        }
                      }}
                      style={{ paddingLeft: indent + 22, color: "var(--fg-dim)", cursor: "pointer" }}
                    >
                      <span className="klide-explorer-chevron" />
                      <span className="klide-explorer-icon" />
                      <span className="klide-explorer-name" style={{ color: "var(--fg-dim)" }}>
                        Retry folder
                      </span>
                    </div>
                  </li>
                ) : nested &&
                  (nested.length > 0 ||
                    (editing?.mode === "create" && editing.parent === path)) ? (
                  renderEntries(nested, path, depth + 1)
                ) : (
                  <li>
                    <div
                      className="klide-explorer-row"
                      style={{ paddingLeft: indent + 22, cursor: "default" }}
                    >
                      <span className="klide-explorer-chevron" />
                      <span className="klide-explorer-icon" />
                      <span className="klide-explorer-name" style={{ color: "var(--fg-dim)" }}>
                        Empty
                      </span>
                    </div>
                  </li>
                )}
              </ul>
            )}
          </li>
        );
      });

    return createRow ? [createRow, ...rows] : rows;
  }

  return (
    <aside
      className="floating-panel"
      onContextMenu={(event) => {
        // Right-click on empty space targets the workspace root.
        if (!root) return;
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY, path: root, isDirectory: true });
      }}
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
      {/* Header — the panel name stays stable while the full workspace path
          remains available in the native title. At-rest: section name on
          the left, creation + refresh + kebab on the right. The
          bottom edge is a gradient hairline + a 1px inset highlight for
          depth (no flat 1px line). No path is rendered; native title
          reveals it. */}
      <header className="klide-explorer-header">
        {root ? (
          <div className="klide-explorer-header-workspace" title={root}>
            <span className="klide-explorer-header-workspace-name">
              {root.split("/").filter(Boolean).pop() ?? "Explorer"}
            </span>
          </div>
        ) : (
          <div className="klide-explorer-header-workspace" data-empty="true" />
        )}
        <div className="klide-explorer-header-actions">
          {root && (
            <>
              <button
                onClick={() => root && startCreate(root, false)}
                title="New file"
                aria-label="New file"
                className="klide-explorer-action"
              >
                <FilePlusIcon />
              </button>
              <button
                onClick={() => root && startCreate(root, true)}
                title="New folder"
                aria-label="New folder"
                className="klide-explorer-action"
              >
                <FolderPlusIcon />
              </button>
              <button
                onClick={() => root && refreshGitStatus(root).then(refreshTree)}
                title="Refresh"
                aria-label="Refresh"
                className="klide-explorer-action"
              >
                <RefreshIcon />
              </button>
              <button
                onClick={() => root && setMenu({ x: 200, y: 60, path: root, isDirectory: true })}
                title="More"
                aria-label="More"
                className="klide-explorer-action"
              >
                <KebabIcon />
              </button>
            </>
          )}
          {!root && (
            <button
              onClick={pickFolder}
              title="Open folder…"
              aria-label="Open folder"
              className="klide-explorer-action"
            >
              <FolderOpenSmall />
            </button>
          )}
        </div>
      </header>

      {fsNotice && (
        <div
          onClick={() => setFsNotice(null)}
          title="Click to dismiss"
          className="klide-explorer-notice"
        >
          {fsNotice}
        </div>
      )}

      {!root && (
        <div className="klide-explorer-message">
          <div className="klide-explorer-message" data-kind="title" style={{ marginTop: 14 }}>
            No workspace open
          </div>
          <div style={{ padding: "0 14px 8px" }}>
            Open a folder to browse files, edit code, and enable agent mode.
          </div>
          <button
            onClick={pickFolder}
            className="klide-button klide-button-primary"
            style={{ margin: "8px 14px 0", minHeight: 30, padding: "0 12px", fontSize: 12 }}
          >
            Open Folder…
          </button>
        </div>
      )}

      {/* Tree container — the flex: 1 + min-height: 0 combo means the
          <ul> inside fills the rest of the panel, with overflow:auto
          so it scrolls. Without min-height: 0, the natural content
          height would force the panel to grow past the workbench. */}
      {root && (
        <div
          ref={treeRef}
          className="klide-explorer-tree"
          role="tree"
          aria-label="Files"
          tabIndex={0}
          onFocus={handleTreeFocus}
          onKeyDown={handleTreeKeyDown}
        >
          {entries.length === 0 && !(editing?.mode === "create" && editing.parent === root) ? (
            <div className="klide-explorer-message" style={{ marginTop: 14 }}>
              This folder is empty.
            </div>
          ) : (
            <ul role="none">{renderEntries(entries, root)}</ul>
          )}
        </div>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu)}
          onClose={() => setMenu(null)}
        />
      )}
    </aside>
  );
}
