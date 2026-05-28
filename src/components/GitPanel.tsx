import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState, type ReactNode } from "react";

type Props = {
  visible: boolean;
  width: number;
  workspaceRoot: string | null;
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

type GitDiff = {
  path: string;
  diff: string;
  additions: number;
  deletions: number;
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

function IconButton({
  label,
  title,
  disabled,
  onClick,
  children,
}: {
  label: string;
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{
        width: 24,
        height: 24,
        display: "grid",
        placeItems: "center",
        color: "var(--fg-subtle)",
        opacity: disabled ? 0.45 : 1,
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.color = "var(--fg-strong)";
        e.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = "var(--fg-subtle)";
        e.currentTarget.style.background = "transparent";
      }}
    >
      {children}
    </button>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function MinusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <path d="M5 12h14" />
    </svg>
  );
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

function BranchIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="5" r="2.3" />
      <circle cx="6" cy="19" r="2.3" />
      <circle cx="18" cy="12" r="2.3" />
      <path d="M6 7.3v9.4" />
      <path d="M8.1 6.2A8.3 8.3 0 0 1 15.8 10" />
    </svg>
  );
}

function SourceControlIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="5" r="2.3" />
      <circle cx="6" cy="19" r="2.3" />
      <circle cx="18" cy="12" r="2.3" />
      <path d="M6 7.3v9.4" />
      <path d="M8.1 6.2A8.3 8.3 0 0 1 15.8 10" />
    </svg>
  );
}

function StatusBadge({ file }: { file: GitFile }) {
  const label = statusLabel(file.status);
  return (
    <span
      title={file.status}
      style={{
        width: 18,
        color: statusColor(label),
        fontSize: 11,
        fontWeight: 700,
        textAlign: "center",
        flex: "0 0 auto",
      }}
    >
      {label}
    </span>
  );
}

function FileRow({
  file,
  loading,
  onOpen,
  onStage,
  onUnstage,
}: {
  file: GitFile;
  loading: boolean;
  onOpen: (file: GitFile) => void;
  onStage: (path: string) => void;
  onUnstage: (path: string) => void;
}) {
  const { name, folder } = splitPath(file.path);
  return (
    <li
      title={file.path}
      onClick={() => onOpen(file)}
      style={{
        display: "grid",
        gridTemplateColumns: "18px minmax(0, 1fr) 24px",
        alignItems: "center",
        gap: 6,
        minWidth: 0,
        minHeight: 32,
        padding: "3px 4px",
        borderRadius: "var(--radius-sm)",
        color: "var(--fg)",
        cursor: "pointer",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <StatusBadge file={file} />
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            color: "var(--fg)",
            fontSize: 13,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {name}
        </div>
        {folder && (
          <div
            style={{
              color: "var(--fg-dim)",
              fontSize: 11,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              marginTop: 1,
            }}
          >
            {folder}
          </div>
        )}
      </div>
      <IconButton
        label={file.staged ? "Unstage file" : "Stage file"}
        title={file.staged ? "Unstage Changes" : "Stage Changes"}
        disabled={loading}
        onClick={() => (file.staged ? onUnstage(file.path) : onStage(file.path))}
      >
        {file.staged ? <MinusIcon /> : <PlusIcon />}
      </IconButton>
    </li>
  );
}

function FileSection({
  title,
  files,
  loading,
  actionLabel,
  actionTitle,
  actionIcon,
  onActionAll,
  onOpen,
  onStage,
  onUnstage,
}: {
  title: string;
  files: GitFile[];
  loading: boolean;
  actionLabel: string;
  actionTitle: string;
  actionIcon: ReactNode;
  onActionAll: () => void;
  onOpen: (file: GitFile) => void;
  onStage: (path: string) => void;
  onUnstage: (path: string) => void;
}) {
  if (files.length === 0) return null;

  return (
    <section>
      <div
        style={{
          height: 28,
          padding: "0 8px 0 10px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          color: "var(--fg-subtle)",
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
        }}
      >
        <span style={{ color: "var(--fg)" }}>{title}</span>
        <span style={{ color: "var(--fg-dim)" }}>{files.length}</span>
        <span style={{ flex: 1 }} />
        <IconButton
          label={actionLabel}
          title={actionTitle}
          disabled={loading}
          onClick={onActionAll}
        >
          {actionIcon}
        </IconButton>
      </div>
      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: "0 6px 8px",
          display: "grid",
          gap: 1,
        }}
      >
        {files.map((file) => (
          <FileRow
            key={`${file.status}-${file.path}-${file.staged ? "staged" : "changed"}`}
            file={file}
            loading={loading}
            onOpen={onOpen}
            onStage={onStage}
            onUnstage={onUnstage}
          />
        ))}
      </ul>
    </section>
  );
}

function DiffLine({ line, index }: { line: string; index: number }) {
  const isMeta =
    line.startsWith("diff --git") ||
    line.startsWith("index ") ||
    line.startsWith("@@") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file");
  const isAdded = line.startsWith("+") && !line.startsWith("+++");
  const isRemoved = line.startsWith("-") && !line.startsWith("---");
  const bg = isAdded
    ? "color-mix(in srgb, #2F9E44 16%, transparent)"
    : isRemoved
    ? "color-mix(in srgb, #D64545 16%, transparent)"
    : "transparent";
  const fg = isMeta
    ? "var(--accent)"
    : isAdded
    ? "#2F9E44"
    : isRemoved
    ? "#D64545"
    : "var(--fg)";

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "52px minmax(0, 1fr)",
        minHeight: 20,
        background: bg,
        color: fg,
      }}
    >
      <span
        style={{
          color: "var(--fg-dim)",
          textAlign: "right",
          paddingRight: 14,
          userSelect: "none",
        }}
      >
        {index + 1}
      </span>
      <span style={{ whiteSpace: "pre", overflow: "visible" }}>{line || " "}</span>
    </div>
  );
}

function GitDiffWindow({
  diff,
  onClose,
}: {
  diff: GitDiff;
  onClose: () => void;
}) {
  const lines = diff.diff.trim()
    ? diff.diff.replace(/\n$/, "").split("\n")
    : ["No diff available for this file."];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Diff for ${diff.path}`}
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 5000,
        display: "grid",
        placeItems: "center",
        background: "rgba(0, 0, 0, 0.34)",
        backdropFilter: "blur(3px)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(1180px, calc(100vw - 48px))",
          height: "min(820px, calc(100vh - 48px))",
          background: "var(--bg)",
          border: "1px solid var(--border-strong)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--panel-shadow)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <header
          style={{
            height: 48,
            padding: "0 14px 0 18px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                color: "var(--fg-strong)",
                fontSize: 13,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {diff.path}
            </div>
            <div style={{ color: "var(--fg-subtle)", fontSize: 11, marginTop: 2 }}>
              Git diff
            </div>
          </div>
          <div
            style={{
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              gap: 10,
              fontFamily: "var(--font-mono)",
              fontSize: 12,
            }}
          >
            <span style={{ color: "#2F9E44" }}>+{diff.additions}</span>
            <span style={{ color: "#D64545" }}>-{diff.deletions}</span>
            <button
              onClick={onClose}
              aria-label="Close diff"
              style={{
                width: 26,
                height: 26,
                display: "grid",
                placeItems: "center",
                color: "var(--fg-subtle)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = "var(--fg-strong)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
                e.currentTarget.style.color = "var(--fg-subtle)";
              }}
            >
              x
            </button>
          </div>
        </header>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            background: "var(--bg-elevated)",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            lineHeight: 1.55,
            padding: "10px 0",
          }}
        >
          {lines.map((line, index) => (
            <DiffLine key={`${index}-${line}`} line={line} index={index} />
          ))}
        </div>
      </div>
    </div>
  );
}

export function GitPanel({ visible, width, workspaceRoot }: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [diffLoadingPath, setDiffLoadingPath] = useState<string | null>(null);
  const [activeDiff, setActiveDiff] = useState<GitDiff | null>(null);

  const { stagedFiles, changedFiles } = useMemo(() => {
    const files = status?.files ?? [];
    return {
      stagedFiles: files.filter((file) => file.staged),
      changedFiles: files.filter((file) => !file.staged),
    };
  }, [status]);

  async function refresh() {
    if (!workspaceRoot) return;
    setLoading(true);
    setError(null);
    try {
      const next = await invoke<GitStatus>("git_status", {
        workspaceRoot,
      });
      setStatus(next);
    } catch (e) {
      setStatus(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function runFileAction(command: "git_stage" | "git_unstage", path: string) {
    if (!workspaceRoot) return;
    setLoading(true);
    setError(null);
    try {
      await invoke(command, { workspaceRoot, path });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function openDiff(file: GitFile) {
    if (!workspaceRoot) return;
    setDiffLoadingPath(file.path);
    setError(null);
    try {
      const diff = await invoke<GitDiff>("git_diff", {
        workspaceRoot,
        path: file.path,
        staged: file.staged,
      });
      setActiveDiff(diff);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDiffLoadingPath(null);
    }
  }

  useEffect(() => {
    if (!visible || !workspaceRoot) return;
    refresh();
  }, [visible, workspaceRoot]);

  return (
    <>
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
        <span>Source Control</span>
        {workspaceRoot && (
          <IconButton
            label="Refresh Git status"
            title={loading ? "Refreshing" : "Refresh"}
            disabled={loading}
            onClick={refresh}
          >
            <RefreshIcon />
          </IconButton>
        )}
      </header>

      {!workspaceRoot && (
        <div
          style={{
            flex: 1,
            display: "grid",
            placeItems: "center",
            padding: "18px 18px",
            color: "var(--fg-subtle)",
            lineHeight: 1.55,
            textAlign: "center",
          }}
        >
          <div style={{ width: "min(220px, 90%)" }}>
            <div style={{ color: "var(--accent)", marginBottom: 14 }}>
              <SourceControlIcon />
            </div>
            <div style={{ color: "var(--fg)", marginBottom: 6 }}>No workspace open</div>
            <div>Open a folder to view source control changes.</div>
          </div>
        </div>
      )}

      {workspaceRoot && error && (
        <div style={{ padding: "18px 14px", color: "var(--fg-subtle)", lineHeight: 1.55 }}>
          <div style={{ color: "var(--fg)", marginBottom: 6 }}>Git unavailable</div>
          <div>{error || "This folder may not be a Git repository."}</div>
        </div>
      )}

      {workspaceRoot && !error && status && (
        <>
          <div
            style={{
              padding: "10px 12px",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              gap: 7,
              fontSize: 12,
              minHeight: 38,
            }}
          >
            <span style={{ color: "var(--fg-subtle)", display: "grid", placeItems: "center" }}>
              <BranchIcon />
            </span>
            <span
              title={status.branch}
              style={{
                color: "var(--fg-strong)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                minWidth: 0,
              }}
            >
              {status.branch}
            </span>
            <span style={{ marginLeft: "auto", color: "var(--fg-dim)", fontSize: 11 }}>
              {status.files.length} {status.files.length === 1 ? "change" : "changes"}
            </span>
          </div>

          {status.files.length === 0 ? (
            <div
              style={{
                flex: 1,
                display: "grid",
                placeItems: "center",
                padding: "18px 14px",
                color: "var(--fg-subtle)",
                textAlign: "center",
              }}
            >
              <div>
                <div style={{ color: "var(--fg)", marginBottom: 6 }}>No changes</div>
                <div>Working tree clean.</div>
              </div>
            </div>
          ) : (
            <div style={{ overflow: "auto", minHeight: 0, paddingTop: 4 }}>
              <FileSection
                title="Staged Changes"
                files={stagedFiles}
                loading={loading || diffLoadingPath !== null}
                actionLabel="Unstage all changes"
                actionTitle="Unstage All Changes"
                actionIcon={<MinusIcon />}
                onActionAll={() => runFileAction("git_unstage", ".")}
                onOpen={openDiff}
                onStage={(path) => runFileAction("git_stage", path)}
                onUnstage={(path) => runFileAction("git_unstage", path)}
              />
              <FileSection
                title="Changes"
                files={changedFiles}
                loading={loading || diffLoadingPath !== null}
                actionLabel="Stage all changes"
                actionTitle="Stage All Changes"
                actionIcon={<PlusIcon />}
                onActionAll={() => runFileAction("git_stage", ".")}
                onOpen={openDiff}
                onStage={(path) => runFileAction("git_stage", path)}
                onUnstage={(path) => runFileAction("git_unstage", path)}
              />
            </div>
          )}
        </>
      )}
      </aside>
      {activeDiff && <GitDiffWindow diff={activeDiff} onClose={() => setActiveDiff(null)} />}
    </>
  );
}
