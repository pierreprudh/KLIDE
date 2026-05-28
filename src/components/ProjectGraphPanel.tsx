import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";

type Props = {
  visible: boolean;
  width: number;
  workspaceRoot: string | null;
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

type TreeFile = ProjectGraphFile & { name: string };
type TreeFolder = {
  name: string;
  path: string;
  files: TreeFile[];
  folders: Map<string, TreeFolder>;
  totalFiles: number;
  changedFiles: number;
  additions: number;
  deletions: number;
};

function createFolder(name: string, path: string): TreeFolder {
  return {
    name,
    path,
    files: [],
    folders: new Map(),
    totalFiles: 0,
    changedFiles: 0,
    additions: 0,
    deletions: 0,
  };
}

function buildTree(files: ProjectGraphFile[]): TreeFolder {
  const root = createFolder("Project", "");
  for (const file of files) {
    const parts = file.path.split("/");
    const fileName = parts.pop() ?? file.path;
    let current = root;
    current.totalFiles += 1;
    if (file.changed) current.changedFiles += 1;
    current.additions += file.additions;
    current.deletions += file.deletions;

    for (const part of parts) {
      const nextPath = current.path ? `${current.path}/${part}` : part;
      if (!current.folders.has(part)) {
        current.folders.set(part, createFolder(part, nextPath));
      }
      current = current.folders.get(part)!;
      current.totalFiles += 1;
      if (file.changed) current.changedFiles += 1;
      current.additions += file.additions;
      current.deletions += file.deletions;
    }
    current.files.push({ ...file, name: fileName });
  }
  return root;
}

function statusLabel(status: string): string {
  if (status === "??") return "U";
  if (status.includes("M")) return "M";
  if (status.includes("A")) return "A";
  if (status.includes("D")) return "D";
  if (status.includes("R")) return "R";
  return status || "";
}

function statusColor(label: string): string {
  if (label === "M") return "#D99A2B";
  if (label === "A") return "#2F9E44";
  if (label === "D") return "#D64545";
  if (label === "U") return "var(--accent)";
  if (label === "R") return "#9B7DFF";
  return "var(--fg-dim)";
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

function FolderIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7.5C3 6.4 3.9 5.5 5 5.5h3.5l2 2H19c1.1 0 2 .9 2 2v7c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2v-9z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 3.5h7l4 4V20H7z" />
      <path d="M14 3.5v4h4" />
    </svg>
  );
}

function GraphEmptyIcon() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="7" r="2.3" />
      <circle cx="18" cy="6" r="2.3" />
      <circle cx="8" cy="18" r="2.3" />
      <circle cx="18" cy="17" r="2.3" />
      <path d="M8.2 7h7.6" />
      <path d="M7 9.1l1 6.6" />
      <path d="M10.2 17.8h5.6" />
      <path d="M17.8 8.3v6.4" />
    </svg>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div
      style={{
        minWidth: 0,
        padding: "10px 11px",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        background: "var(--bg-elevated)",
      }}
    >
      <div style={{ color: "var(--fg-strong)", fontSize: 16, fontWeight: 700 }}>
        {value}
      </div>
      <div
        style={{
          color: "var(--fg-subtle)",
          fontSize: 10,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          marginTop: 3,
        }}
      >
        {label}
      </div>
    </div>
  );
}

function ChangeStats({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  if (additions === 0 && deletions === 0) {
    return <span style={{ color: "var(--fg-dim)", fontSize: 11 }}>clean</span>;
  }
  return (
    <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, display: "flex", gap: 7 }}>
      <span style={{ color: "#2F9E44" }}>+{additions}</span>
      <span style={{ color: "#D64545" }}>-{deletions}</span>
    </span>
  );
}

function FolderRow({ folder, depth }: { folder: TreeFolder; depth: number }) {
  const childFolders = Array.from(folder.folders.values()).sort((a, b) => {
    return b.changedFiles - a.changedFiles || a.name.localeCompare(b.name);
  });
  const files = folder.files.slice().sort((a, b) => {
    return Number(b.changed) - Number(a.changed) || a.name.localeCompare(b.name);
  });
  const isRoot = depth === 0;

  return (
    <div>
      {!isRoot && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) auto",
            gap: 8,
            alignItems: "center",
            padding: "6px 6px",
            paddingLeft: 6 + depth * 12,
            borderRadius: "var(--radius-sm)",
            background: folder.changedFiles > 0 ? "var(--accent-soft)" : "transparent",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
            <span style={{ color: folder.changedFiles > 0 ? "var(--accent)" : "var(--fg-subtle)" }}>
              <FolderIcon />
            </span>
            <span
              style={{
                color: "var(--fg-strong)",
                fontSize: 12,
                fontWeight: 700,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {folder.name}
            </span>
            <span style={{ color: "var(--fg-subtle)", fontSize: 11 }}>
              {folder.changedFiles}/{folder.totalFiles}
            </span>
          </div>
          <ChangeStats additions={folder.additions} deletions={folder.deletions} />
        </div>
      )}

      {childFolders.map((child) => (
        <FolderRow key={child.path} folder={child} depth={depth + 1} />
      ))}

      {files.map((file) => {
        const label = statusLabel(file.status);
        return (
          <div
            key={file.path}
            title={file.path}
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) auto",
              gap: 8,
              alignItems: "center",
              minHeight: 28,
              padding: "4px 6px",
              paddingLeft: 18 + depth * 12,
              borderRadius: "var(--radius-sm)",
              background: file.changed ? "color-mix(in srgb, var(--accent-soft) 52%, transparent)" : "transparent",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
              <span style={{ color: file.changed ? "var(--fg)" : "var(--fg-dim)" }}>
                <FileIcon />
              </span>
              <span
                style={{
                  color: file.changed ? "var(--fg-strong)" : "var(--fg)",
                  fontSize: 12,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {file.name}
              </span>
              {label && (
                <span style={{ color: statusColor(label), fontSize: 10, fontWeight: 700 }}>
                  {label}
                </span>
              )}
            </div>
            <ChangeStats additions={file.additions} deletions={file.deletions} />
          </div>
        );
      })}
    </div>
  );
}

export function ProjectGraphPanel({ visible, width, workspaceRoot }: Props) {
  const [graph, setGraph] = useState<ProjectGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const tree = useMemo(() => (graph ? buildTree(graph.files) : null), [graph]);

  async function refresh() {
    if (!workspaceRoot) return;
    setLoading(true);
    setError(null);
    try {
      const next = await invoke<ProjectGraph>("project_graph", { workspaceRoot });
      setGraph(next);
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

  return (
    <aside
      className="floating-panel"
      style={{
        width,
        margin: "4px 0 4px 4px",
        display: visible ? "flex" : "none",
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
        <span>Project Graph</span>
        {workspaceRoot && (
          <button
            aria-label="Refresh project graph"
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
        <div
          style={{
            flex: 1,
            display: "grid",
            placeItems: "center",
            padding: "18px",
            color: "var(--fg-subtle)",
            lineHeight: 1.55,
            textAlign: "center",
          }}
        >
          <div style={{ width: "min(220px, 90%)" }}>
            <div style={{ color: "var(--accent)", marginBottom: 14 }}>
              <GraphEmptyIcon />
            </div>
            <div style={{ color: "var(--fg)", marginBottom: 6 }}>No workspace open</div>
            <div>Open a folder to map folders, files, and current changes.</div>
          </div>
        </div>
      )}

      {workspaceRoot && error && (
        <div style={{ padding: "18px 14px", color: "var(--fg-subtle)", lineHeight: 1.55 }}>
          <div style={{ color: "var(--fg)", marginBottom: 6 }}>Graph unavailable</div>
          <div>{error}</div>
        </div>
      )}

      {workspaceRoot && !error && graph && tree && (
        <div style={{ overflow: "auto", minHeight: 0, padding: 10 }}>
          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-md)",
              background: "var(--bg-elevated)",
              padding: 12,
              marginBottom: 10,
            }}
          >
            <div style={{ color: "var(--fg-strong)", fontSize: 15, fontWeight: 700 }}>
              {graph.root_name}
            </div>
            <div style={{ color: "var(--fg-subtle)", fontSize: 11, marginTop: 3 }}>
              Branch: {graph.branch}
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 8,
              marginBottom: 10,
            }}
          >
            <Stat label="Files" value={graph.total_files} />
            <Stat label="Changed" value={graph.changed_files} />
            <Stat label="Added" value={`+${graph.additions}`} />
            <Stat label="Removed" value={`-${graph.deletions}`} />
          </div>

          <section style={{ marginTop: 14 }}>
            <div
              style={{
                color: "var(--fg-subtle)",
                fontSize: 11,
                letterSpacing: "0.05em",
                textTransform: "uppercase",
                fontWeight: 700,
                marginBottom: 7,
              }}
            >
              Folder and File Map
            </div>
            <div
              style={{
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-md)",
                background: "var(--bg-elevated)",
                padding: 6,
              }}
            >
              <FolderRow folder={tree} depth={0} />
            </div>
          </section>
        </div>
      )}
    </aside>
  );
}
