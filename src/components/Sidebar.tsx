import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { watch } from "@tauri-apps/plugin-fs";
import { useEffect, useState } from "react";

type Props = {
  onOpen: (path: string, content: string) => void;
  onRootChange: (root: string | null) => void;
  onOpenGitDiff?: (path: string, staged: boolean) => void;
  visible: boolean;
  width: number;
  workspaceRoot: string | null;
  fill?: boolean;
};

type TreeEntry = {
  name: string;
  isDirectory: boolean;
  virtual?: boolean;
};

type GitFile = {
  path: string;
  status: string;
  staged: boolean;
};

type GitStatus = {
  branch: string;
  files: GitFile[];
};

type GitDecoration = {
  label: string;
  color: string;
  title: string;
};

function ChevronRight() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function FolderRow({ open }: { open: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#D9A441" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <path
        fill="none"
        d="M3 7.5C3 6.4 3.9 5.5 5 5.5h3.5l2 2H19c1.1 0 2 .9 2 2v7c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2v-9z"
      />
      {open && <path d="M3.5 10h17" opacity="0.45" />}
    </svg>
  );
}

function FileRow({ name }: { name: string }) {
  const lower = name.toLowerCase();
  const ext = lower.split(".").pop() ?? "";
  const kind =
    lower === "package.json"
      ? "npm"
      : lower.startsWith(".git")
      ? "git"
      : lower === "cargo.toml" || lower === "cargo.lock"
      ? "rust"
      : ext;

  if (kind === "py") {
    return (
      <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="#3776AB" d="M12.1 2.5c-3.9 0-4.7 1.7-4.7 3.8v2.1h4.8v.8H5.6c-2.1 0-3.9 1.2-4.5 3.6-.7 2.8-.7 4.5 0 7.3.5 2.1 1.8 3.6 3.9 3.6h1.8v-2.5c0-2.4 2.1-4.5 4.5-4.5h4.7c2 0 3.6-1.6 3.6-3.6V6.3c0-2-1.7-3.5-3.6-3.8-1.2-.2-2.6-.3-3.9 0z" transform="scale(.82) translate(1.8 1.4)" />
        <path fill="#FFD43B" d="M12 21.5c3.9 0 4.7-1.7 4.7-3.8v-2.1h-4.8v-.8h6.6c2.1 0 3.9-1.2 4.5-3.6.7-2.8.7-4.5 0-7.3-.5-2.1-1.8-3.6-3.9-3.6h-1.8v2.5c0 2.4-2.1 4.5-4.5 4.5H8.1c-2 0-3.6 1.6-3.6 3.6v6.8c0 2 1.7 3.5 3.6 3.8 1.2.2 2.6.3 3.9 0z" transform="scale(.82) translate(1.8 1.4)" />
      </svg>
    );
  }

  if (kind === "tsx" || kind === "jsx") {
    return (
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#61DAFB" strokeWidth="1.5" aria-hidden="true">
        <circle cx="12" cy="12" r="1.9" fill="#61DAFB" stroke="none" />
        <ellipse cx="12" cy="12" rx="9" ry="3.8" />
        <ellipse cx="12" cy="12" rx="9" ry="3.8" transform="rotate(60 12 12)" />
        <ellipse cx="12" cy="12" rx="9" ry="3.8" transform="rotate(120 12 12)" />
      </svg>
    );
  }

  if (kind === "html" || kind === "css") {
    const color = kind === "html" ? "#E34F26" : "#1572B6";
    const text = kind === "html" ? "5" : "3";
    return (
      <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
        <path fill={color} d="M4 2h16l-1.4 17.1L12 22l-6.6-2.9L4 2z" />
        <text x="12" y="15.5" textAnchor="middle" fontSize="9" fontWeight="800" fill="#fff">{text}</text>
      </svg>
    );
  }

  if (kind === "git") {
    return (
      <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="#F05032" d="M10.8 2.8a1.7 1.7 0 0 1 2.4 0l8 8a1.7 1.7 0 0 1 0 2.4l-8 8a1.7 1.7 0 0 1-2.4 0l-8-8a1.7 1.7 0 0 1 0-2.4l8-8z" />
        <path stroke="#fff" strokeWidth="1.4" strokeLinecap="round" fill="none" d="M8 8.2l4 4m0 0v4.3m0-4.3h4" />
        <circle cx="8" cy="8.2" r="1.35" fill="#fff" />
        <circle cx="12" cy="12.2" r="1.35" fill="#fff" />
        <circle cx="16" cy="12.2" r="1.35" fill="#fff" />
      </svg>
    );
  }

  const logo: Record<string, { bg: string; fg: string; text: string }> = {
    ts: { bg: "#3178C6", fg: "#FFFFFF", text: "TS" },
    js: { bg: "#F7DF1E", fg: "#252525", text: "JS" },
    json: { bg: "#F0B429", fg: "#FFFFFF", text: "{}" },
    rust: { bg: "#DEA584", fg: "#2B1A12", text: "Rs" },
    rs: { bg: "#DEA584", fg: "#2B1A12", text: "Rs" },
    md: { bg: "#7C8A99", fg: "#FFFFFF", text: "M↓" },
    toml: { bg: "#9C6ADE", fg: "#FFFFFF", text: "T" },
    yml: { bg: "#CB4B16", fg: "#FFFFFF", text: "Y" },
    yaml: { bg: "#CB4B16", fg: "#FFFFFF", text: "Y" },
    lock: { bg: "#9AA0A6", fg: "#FFFFFF", text: "L" },
    npm: { bg: "#CB3837", fg: "#FFFFFF", text: "npm" },
  };
  const meta = logo[kind] ?? { bg: "transparent", fg: "var(--fg-dim)", text: "◇" };
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="4.5" fill={meta.bg} stroke={meta.bg === "transparent" ? "var(--border-strong)" : "none"} />
      <text x="12" y="15.2" textAnchor="middle" fontSize={meta.text.length > 2 ? "6.2" : "8"} fontWeight="800" fill={meta.fg}>{meta.text}</text>
    </svg>
  );
}

function joinPath(root: string, name: string): string {
  return `${root.replace(/\/$/, "")}/${name}`;
}

function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 2) return path;
  return `.../${parts.slice(-2).join("/")}`;
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
    return { label, color: "#D99A2B", title: "Modified" };
  }
  if (label === "A" || label === "U") {
    return {
      label,
      color: "#2F9E44",
      title: label === "U" ? "Untracked" : "Added",
    };
  }
  if (label === "D") {
    return { label, color: "#D64545", title: "Deleted" };
  }
  if (label === "R") {
    return { label, color: "#9B7DFF", title: "Renamed" };
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

function gitFileForPath(
  root: string,
  path: string,
  isDirectory: boolean,
  gitFiles: GitFile[]
): GitFile | null {
  const rel = relativePath(root, path);
  const exact = gitFiles.find((file) => file.path.replace(/\/$/, "") === rel);
  if (exact) return exact;
  if (isDirectory) return null;
  return (
    gitFiles.find(
      (file) => file.status === "??" && file.path.endsWith("/") && rel.startsWith(file.path)
    ) ?? null
  );
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

export function Sidebar({
  onOpen,
  onRootChange,
  onOpenGitDiff,
  visible,
  width,
  workspaceRoot,
  fill,
}: Props) {
  const root = workspaceRoot;
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [children, setChildren] = useState<Record<string, TreeEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => loadExpanded(root));
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [dirErrors, setDirErrors] = useState<Record<string, string>>({});
  const [gitFiles, setGitFiles] = useState<GitFile[]>([]);

  async function refreshGitStatus(workspaceRoot: string) {
    try {
      const status = await invoke<GitStatus>("git_status", { workspaceRoot });
      setGitFiles(status.files);
    } catch {
      setGitFiles([]);
    }
  }

  async function pickFolder() {
    const picked = await open({ directory: true });
    if (typeof picked !== "string") return;
    setEntries(await invoke<TreeEntry[]>("list_dir", { path: picked }));
    setChildren({});
    setExpanded(loadExpanded(picked));
    setLoadingDirs(new Set());
    setDirErrors({});
    refreshGitStatus(picked);
    onRootChange(picked);
  }

  useEffect(() => {
    if (!root) {
      setEntries([]);
      setChildren({});
      setExpanded(new Set());
      setGitFiles([]);
      return;
    }

    let cancelled = false;
    const nextExpanded = loadExpanded(root);
    setExpanded(nextExpanded);
    setChildren({});
    setLoadingDirs(new Set());
    setDirErrors({});

    const expandedPaths = Array.from(nextExpanded);
    Promise.all([
      invoke<TreeEntry[]>("list_dir", { path: root }),
      refreshGitStatus(root),
      Promise.all(
        expandedPaths.map(async (path) => {
          try {
            return [path, await invoke<TreeEntry[]>("list_dir", { path })] as const;
          } catch {
            return null;
          }
        })
      ),
    ])
      .then(([next, _git, refreshedChildren]) => {
        if (!cancelled) {
          setEntries(next);
          setChildren(
            Object.fromEntries(
              refreshedChildren.filter(
                (entry): entry is readonly [string, TreeEntry[]] => entry !== null
              )
            )
          );
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setEntries([]);
          console.error("Unable to load workspace root:", e);
        }
      });

    return () => {
      cancelled = true;
    };
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
    let unwatch: (() => void) | undefined;
    let cancelled = false;

    const refresh = async () => {
      try {
        const [next] = await Promise.all([
          invoke<TreeEntry[]>("list_dir", { path: root }),
          refreshGitStatus(root),
        ]);
        const expandedPaths = Array.from(expanded);
        const refreshedChildren = await Promise.all(
          expandedPaths.map(async (path) => {
            try {
              return [path, await invoke<TreeEntry[]>("list_dir", { path })] as const;
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
        console.error("readDir failed during watch refresh:", e);
      }
    };

    watch(root, refresh, { recursive: true, delayMs: 100 })
      .then((un) => {
        if (cancelled) un();
        else unwatch = un;
      })
      .catch((e) => console.error("fs.watch failed:", e));

    return () => {
      cancelled = true;
      unwatch?.();
    };
  }, [root, expanded]);

  async function pick(path: string) {
    try {
      const content = await invoke<string>("read_text_file", { path });
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
        const nextChildren = await invoke<TreeEntry[]>("list_dir", { path });
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

  function renderEntries(list: TreeEntry[], basePath: string, depth = 0) {
    const existingNames = new Set(list.map((entry) => entry.name));
    const mergedEntries =
      root == null
        ? list
        : [
            ...list,
            ...gitVirtualEntries(root, basePath, existingNames, gitFiles),
          ];

    return mergedEntries
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
        const gitFile = root ? gitFileForPath(root, path, isDir, gitFiles) : null;
        const rowColor = decoration
          ? decoration.color
          : isDir
          ? "var(--fg)"
          : "var(--fg-strong)";
        return (
          <li key={path}>
            <div
              onClick={() => {
                if (isDir) toggleFolder(path, isVirtual);
                else if (isVirtual && gitFile) onOpenGitDiff?.(gitFile.path, gitFile.staged);
                else if (!isVirtual) pick(path);
              }}
              title={decoration ? `${path} · ${decoration.title}` : path}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "3px 8px",
                paddingLeft: 8 + depth * 14,
                borderRadius: "var(--radius-sm)",
                color: rowColor,
                cursor: isVirtual && !isDir ? "default" : "pointer",
                opacity: isVirtual ? 0.86 : 1,
                fontSize: 13,
                userSelect: "none",
                transition:
                  "background var(--motion-med) var(--ease-out), color var(--motion-med) var(--ease-out), transform var(--motion-fast) var(--ease-out)",
                minWidth: 0,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
            >
              <span
                style={{
                  display: "inline-flex",
                  width: 12,
                  color: "var(--fg-subtle)",
                  transform: isExpanded ? "rotate(90deg)" : "none",
                  transition: "transform var(--motion-med) var(--ease-soft)",
                  flexShrink: 0,
                }}
              >
                {isDir ? <ChevronRight /> : null}
              </span>
              <span
                style={{
                  display: "inline-flex",
                  color: "var(--fg-subtle)",
                  flexShrink: 0,
                }}
              >
                {isDir ? <FolderRow open={isExpanded} /> : <FileRow name={e.name} />}
              </span>
              <span
                style={{
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  minWidth: 0,
                }}
              >
                {e.name}
              </span>
              {decoration && (
                <span
                  title={decoration.title}
                  onClick={(event) => {
                    if (!gitFile || isDir) return;
                    event.stopPropagation();
                    onOpenGitDiff?.(gitFile.path, gitFile.staged);
                  }}
                  style={{
                    marginLeft: "auto",
                    flexShrink: 0,
                    minWidth: 14,
                    height: 16,
                    display: "grid",
                    placeItems: "center",
                    color: decoration.color,
                    cursor: gitFile && !isDir ? "pointer" : "default",
                    fontSize: 10,
                    fontWeight: 700,
                    lineHeight: 1,
                  }}
                >
                  {decoration.label}
                </span>
              )}
            </div>
            {isDir && isExpanded && (
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {isLoading ? (
                  <li
                    style={{
                      padding: "3px 8px",
                      paddingLeft: 36 + depth * 14,
                      color: "var(--fg-dim)",
                      fontSize: 12,
                    }}
                  >
                    Loading…
                  </li>
                ) : error ? (
                  <li
                    title={error}
                    onClick={async (event) => {
                      event.stopPropagation();
                      setLoadingDirs((cur) => new Set(cur).add(path));
                      try {
                        const nextChildren = await invoke<TreeEntry[]>("list_dir", { path });
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
                    style={{
                      padding: "3px 8px",
                      paddingLeft: 36 + depth * 14,
                      color: "var(--fg-dim)",
                      fontSize: 12,
                      cursor: "pointer",
                    }}
                  >
                    Retry folder
                  </li>
                ) : nested && nested.length > 0 ? (
                  renderEntries(nested, path, depth + 1)
                ) : (
                  <li
                    style={{
                      padding: "3px 8px",
                      paddingLeft: 36 + depth * 14,
                      color: "var(--fg-dim)",
                      fontSize: 12,
                    }}
                  >
                    Empty
                  </li>
                )}
              </ul>
            )}
          </li>
        );
      });
  }

  return (
    <aside
      className="floating-panel"
      style={{
        width: fill ? "100%" : width,
        height: fill ? "100%" : undefined,
        margin: fill ? 0 : "4px 0 4px 4px",
        overflow: "auto",
        display: fill || visible ? "flex" : "none",
        flexDirection: "column",
        flexShrink: 0,
      }}
    >
      <header
        style={{
          padding: "10px 12px 8px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: 11,
          color: "var(--fg-subtle)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          fontWeight: 500,
        }}
      >
        <span>Explorer</span>
        <button
          onClick={pickFolder}
          title="Open folder…"
          style={{
            fontSize: 11,
            color: "var(--fg-subtle)",
            padding: "2px 6px",
            borderRadius: "var(--radius-sm)",
            transition:
              "color var(--motion-med) var(--ease-out), background var(--motion-med) var(--ease-out)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--fg-strong)";
            e.currentTarget.style.background = "var(--bg-hover)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "var(--fg-subtle)";
            e.currentTarget.style.background = "transparent";
          }}
        >
          Open…
        </button>
      </header>

      {root && (
        <div
          style={{
            padding: "0 12px 6px",
            display: "flex",
            flexDirection: "column",
            gap: 2,
            borderBottom: "1px solid var(--border)",
            marginBottom: 4,
            paddingBottom: 8,
          }}
        >
          <span
            style={{
              fontSize: 12,
              color: "var(--fg-strong)",
              fontWeight: 500,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            title={root}
          >
            {root.split("/").pop()}
          </span>
          <span
            style={{
              fontSize: 11,
              color: "var(--fg-subtle)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            title={root}
          >
            {shortPath(root)}
          </span>
        </div>
      )}

      {!root && (
        <div
          style={{
            padding: "18px 14px",
            color: "var(--fg-subtle)",
            fontSize: 13,
            lineHeight: 1.55,
          }}
        >
          <div style={{ color: "var(--fg)", marginBottom: 6 }}>No workspace open</div>
          <div>Open a folder to browse files, edit code, and enable agent mode.</div>
        </div>
      )}

      {root && entries.length === 0 && (
        <div
          style={{
            padding: "18px 14px",
            color: "var(--fg-subtle)",
            fontSize: 13,
          }}
        >
          This folder is empty.
        </div>
      )}

      {root && entries.length > 0 && (
        <ul style={{ listStyle: "none", padding: "4px 4px 8px", margin: 0 }}>
          {renderEntries(entries, root)}
        </ul>
      )}
    </aside>
  );
}
