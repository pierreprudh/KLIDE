import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";

type Props = {
  visible: boolean;
  width: number;
  workspaceRoot: string | null;
  gitStatus: GitStatus | null;
  onRefreshGitStatus: () => Promise<void> | void;
  fill?: boolean;
};

export type GitFile = {
  path: string;
  status: string;
  staged: boolean;
};

export type GitStatus = {
  branch: string;
  files: GitFile[];
};

export type GitDiff = {
  path: string;
  diff: string;
  additions: number;
  deletions: number;
  staged?: boolean;
};

function statusLabel(status: string): string {
  if (status === "??") return "U";
  if (status.includes("M")) return "M";
  if (status.includes("A")) return "A";
  if (status.includes("D")) return "D";
  if (status.includes("R")) return "R";
  return status || "-";
}

function statusColor(label: string): string {
  if (label === "M") return "#D99A2B";
  if (label === "A") return "#2F9E44";
  if (label === "D") return "#D64545";
  if (label === "U") return "var(--accent)";
  if (label === "R") return "#9B7DFF";
  return "var(--fg-subtle)";
}

function splitPath(path: string) {
  const parts = path.split("/");
  const name = parts.pop() ?? path;
  return { name, folder: parts.join("/") };
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6v5h-5" /><path d="M4 18v-5h5" />
      <path d="M18.3 9A7 7 0 0 0 6.4 6.4L4 9" /><path d="M5.7 15A7 7 0 0 0 17.6 17.6L20 15" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <path d="M12 5v14" /><path d="M5 12h14" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M18 6L6 18" /><path d="M6 6l12 12" />
    </svg>
  );
}

type ChangeGroup = { dir: string; files: GitFile[] };

function groupByDir(files: GitFile[]): ChangeGroup[] {
  const map = new Map<string, GitFile[]>();
  for (const f of files) {
    const dir = splitPath(f.path).folder || "/";
    if (!map.has(dir)) map.set(dir, []);
    map.get(dir)!.push(f);
  }
  return Array.from(map.entries()).map(([dir, files]) => ({ dir, files }));
}

function StatusDot({ label }: { label: string }) {
  const color = statusColor(label);
  return (
    <span
      style={{
        width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
        background: color, boxShadow: `0 0 0 2px color-mix(in srgb, ${color} 18%, transparent)`,
      }}
    />
  );
}

function FileRow({
  file, loading, onOpen, onStage, onUnstage,
}: {
  file: GitFile; loading: boolean;
  onOpen: (file: GitFile) => void;
  onStage: (path: string) => void;
  onUnstage: (path: string) => void;
}) {
  const { name, folder } = splitPath(file.path);
  const label = statusLabel(file.status);
  return (
    <div
      onClick={() => onOpen(file)}
      style={{
        display: "grid", gridTemplateColumns: "auto 1fr auto", alignItems: "center", gap: 8,
        padding: "5px 10px", borderRadius: "var(--radius-sm)", cursor: "pointer",
        transition: "background var(--motion-fast) var(--ease-out)",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
    >
      <StatusDot label={label} />
      <div style={{ minWidth: 0 }}>
        <div style={{ color: "var(--fg)", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {name}
        </div>
        {folder && (
          <div style={{ color: "var(--fg-dim)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 1 }}>
            {folder}
          </div>
        )}
      </div>
      <button
        aria-label={file.staged ? "Unstage" : "Stage"}
        title={file.staged ? "Unstage Changes" : "Stage Changes"}
        disabled={loading}
        onClick={(e) => { e.stopPropagation(); file.staged ? onUnstage(file.path) : onStage(file.path); }}
        style={{
          width: 26, height: 26, display: "grid", placeItems: "center", borderRadius: "var(--radius-xs)",
          color: "var(--fg-subtle)", opacity: loading ? 0.45 : 1, border: "none", background: "none", cursor: "pointer",
        }}
        onMouseEnter={(e) => { if (!loading) { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--fg-strong)"; } }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--fg-subtle)"; }}
      >
        {file.staged ? <CloseIcon /> : <PlusIcon />}
      </button>
    </div>
  );
}

function DiffLine({ line, index }: { line: string; index: number }) {
  const isMeta = line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("@@") || line.startsWith("new file") || line.startsWith("deleted file");
  const isAdded = line.startsWith("+") && !line.startsWith("+++");
  const isRemoved = line.startsWith("-") && !line.startsWith("---");
  const bg = isAdded ? "color-mix(in srgb, #2F9E44 12%, transparent)"
    : isRemoved ? "color-mix(in srgb, #D64545 12%, transparent)"
    : "transparent";
  const fg = isMeta ? "var(--accent)" : isAdded ? "#2F9E44" : isRemoved ? "#D64545" : "var(--fg)";
  return (
    <div style={{ display: "grid", gridTemplateColumns: "44px 1fr", minHeight: 19, background: bg, color: fg, fontSize: 12, lineHeight: 1.55 }}>
      <span style={{ color: "var(--fg-dim)", textAlign: "right", paddingRight: 12, userSelect: "none", fontSize: 11 }}>
        {index + 1}
      </span>
      <span style={{ whiteSpace: "pre", overflow: "visible" }}>{line || " "}</span>
    </div>
  );
}

function DiffSection({ diff, onClose }: { diff: GitDiff; onClose: () => void }) {
  const lines = diff.diff.trim() ? diff.diff.replace(/\n$/, "").split("\n") : ["No diff available."];
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div style={{ borderTop: "1px solid var(--border)", display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderBottom: "1px solid var(--border)", fontSize: 12 }}>
        <span style={{ fontFamily: "var(--font-mono)", color: "var(--fg-strong)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {diff.path}
        </span>
        <span style={{ color: "#2F9E44", fontFamily: "var(--font-mono)" }}>+{diff.additions}</span>
        <span style={{ color: "#D64545", fontFamily: "var(--font-mono)" }}>-{diff.deletions}</span>
        <button onClick={onClose} aria-label="Close diff" style={{
          width: 22, height: 22, display: "grid", placeItems: "center", borderRadius: "var(--radius-xs)",
          color: "var(--fg-subtle)", border: "none", background: "none", cursor: "pointer",
        }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--fg-strong)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--fg-subtle)"; }}
        >
          <CloseIcon />
        </button>
      </div>
      <div ref={scrollRef} style={{ flex: 1, overflow: "auto", background: "var(--bg-elevated)", padding: "6px 0", fontFamily: "var(--font-mono)" }}>
        {lines.map((line, i) => <DiffLine key={`${i}-${line}`} line={line} index={i} />)}
      </div>
    </div>
  );
}

export function GitPanel({ visible, width, workspaceRoot, gitStatus, onRefreshGitStatus, fill }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [commitLoading, setCommitLoading] = useState(false);
  const [diffLoadingPath, setDiffLoadingPath] = useState<string | null>(null);
  const [activeDiff, setActiveDiff] = useState<GitDiff | null>(null);

  const { stagedFiles, changedFiles } = useMemo(() => {
    const files = gitStatus?.files ?? [];
    return { stagedFiles: files.filter((f) => f.staged), changedFiles: files.filter((f) => !f.staged) };
  }, [gitStatus]);

  const stagedGroups = useMemo(() => groupByDir(stagedFiles), [stagedFiles]);
  const changedGroups = useMemo(() => groupByDir(changedFiles), [changedFiles]);

  async function refresh() {
    if (!workspaceRoot) return;
    setLoading(true); setError(null);
    try { await onRefreshGitStatus(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }

  async function runFileAction(command: "git_stage" | "git_unstage", path: string) {
    if (!workspaceRoot) return;
    setLoading(true); setError(null);
    try {
      await invoke(command, { workspaceRoot, path });
      if (activeDiff?.path === path) setActiveDiff(null);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }

  async function commit() {
    if (!workspaceRoot || !commitMessage.trim() || stagedFiles.length === 0) return;
    setCommitLoading(true); setError(null);
    try {
      await invoke("git_commit", { workspaceRoot, message: commitMessage });
      setCommitMessage("");
      setActiveDiff(null);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setCommitLoading(false); }
  }

  async function openDiff(file: GitFile) {
    if (!workspaceRoot) return;
    if (activeDiff?.path === file.path && activeDiff?.staged === file.staged) {
      setActiveDiff(null);
      return;
    }
    setDiffLoadingPath(file.path); setError(null);
    try {
      const diff = await invoke<GitDiff>("git_diff", { workspaceRoot, path: file.path, staged: file.staged });
      setActiveDiff({ ...diff, staged: file.staged });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setDiffLoadingPath(null); }
  }

  useEffect(() => { if (visible && workspaceRoot) refresh(); }, [visible, workspaceRoot]);

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
      {/* Header */}
      <div style={{
        height: 38, padding: "0 8px 0 12px", display: "flex", alignItems: "center", gap: 8,
        borderBottom: "1px solid var(--border)", fontSize: 11, letterSpacing: "0.06em",
        textTransform: "uppercase", fontWeight: 500, color: "var(--fg-subtle)",
      }}>
        <span style={{ flex: 1, display: "flex", alignItems: "center", gap: 7 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="12" r="2" />
            <path d="M6 7.3v9.4" /><path d="M8.1 6.2A8.3 8.3 0 0 1 15.8 10" />
          </svg>
          Source Control
        </span>
        {workspaceRoot && (
          <button
            aria-label="Refresh"
            title={loading ? "Refreshing" : "Refresh"}
            disabled={loading}
            onClick={refresh}
            style={{
              width: 26, height: 26, display: "grid", placeItems: "center", borderRadius: "var(--radius-xs)",
              color: "var(--fg-subtle)", opacity: loading ? 0.45 : 1, border: "none", background: "none", cursor: "pointer",
            }}
            onMouseEnter={(e) => { if (!loading) { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--fg-strong)"; } }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--fg-subtle)"; }}
          >
            <RefreshIcon />
          </button>
        )}
      </div>

      {!workspaceRoot && (
        <div style={{ flex: 1, display: "grid", placeItems: "center", padding: 24, color: "var(--fg-subtle)", fontSize: 13, textAlign: "center" }}>
          <div>
            <div style={{ color: "var(--fg-dim)", marginBottom: 10, fontSize: 40, lineHeight: 1 }}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="6" cy="5" r="2.3" /><circle cx="6" cy="19" r="2.3" /><circle cx="18" cy="12" r="2.3" />
                <path d="M6 7.3v9.4" /><path d="M8.1 6.2A8.3 8.3 0 0 1 15.8 10" />
              </svg>
            </div>
            <div style={{ color: "var(--fg)", marginBottom: 4 }}>No workspace open</div>
            <div>Open a folder to view source control changes.</div>
          </div>
        </div>
      )}

      {workspaceRoot && error && (
        <div style={{ padding: "16px 14px", color: "var(--fg-subtle)", fontSize: 13, lineHeight: 1.55 }}>
          <div style={{ color: "var(--fg)", marginBottom: 4, fontWeight: 600 }}>Git unavailable</div>
          <div>{error || "This folder may not be a Git repository."}</div>
        </div>
      )}

      {workspaceRoot && !error && gitStatus && (
        <>
          {/* Branch bar */}
          <div style={{
            padding: "8px 12px", borderBottom: "1px solid var(--border)",
            display: "flex", alignItems: "center", gap: 8, fontSize: 13,
          }}>
            <span style={{ color: "var(--fg-dim)", display: "grid", placeItems: "center" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="12" r="2" />
                <path d="M6 7.3v9.4" /><path d="M8.1 6.2A8.3 8.3 0 0 1 15.8 10" />
              </svg>
            </span>
            <span style={{ color: "var(--fg-strong)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
              {gitStatus.branch}
            </span>
            <span style={{ marginLeft: "auto", color: "var(--fg-dim)", fontSize: 12 }}>
              {gitStatus.files.length} {gitStatus.files.length === 1 ? "change" : "changes"}
            </span>
          </div>

          {/* Commit area */}
          <div style={{ padding: "10px 10px 12px", borderBottom: "1px solid var(--border)", display: "grid", gap: 8 }}>
            <input
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); commit(); } }}
              placeholder="Message"
              aria-label="Commit message"
              style={{
                height: 30, minWidth: 0, border: "1px solid var(--border)", borderRadius: "var(--radius-sm)",
                background: "var(--bg)", color: "var(--fg-strong)", font: "inherit", padding: "0 9px", outline: "none",
              }}
            />
            <button
              onClick={commit}
              disabled={!commitMessage.trim() || stagedFiles.length === 0 || commitLoading}
              title={stagedFiles.length === 0 ? "Stage changes before committing" : "Commit staged changes"}
              style={{
                height: 30, borderRadius: "var(--radius-sm)", border: "1px solid var(--accent)", fontWeight: 600, cursor: "pointer",
                background: commitMessage.trim() && stagedFiles.length > 0 && !commitLoading ? "var(--accent)" : "var(--bg-hover)",
                color: commitMessage.trim() && stagedFiles.length > 0 && !commitLoading ? "#fff" : "var(--fg-subtle)",
              }}
            >
              {commitLoading ? "Committing..." : stagedFiles.length === 0 ? "Commit Staged" : `Commit ${stagedFiles.length} staged`}
            </button>
          </div>

          {/* File list area — scrollable, with active diff below */}
          <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
            {gitStatus.files.length === 0 ? (
              <div style={{ flex: 1, display: "grid", placeItems: "center", padding: 24, color: "var(--fg-subtle)", textAlign: "center" }}>
                <div style={{ fontSize: 13 }}>
                  <div style={{ color: "var(--fg)", marginBottom: 4, fontWeight: 600 }}>No changes</div>
                  <div>Working tree clean.</div>
                </div>
              </div>
            ) : (
              <div style={{ overflow: "auto", minHeight: 0, flex: activeDiff ? "0 0 auto" : 1, maxHeight: activeDiff ? "45%" : undefined }}>
                {stagedFiles.length > 0 && (
                  <div>
                    <SectionHeader
                      title="Staged"
                      count={stagedFiles.length}
                      actionLabel="Unstage all"
                      onAction={() => runFileAction("git_unstage", ".")}
                      loading={loading}
                    />
                    {stagedGroups.map((g) => (
                      <DirGroup key={g.dir} dir={g.dir} files={g.files} loading={loading || diffLoadingPath !== null} onOpen={openDiff} onStage={(p) => runFileAction("git_stage", p)} onUnstage={(p) => runFileAction("git_unstage", p)} />
                    ))}
                  </div>
                )}
                {changedFiles.length > 0 && (
                  <div>
                    <SectionHeader
                      title="Changes"
                      count={changedFiles.length}
                      actionLabel="Stage all"
                      onAction={() => runFileAction("git_stage", ".")}
                      loading={loading}
                    />
                    {changedGroups.map((g) => (
                      <DirGroup key={g.dir} dir={g.dir} files={g.files} loading={loading || diffLoadingPath !== null} onOpen={openDiff} onStage={(p) => runFileAction("git_stage", p)} onUnstage={(p) => runFileAction("git_unstage", p)} />
                    ))}
                  </div>
                )}
              </div>
            )}
            {activeDiff && (
              <DiffSection diff={activeDiff} onClose={() => setActiveDiff(null)} />
            )}
          </div>
        </>
      )}
    </aside>
  );
}

function SectionHeader({ title, count, actionLabel, onAction, loading }: {
  title: string; count: number; actionLabel: string; onAction: () => void; loading: boolean;
}) {
  return (
    <div style={{
      height: 28, padding: "0 10px", display: "flex", alignItems: "center", gap: 6,
      color: "var(--fg-subtle)", fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase",
    }}>
      <span style={{ color: "var(--fg)" }}>{title}</span>
      <span style={{ color: "var(--fg-dim)" }}>{count}</span>
      <span style={{ flex: 1 }} />
      <button
        aria-label={actionLabel}
        title={actionLabel}
        disabled={loading}
        onClick={onAction}
        style={{
          fontSize: 10, padding: "2px 7px", borderRadius: "var(--radius-xs)", border: "none", cursor: "pointer",
          background: "transparent", color: "var(--fg-subtle)", fontWeight: 500, letterSpacing: "0.03em",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--fg-strong)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--fg-subtle)"; }}
      >
        {actionLabel}
      </button>
    </div>
  );
}

/* Modal diff window — used by App.tsx via Sidebar context menu */
export function GitDiffWindow({ diff, onClose }: { diff: GitDiff; onClose: () => void }) {
  const lines = diff.diff.trim() ? diff.diff.replace(/\n$/, "").split("\n") : ["No diff available."];
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 999, display: "grid", placeItems: "center",
        background: "rgba(0,0,0,0.35)", backdropFilter: "blur(4px)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "80vw", height: "80vh", maxWidth: 900, maxHeight: 700, borderRadius: "var(--radius-lg)",
          background: "var(--bg-elevated)", border: "1px solid var(--border)",
          display: "flex", flexDirection: "column", overflow: "hidden",
          boxShadow: "0 16px 48px rgba(0,0,0,0.22)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--fg-strong)", flex: 1, fontSize: 13 }}>{diff.path}</span>
          <span style={{ color: "#2F9E44", fontFamily: "var(--font-mono)", fontSize: 12 }}>+{diff.additions}</span>
          <span style={{ color: "#D64545", fontFamily: "var(--font-mono)", fontSize: 12 }}>-{diff.deletions}</span>
          <button onClick={onClose} aria-label="Close" style={{
            width: 26, height: 26, display: "grid", placeItems: "center", borderRadius: "var(--radius-xs)",
            color: "var(--fg-subtle)", border: "none", background: "none", cursor: "pointer",
          }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--fg-strong)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--fg-subtle)"; }}
          >
            <CloseIcon />
          </button>
        </div>
        <div ref={scrollRef} style={{ flex: 1, overflow: "auto", background: "var(--bg)", padding: "8px 0", fontFamily: "var(--font-mono)" }}>
          {lines.map((line, i) => <DiffLine key={`${i}-${line}`} line={line} index={i} />)}
        </div>
      </div>
    </div>
  );
}

function DirGroup({ dir, files, loading, onOpen, onStage, onUnstage }: {
  dir: string; files: GitFile[]; loading: boolean;
  onOpen: (f: GitFile) => void;
  onStage: (path: string) => void;
  onUnstage: (path: string) => void;
}) {
  return (
    <div style={{ marginBottom: 2 }}>
      {dir !== "/" && (
        <div style={{ padding: "2px 10px 2px 14px", fontSize: 11, color: "var(--fg-dim)", fontWeight: 500 }}>
          {dir}
        </div>
      )}
      <div style={{ padding: "0 6px" }}>
        {files.map((file) => (
          <FileRow
            key={`${file.status}-${file.path}-${file.staged ? "staged" : "changed"}`}
            file={file} loading={loading}
            onOpen={onOpen} onStage={onStage} onUnstage={onUnstage}
          />
        ))}
      </div>
    </div>
  );
}
