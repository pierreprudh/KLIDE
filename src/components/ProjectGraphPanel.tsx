import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import type { ProjectContextItem, ProjectContextSnapshot } from "../contextTray";

type Props = {
  visible: boolean;
  width: number;
  workspaceRoot: string | null;
  fill?: boolean;
  activePath?: string | null;
  onContextChange?: (snapshot: ProjectContextSnapshot | null) => void;
};

type ProjectGraphFile = {
  path: string;
  status: string;
  changed: boolean;
  additions: number;
  deletions: number;
};

type ProjectGraph = {
  root_name: string;
  branch: string;
  total_files: number;
  changed_files: number;
  additions: number;
  deletions: number;
  files: ProjectGraphFile[];
};

type MemoryKind = "folder" | "file";
type MemoryNode = {
  id: string;
  name: string;
  path: string;
  kind: MemoryKind;
  files: ProjectGraphFile[];
  children: MemoryNode[];
  changedCount: number;
};

const IGNORED_DIRS = new Set(["node_modules", "target", "dist", "build", ".git"]);

function storageKey(workspaceRoot: string, path: string) {
  return `klide.memory.${workspaceRoot}.${path || "."}`;
}

function filename(path: string) {
  return path.split("/").pop() ?? path;
}

function dirname(path: string) {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

function ext(path: string) {
  const name = filename(path);
  const idx = name.lastIndexOf(".");
  return idx === -1 ? "" : name.slice(idx + 1).toLowerCase();
}

function describeNode(node: MemoryNode) {
  if (node.path === "src") return "Frontend application code and React UI surfaces.";
  if (node.path === "src-tauri") return "Rust/Tauri backend commands, PTY, filesystem, git, and provider bridges.";
  if (node.path.startsWith("src/components")) return "Reusable UI panels and workbench surfaces.";
  if (node.path.startsWith("src-tauri/src")) return "Native backend implementation exposed to the webview.";
  if (node.path === "public") return "Static assets shipped with the app.";
  if (node.path === ".github") return "Repository automation and CI configuration.";
  if (node.kind === "file") {
    const e = ext(node.path);
    if (e === "tsx" || e === "ts") return "TypeScript source. Check imports, props, and UI state coupling.";
    if (e === "rs") return "Rust source. Check Tauri command shape and frontend invoke callers.";
    if (e === "md") return "Project documentation or working notes.";
  }
  return node.kind === "folder"
    ? "Folder memory is empty. Add notes about responsibilities, conventions, and risks."
    : "File memory is empty. Add notes about behavior, dependencies, and safe edit rules.";
}

function buildMemoryTree(files: ProjectGraphFile[]): MemoryNode {
  const root: MemoryNode = {
    id: ".",
    name: "Project",
    path: "",
    kind: "folder",
    files: [],
    children: [],
    changedCount: 0,
  };
  const folders = new Map<string, MemoryNode>([["", root]]);

  function ensureFolder(path: string): MemoryNode {
    if (folders.has(path)) return folders.get(path)!;
    const parentPath = dirname(path);
    const parent = ensureFolder(parentPath);
    const node: MemoryNode = {
      id: `folder:${path}`,
      name: filename(path),
      path,
      kind: "folder",
      files: [],
      children: [],
      changedCount: 0,
    };
    folders.set(path, node);
    parent.children.push(node);
    return node;
  }

  for (const file of files) {
    if (file.path.split("/").some((part) => IGNORED_DIRS.has(part))) continue;
    const folder = ensureFolder(dirname(file.path));
    const node: MemoryNode = {
      id: `file:${file.path}`,
      name: filename(file.path),
      path: file.path,
      kind: "file",
      files: [file],
      children: [],
      changedCount: file.changed ? 1 : 0,
    };
    folder.children.push(node);
    let cur: MemoryNode | undefined = folder;
    while (cur) {
      cur.files.push(file);
      if (file.changed) cur.changedCount += 1;
      cur = cur.path ? folders.get(dirname(cur.path)) : undefined;
    }
  }

  for (const folder of folders.values()) {
    folder.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      return b.changedCount - a.changedCount || a.name.localeCompare(b.name);
    });
  }

  return root;
}

function flattenFolders(node: MemoryNode): MemoryNode[] {
  return [
    node,
    ...node.children
      .filter((child) => child.kind === "folder")
      .flatMap((child) => flattenFolders(child)),
  ];
}

function relatedNodes(node: MemoryNode, root: MemoryNode): MemoryNode[] {
  const allFolders = flattenFolders(root);
  if (node.kind === "folder") {
    return node.children
      .filter((child) => child.kind === "folder" || child.changedCount > 0)
      .slice(0, 6);
  }
  const folder = allFolders.find((candidate) => candidate.path === dirname(node.path));
  const sameExt = folder?.children.filter(
    (child) => child.kind === "file" && child.path !== node.path && ext(child.path) === ext(node.path)
  ) ?? [];
  return sameExt.slice(0, 6);
}

function changedFiles(node: MemoryNode) {
  return node.files.filter((file) => file.changed).slice(0, 8);
}

function findNode(root: MemoryNode, path: string): MemoryNode | null {
  const stack = [root];
  while (stack.length) {
    const next = stack.pop()!;
    if (next.path === path) return next;
    stack.push(...next.children);
  }
  return null;
}

function memoryItem(node: MemoryNode, label: string): ProjectContextItem {
  return {
    id: `${label}:${node.path || "."}`,
    path: node.path || ".",
    label,
    detail: [
      describeNode(node),
      `${node.files.length} files, ${node.changedCount} changed.`,
    ].join(" "),
  };
}

function parentNodes(node: MemoryNode, root: MemoryNode): MemoryNode[] {
  const out: MemoryNode[] = [];
  let path = dirname(node.path);
  while (path) {
    const parent = findNode(root, path);
    if (parent) out.push(parent);
    path = dirname(path);
  }
  return out;
}

function changedFolders(root: MemoryNode): MemoryNode[] {
  return flattenFolders(root)
    .filter((node) => node.path && node.changedCount > 0)
    .sort((a, b) => b.changedCount - a.changedCount || a.path.localeCompare(b.path))
    .slice(0, 6);
}

function flattenNodes(node: MemoryNode): MemoryNode[] {
  return [node, ...node.children.flatMap(flattenNodes)];
}

function uniqueContextItems(items: ProjectContextItem[]): ProjectContextItem[] {
  const seen = new Set<string>();
  const out: ProjectContextItem[] = [];
  for (const item of items) {
    if (seen.has(item.path)) continue;
    seen.add(item.path);
    out.push(item);
  }
  return out;
}

function contextSnapshot(selected: MemoryNode, root: MemoryNode, note: string): ProjectContextSnapshot {
  const related = relatedNodes(selected, root);
  const parents = parentNodes(selected, root);
  const cleanNote = note.trim().slice(0, 1200);
  const activity = changedFiles(selected).map((file): ProjectContextItem => ({
    id: `activity:${file.path}`,
    path: file.path,
    label: "recent movement",
    detail: `${file.status || "changed"} with +${file.additions} -${file.deletions}.`,
    weight: 3,
  }));
  const focused = [
    { ...memoryItem(selected, "current focus"), weight: 8 },
    ...(cleanNote
      ? [
          {
            id: `note:${selected.path || "."}`,
            path: selected.path || ".",
            label: "agent note",
            detail: cleanNote,
            weight: 7,
          },
        ]
      : []),
    ...parents.slice(0, 2).map((node) => ({ ...memoryItem(node, "parent scope"), weight: 4 })),
    ...related.slice(0, 2).map((node) => ({ ...memoryItem(node, "nearby relation"), weight: 3 })),
  ];
  const feature = [
    ...focused,
    ...related.slice(2, 6).map((node) => ({ ...memoryItem(node, "feature relation"), weight: 2 })),
    ...activity.slice(0, 3),
  ];
  const workspace = [
    memoryItem(root, "workspace map"),
    ...changedFolders(root).map((node) => ({ ...memoryItem(node, "active area"), weight: 4 })),
    ...feature,
  ];
  const changed = changedFiles(root).map((file): ProjectContextItem => ({
    id: `changed:${file.path}`,
    path: file.path,
    label: "changed file",
    detail: `${file.status || "changed"} with +${file.additions} -${file.deletions}.`,
    weight: 5,
  }));
  const nearbyFiles = selected.kind === "folder"
    ? selected.children.filter((child) => child.kind === "file").slice(0, 12)
    : findNode(root, dirname(selected.path))?.children.filter((child) => child.kind === "file").slice(0, 12) ?? [];
  const structural = flattenNodes(root)
    .filter((node) => node.path && (node.changedCount > 0 || node.path.startsWith("src") || node.path.startsWith("src-tauri")))
    .slice(0, 80)
    .map((node) => ({ ...memoryItem(node, node.kind === "folder" ? "project area" : "project file"), weight: node.changedCount > 0 ? 3 : 0 }));
  const lens = uniqueContextItems([
    ...focused,
    ...changed,
    ...nearbyFiles.map((node) => ({ ...memoryItem(node, "nearby file"), weight: 2 })),
    ...structural,
  ]);
  return {
    selectedPath: selected.path || ".",
    focused,
    feature,
    workspace,
    lens,
  };
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6v5h-5" />
      <path d="M4 18v-5h5" />
      <path d="M18.3 9A7 7 0 0 0 6.4 6.4L4 9" />
      <path d="M5.7 15A7 7 0 0 0 17.6 17.6L20 15" />
    </svg>
  );
}

function NodeIcon({ kind }: { kind: MemoryKind }) {
  if (kind === "folder") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 7.5C3 6.4 3.9 5.5 5 5.5h3.5l2 2H19c1.1 0 2 .9 2 2v7c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2v-9z" />
      </svg>
    );
  }
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 3.5h7l4 4V20H7z" />
      <path d="M14 3.5v4h4" />
    </svg>
  );
}

function MemoryTree({
  node,
  selectedPath,
  onSelect,
  depth = 0,
}: {
  node: MemoryNode;
  selectedPath: string;
  onSelect: (node: MemoryNode) => void;
  depth?: number;
}) {
  return (
    <div>
      {node.path !== "" && (
        <button
          type="button"
          onClick={() => onSelect(node)}
          title={node.path}
          style={{
            width: "100%",
            minHeight: 28,
            padding: "4px 7px",
            paddingLeft: 7 + depth * 12,
            borderRadius: "var(--radius-sm)",
            display: "flex",
            alignItems: "center",
            gap: 7,
            color: selectedPath === node.path ? "var(--fg-strong)" : "var(--fg)",
            background: selectedPath === node.path ? "var(--bg-selected)" : "transparent",
            textAlign: "left",
          }}
        >
          <span style={{ color: node.kind === "folder" ? "var(--accent)" : "var(--fg-subtle)" }}>
            <NodeIcon kind={node.kind} />
          </span>
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}>
            {node.name}
          </span>
          {node.changedCount > 0 && (
            <span style={{ color: "var(--accent)", fontSize: 10, fontWeight: 700 }}>
              {node.changedCount}
            </span>
          )}
        </button>
      )}
      {node.children.map((child) => (
        <MemoryTree
          key={child.id}
          node={child}
          selectedPath={selectedPath}
          onSelect={onSelect}
          depth={node.path === "" ? 0 : depth + 1}
        />
      ))}
    </div>
  );
}

export function ProjectGraphPanel({
  visible,
  width,
  workspaceRoot,
  fill,
  activePath,
  onContextChange,
}: Props) {
  const [graph, setGraph] = useState<ProjectGraph | null>(null);
  const [selectedPath, setSelectedPath] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const tree = useMemo(() => (graph ? buildMemoryTree(graph.files) : null), [graph]);
  const selected = useMemo(() => {
    if (!tree) return null;
    const stack = [tree];
    while (stack.length) {
      const next = stack.pop()!;
      if (next.path === selectedPath) return next;
      stack.push(...next.children);
    }
    return tree;
  }, [tree, selectedPath]);

  async function refresh() {
    if (!workspaceRoot) return;
    setLoading(true);
    setError(null);
    try {
      const next = await invoke<ProjectGraph>("project_graph", { workspaceRoot });
      setGraph(next);
      if (!selectedPath) setSelectedPath("src");
    } catch (e) {
      setGraph(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!visible || !workspaceRoot) return;
    refresh();
  }, [visible, workspaceRoot]);

  useEffect(() => {
    if (!workspaceRoot || !selected) {
      setNote("");
      return;
    }
    setNote(localStorage.getItem(storageKey(workspaceRoot, selected.path)) ?? "");
  }, [workspaceRoot, selected?.path]);

  function saveNote(value: string) {
    setNote(value);
    if (!workspaceRoot || !selected) return;
    localStorage.setItem(storageKey(workspaceRoot, selected.path), value);
  }

  const related = selected && tree ? relatedNodes(selected, tree) : [];
  const changed = selected ? changedFiles(selected) : [];
  const snapshot = useMemo(
    () => (selected && tree ? contextSnapshot(selected, tree, note) : null),
    [selected, tree, note]
  );

  useEffect(() => {
    onContextChange?.(snapshot);
  }, [onContextChange, snapshot]);

  useEffect(() => {
    if (!activePath || !tree) return;
    if (findNode(tree, activePath)) setSelectedPath(activePath);
  }, [activePath, tree]);

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
        <span>Project Memory</span>
        {workspaceRoot && (
          <button
            aria-label="Refresh project memory"
            title={loading ? "Refreshing" : "Refresh"}
            disabled={loading}
            onClick={refresh}
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
        <div style={{ flex: 1, display: "grid", placeItems: "center", padding: 18, color: "var(--fg-subtle)", textAlign: "center", lineHeight: 1.55 }}>
          Open a folder to build a project memory map.
        </div>
      )}

      {workspaceRoot && error && (
        <div style={{ padding: "18px 14px", color: "var(--fg-subtle)", lineHeight: 1.55 }}>
          <div style={{ color: "var(--fg)", marginBottom: 6 }}>Memory unavailable</div>
          <div>{error}</div>
        </div>
      )}

      {workspaceRoot && !error && graph && tree && selected && (
        <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateRows: "minmax(0, 1fr) minmax(220px, 0.9fr)" }}>
          <div style={{ minHeight: 0, overflow: "auto", padding: 8 }}>
            <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-md)", background: "var(--bg-elevated)", padding: 6 }}>
              <MemoryTree node={tree} selectedPath={selected.path} onSelect={(node) => setSelectedPath(node.path)} />
            </div>
          </div>

          <section style={{ borderTop: "1px solid var(--border)", minHeight: 0, overflow: "auto", padding: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{ color: selected.kind === "folder" ? "var(--accent)" : "var(--fg-subtle)" }}>
                <NodeIcon kind={selected.kind} />
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ color: "var(--fg-strong)", fontSize: 14, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {selected.path || graph.root_name}
                </div>
                <div style={{ color: "var(--fg-subtle)", fontSize: 11 }}>
                  {selected.files.length} files · {selected.changedCount} changed
                </div>
              </div>
            </div>

            <div style={{ color: "var(--fg)", fontSize: 12, lineHeight: 1.55, marginBottom: 10 }}>
              {describeNode(selected)}
            </div>

            {snapshot && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ color: "var(--fg-subtle)", fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 5 }}>
                  Focus Stack
                </div>
                <div style={{ display: "grid", gap: 5 }}>
                  {snapshot.focused.slice(0, 4).map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => item.path !== "." && setSelectedPath(item.path)}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "minmax(0, 1fr) auto",
                        gap: 8,
                        textAlign: "left",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius-sm)",
                        background: "var(--bg-hover)",
                        padding: "6px 7px",
                      }}
                    >
                      <span style={{ minWidth: 0 }}>
                        <span style={{ display: "block", color: "var(--fg-strong)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {item.path}
                        </span>
                        <span style={{ display: "block", color: "var(--fg-subtle)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {item.detail}
                        </span>
                      </span>
                      <span style={{ color: "var(--accent)", fontSize: 10, fontWeight: 700, textTransform: "uppercase" }}>
                        {item.label}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <textarea
              value={note}
              onChange={(e) => saveNote(e.target.value)}
              placeholder="Memory notes for agents: conventions, risks, handoff context..."
              style={{
                width: "100%",
                minHeight: 86,
                resize: "vertical",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                background: "var(--bg)",
                color: "var(--fg-strong)",
                padding: 9,
                font: "inherit",
                fontSize: 12,
                lineHeight: 1.45,
                outline: "none",
                marginBottom: 10,
              }}
            />

            {related.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ color: "var(--fg-subtle)", fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 5 }}>
                  Related
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {related.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setSelectedPath(item.path)}
                      style={{
                        maxWidth: "100%",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius-sm)",
                        padding: "4px 7px",
                        color: "var(--fg)",
                        background: "var(--bg-hover)",
                        fontSize: 11,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {item.path}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {changed.length > 0 && (
              <div>
                <div style={{ color: "var(--fg-subtle)", fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 5 }}>
                  Current Activity
                </div>
                {changed.map((file) => (
                  <div key={file.path} style={{ display: "flex", justifyContent: "space-between", gap: 8, color: "var(--fg)", fontSize: 11, padding: "3px 0" }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.path}</span>
                    <span style={{ color: "var(--fg-subtle)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>
                      +{file.additions} -{file.deletions}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </aside>
  );
}
