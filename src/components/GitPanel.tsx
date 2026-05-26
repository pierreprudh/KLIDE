import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

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

function statusLabel(status: string): string {
  if (status === "??") return "U";
  if (status.includes("M")) return "M";
  if (status.includes("A")) return "A";
  if (status.includes("D")) return "D";
  if (status.includes("R")) return "R";
  return status || "-";
}

function StatusPill({ file }: { file: GitFile }) {
  const label = statusLabel(file.status);
  const color =
    label === "M"
      ? "#D99A2B"
      : label === "A"
      ? "#2F9E44"
      : label === "D"
      ? "#D64545"
      : label === "U"
      ? "#7C8CFF"
      : "var(--fg-subtle)";

  return (
    <span
      title={file.staged ? "Staged" : "Unstaged"}
      style={{
        width: 20,
        height: 18,
        borderRadius: "var(--radius-xs)",
        display: "inline-grid",
        placeItems: "center",
        color,
        background: "var(--bg-hover)",
        fontSize: 10,
        fontWeight: 700,
        flexShrink: 0,
      }}
    >
      {label}
    </span>
  );
}

export function GitPanel({ visible, width, workspaceRoot }: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
          padding: "8px 12px",
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
        <span>Git</span>
        {workspaceRoot && (
          <button
            onClick={refresh}
            disabled={loading}
            style={{
              color: "var(--fg-subtle)",
              fontSize: 11,
              padding: "2px 6px",
              opacity: loading ? 0.55 : 1,
            }}
          >
            {loading ? "Refreshing" : "Refresh"}
          </button>
        )}
      </header>

      {!workspaceRoot && (
        <div style={{ padding: "18px 14px", color: "var(--fg-subtle)", lineHeight: 1.55 }}>
          <div style={{ color: "var(--fg)", marginBottom: 6 }}>No workspace open</div>
          <div>Open a folder to enable Git status for this project.</div>
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
              justifyContent: "space-between",
              gap: 10,
              fontSize: 12,
            }}
          >
            <span style={{ color: "var(--fg-subtle)" }}>Branch</span>
            <span
              title={status.branch}
              style={{
                color: "var(--fg-strong)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {status.branch}
            </span>
          </div>

          {status.files.length === 0 ? (
            <div style={{ padding: "18px 14px", color: "var(--fg-subtle)" }}>
              Working tree clean.
            </div>
          ) : (
            <ul
              style={{
                listStyle: "none",
                margin: 0,
                padding: "8px 6px",
                overflow: "auto",
                display: "grid",
                gap: 2,
              }}
            >
              {status.files.map((file) => (
                <li
                  key={`${file.status}-${file.path}`}
                  title={file.path}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    minWidth: 0,
                    padding: "5px 7px",
                    borderRadius: "var(--radius-sm)",
                    color: "var(--fg)",
                  }}
                >
                  <StatusPill file={file} />
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      minWidth: 0,
                      fontSize: 13,
                    }}
                  >
                    {file.path}
                  </span>
                  <button
                    onClick={() =>
                      runFileAction(file.staged ? "git_unstage" : "git_stage", file.path)
                    }
                    disabled={loading}
                    style={{
                      marginLeft: "auto",
                      height: 22,
                      padding: "0 7px",
                      color: "var(--fg-subtle)",
                      background: "transparent",
                      border: "1px solid var(--border)",
                      opacity: loading ? 0.55 : 1,
                      flexShrink: 0,
                    }}
                  >
                    {file.staged ? "Unstage" : "Stage"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </aside>
  );
}
