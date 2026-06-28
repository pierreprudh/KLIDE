// Git Review — a full-window surface for source control, branch management,
// and pull requests. Replaces the old floating `GitPanel` as the single
// entry point for staging, committing, syncing, browsing history, and
// managing PRs.
//
// Layout: 3-pane horizontal — files (left), diff (center), PRs (right).
// Top bar carries the branch selector, commit composer, and sync actions.
// A bottom shelf shows stashes and history at a glance.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ThemeId } from "../theme";
import type { GitFile, GitStatus } from "../gitTypes";

type GitCommit = {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  authorEmail: string;
  /** Unix seconds. */
  timestamp: number;
  refs: string[];
};

type GitBranch = {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  ahead: number;
  behind: number;
  lastSubject: string;
};

type GitLog = {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Unix millis. */
  lastFetchMs: number | null;
  commits: GitCommit[];
  branches: GitBranch[];
};

type GitStash = {
  index: number;
  branch: string;
  message: string;
  /** Unix seconds. */
  timestamp: number;
};

type PullRequest = {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  author: string;
  headRef: string;
  baseRef: string;
  url: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** Unix millis. */
  updatedAtMs: number;
  badge: "open" | "merged" | "closed" | "draft";
  isCurrentBranch: boolean;
};

type PullRequestDetails = PullRequest & {
  body: string;
  mergeable: string;
  /** Unix millis. */
  createdAtMs: number;
};

type Props = {
  workspaceRoot: string | null;
  gitStatus: GitStatus | null;
  onRefreshGitStatus: () => Promise<void> | void;
  onBack: () => void;
  theme: ThemeId;
};

type OpenFile = { path: string; staged: boolean };

// Sub-pane widths live in the parent state so the user can resize and
// we keep both halves animated with the workbench resize transition.
const LEFT_DEFAULT = 280;
const RIGHT_DEFAULT = 360;
const LEFT_MIN = 220;
const RIGHT_MIN = 280;
const MAX_PANE = 720;
const PANE_TRANSITION = "width var(--motion-med) var(--ease-soft)";

function relativeTime(ms: number, nowMs: number = Date.now()): string {
  const diff = Math.max(0, nowMs - ms);
  const s = Math.floor(diff / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

function statusLabel(status: string): string {
  if (status === "??") return "U";
  if (status.includes("M")) return "M";
  if (status.includes("A")) return "A";
  if (status.includes("D")) return "D";
  if (status.includes("R")) return "R";
  return status || "-";
}

function statusColor(label: string): string {
  if (label === "M") return "var(--warning)";
  if (label === "A") return "var(--success)";
  if (label === "D") return "var(--danger)";
  if (label === "U") return "var(--accent)";
  if (label === "R") return "var(--accent)";
  return "var(--fg-subtle)";
}

function splitPath(path: string) {
  const parts = path.split("/");
  const name = parts.pop() ?? path;
  return { name, folder: parts.join("/") };
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

function DiffLine({ line, index }: { line: string; index: number }) {
  const isMeta = line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("@@") || line.startsWith("new file") || line.startsWith("deleted file");
  const isAdded = line.startsWith("+") && !line.startsWith("+++");
  const isRemoved = line.startsWith("-") && !line.startsWith("---");
  const bg = isAdded ? "color-mix(in srgb, var(--success) 12%, transparent)"
    : isRemoved ? "color-mix(in srgb, var(--danger) 12%, transparent)"
    : "transparent";
  const fg = isMeta ? "var(--accent)" : isAdded ? "var(--success)" : isRemoved ? "var(--danger)" : "var(--fg)";
  return (
    <div style={{ display: "grid", gridTemplateColumns: "44px 1fr", minHeight: 19, background: bg, color: fg, fontSize: 12, lineHeight: 1.55 }}>
      <span style={{ color: "var(--fg-dim)", textAlign: "right", paddingRight: 12, userSelect: "none", fontSize: 11 }}>
        {index + 1}
      </span>
      <span style={{ whiteSpace: "pre", overflow: "visible" }}>{line || " "}</span>
    </div>
  );
}

type DiffViewerProps = {
  workspaceRoot: string | null;
  open: OpenFile | null;
  onOpen: (path: string) => void;
};

function DiffViewer({ workspaceRoot, open }: DiffViewerProps) {
  const [diff, setDiff] = useState<{ path: string; diff: string; additions: number; deletions: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastLoadedRef = useRef<string>("");

  useEffect(() => {
    if (!workspaceRoot || !open) {
      setDiff(null);
      setError(null);
      return;
    }
    const key = `${open.path}::${open.staged ? "staged" : "work"}`;
    if (key === lastLoadedRef.current && diff) return;
    lastLoadedRef.current = key;
    setLoading(true);
    setError(null);
    invoke<{ path: string; diff: string; additions: number; deletions: number }>(
      "git_diff",
      { workspaceRoot, path: open.path, staged: open.staged }
    )
      .then((d) => setDiff(d))
      .catch((e) => {
        setDiff(null);
        setError(e instanceof Error ? e.message : String(e));
        lastLoadedRef.current = "";
      })
      .finally(() => setLoading(false));
  }, [open, workspaceRoot, diff]);

  if (!open) {
    return (
      <div style={{ flex: 1, display: "grid", placeItems: "center", color: "var(--fg-subtle)", fontSize: 13, textAlign: "center", padding: 24 }}>
        <div>
          <div style={{ color: "var(--fg)", marginBottom: 4, fontWeight: 600 }}>No file selected</div>
          <div>Pick a file on the left to see its diff here.</div>
        </div>
      </div>
    );
  }
  if (loading) {
    return (
      <div style={{ flex: 1, display: "grid", placeItems: "center", color: "var(--fg-subtle)", fontSize: 13 }}>
        Loading diff…
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ flex: 1, display: "grid", placeItems: "center", color: "var(--fg-subtle)", fontSize: 13, textAlign: "center", padding: 24 }}>
        <div>
          <div style={{ color: "var(--fg)", marginBottom: 4, fontWeight: 600 }}>Diff unavailable</div>
          <div>{error}</div>
        </div>
      </div>
    );
  }
  if (!diff) return null;
  const lines = diff.diff.trim() ? diff.diff.replace(/\n$/, "").split("\n") : ["No diff available."];
  return (
    <div style={{ flex: 1, overflow: "auto", background: "var(--bg)", padding: "8px 0", fontFamily: "var(--font-mono)" }}>
      {lines.map((line, i) => (
        <DiffLine key={`${i}-${line}`} line={line} index={i} />
      ))}
    </div>
  );
}

function BranchPill({ branch, ahead, behind }: { branch: string; ahead: number; behind: number }) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 999, background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--fg-strong)", fontSize: 12, fontWeight: 600 }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)" }} />
      <span style={{ fontFamily: "var(--font-mono)" }}>{branch}</span>
      {ahead > 0 && <span style={{ color: "var(--success)", fontFamily: "var(--font-mono)", fontSize: 11 }}>↑{ahead}</span>}
      {behind > 0 && <span style={{ color: "var(--warning)", fontFamily: "var(--font-mono)", fontSize: 11 }}>↓{behind}</span>}
    </div>
  );
}

type PaneDividerProps = {
  width: number;
  setWidth: (w: number) => void;
  side: "left" | "right";
  min: number;
  max: number;
};

function PaneDivider({ width, setWidth, side, min, max }: PaneDividerProps) {
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      // For the right pane we drag in the opposite direction.
      const delta = side === "left" ? e.movementX : -e.movementX;
      const next = Math.min(max, Math.max(min, width + delta));
      setWidth(next);
    };
    const onUp = () => setDragging(false);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging, width, setWidth, side, min, max]);

  return (
    <div
      onMouseDown={() => setDragging(true)}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--accent)"; }}
      onMouseLeave={(e) => { if (!dragging) e.currentTarget.style.background = "var(--border)"; }}
      style={{
        width: 1,
        background: dragging ? "var(--accent)" : "var(--border)",
        cursor: "col-resize",
        flexShrink: 0,
        position: "relative",
        transition: "background var(--motion-fast) var(--ease-out)",
      }}
      title="Drag to resize"
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: -4,
          right: -4,
        }}
      />
    </div>
  );
}

type FileRowProps = {
  file: GitFile;
  active: boolean;
  onOpen: (file: GitFile) => void;
  onStage: (path: string) => void;
  onUnstage: (path: string) => void;
  onDiscard: (path: string) => void;
  loading: boolean;
};

function FileRow({ file, active, onOpen, onStage, onUnstage, onDiscard, loading }: FileRowProps) {
  const { name, folder } = splitPath(file.path);
  const label = statusLabel(file.status);
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={() => onOpen(file)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr auto",
        alignItems: "center",
        gap: 8,
        padding: "5px 10px",
        borderRadius: "var(--radius-sm)",
        cursor: "pointer",
        background: active ? "var(--bg-selected)" : hover ? "var(--bg-hover)" : "transparent",
        transition: "background var(--motion-fast) var(--ease-out)",
      }}
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
      <div style={{ display: "flex", gap: 2, opacity: hover || active ? 1 : 0, transition: "opacity var(--motion-fast) var(--ease-out)" }}>
        <button
          aria-label={file.staged ? "Unstage" : "Stage"}
          title={file.staged ? "Unstage" : "Stage"}
          disabled={loading}
          onClick={(e) => { e.stopPropagation(); file.staged ? onUnstage(file.path) : onStage(file.path); }}
          style={iconButtonStyle}
        >
          {file.staged ? "−" : "+"}
        </button>
        {!file.staged && (
          <button
            aria-label="Discard changes"
            title="Discard changes"
            disabled={loading}
            onClick={(e) => {
              e.stopPropagation();
              if (confirm(`Discard changes to ${file.path}?`)) onDiscard(file.path);
            }}
            style={iconButtonStyle}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

const iconButtonStyle: React.CSSProperties = {
  width: 22, height: 22, display: "grid", placeItems: "center", borderRadius: "var(--radius-xs)",
  color: "var(--fg-subtle)", border: "none", background: "none", cursor: "pointer", fontSize: 14, lineHeight: 1,
};

function SectionHeader({ title, count, onAction, actionLabel }: {
  title: string; count: number; onAction?: () => void; actionLabel?: string;
}) {
  return (
    <div style={{
      height: 28, padding: "0 10px", display: "flex", alignItems: "center", gap: 6,
      color: "var(--fg-subtle)", fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase",
    }}>
      <span style={{ color: "var(--fg)" }}>{title}</span>
      <span style={{ color: "var(--fg-dim)" }}>{count}</span>
      <span style={{ flex: 1 }} />
      {onAction && actionLabel && (
        <button
          aria-label={actionLabel}
          title={actionLabel}
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
      )}
    </div>
  );
}

type PRBadgeProps = { badge: PullRequest["badge"] };
function PRBadge({ badge }: PRBadgeProps) {
  const map: Record<PullRequest["badge"], { color: string; bg: string; label: string }> = {
    open: { color: "var(--success)", bg: "color-mix(in srgb, var(--success) 18%, transparent)", label: "Open" },
    merged: { color: "var(--accent)", bg: "color-mix(in srgb, var(--accent) 18%, transparent)", label: "Merged" },
    closed: { color: "var(--danger)", bg: "color-mix(in srgb, var(--danger) 18%, transparent)", label: "Closed" },
    draft: { color: "var(--fg-subtle)", bg: "var(--bg-hover)", label: "Draft" },
  };
  const m = map[badge];
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase",
      padding: "2px 7px", borderRadius: 999, color: m.color, background: m.bg,
    }}>{m.label}</span>
  );
}

function PRCard({ pr, selected, onSelect, onOpen, onCheckout, onMerge }: {
  pr: PullRequest; selected: boolean;
  onSelect: (n: number) => void;
  onOpen: (n: number) => void;
  onCheckout: (n: number) => void;
  onMerge: (n: number) => void;
}) {
  return (
    <div
      onClick={() => onSelect(pr.number)}
      style={{
        padding: "10px 12px",
        borderRadius: "var(--radius-sm)",
        background: selected ? "var(--bg-selected)" : "transparent",
        cursor: "pointer",
        transition: "background var(--motion-fast) var(--ease-out)",
      }}
      onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = "transparent"; }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ color: "var(--fg-dim)", fontSize: 12, fontFamily: "var(--font-mono)" }}>#{pr.number}</span>
        <PRBadge badge={pr.badge} />
        {pr.isCurrentBranch && (
          <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", padding: "2px 6px", borderRadius: 999, color: "var(--accent)", background: "color-mix(in srgb, var(--accent) 18%, transparent)" }}>
            Yours
          </span>
        )}
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--fg-dim)" }}>{relativeTime(pr.updatedAtMs)}</span>
      </div>
      <div style={{ color: "var(--fg-strong)", fontSize: 13, lineHeight: 1.35, fontWeight: 500, marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
        {pr.title}
      </div>
      <div style={{ color: "var(--fg-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
        {pr.headRef} <span style={{ color: "var(--fg-subtle)" }}>→</span> {pr.baseRef} · {pr.author}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontFamily: "var(--font-mono)", fontSize: 11 }}>
        <span style={{ color: "var(--success)" }}>+{pr.additions}</span>
        <span style={{ color: "var(--danger)" }}>−{pr.deletions}</span>
        <span style={{ color: "var(--fg-dim)" }}>{pr.changedFiles} files</span>
        <span style={{ flex: 1 }} />
        <button onClick={(e) => { e.stopPropagation(); onOpen(pr.number); }} style={iconButtonStyle} title="Open in browser">↗</button>
        {!pr.isCurrentBranch && pr.badge === "open" && (
          <button onClick={(e) => { e.stopPropagation(); onCheckout(pr.number); }} style={iconButtonStyle} title="Checkout locally">↓</button>
        )}
        {pr.badge === "open" && (
          <button onClick={(e) => { e.stopPropagation(); onMerge(pr.number); }} style={iconButtonStyle} title="Merge">⊕</button>
        )}
      </div>
    </div>
  );
}

function PRDetail({ pr, onClose, onOpen, onCheckout, onMerge }: {
  pr: PullRequestDetails; onClose: () => void;
  onOpen: (n: number) => void;
  onCheckout: (n: number) => void;
  onMerge: (n: number) => void;
}) {
  return (
    <div style={{ borderTop: "1px solid var(--border)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8, minHeight: 0, flex: 1, overflow: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: "var(--fg-dim)", fontSize: 12, fontFamily: "var(--font-mono)" }}>#{pr.number}</span>
        <PRBadge badge={pr.badge} />
        <span style={{ flex: 1 }} />
        <button onClick={onClose} style={iconButtonStyle} title="Close detail">×</button>
      </div>
      <div style={{ color: "var(--fg-strong)", fontSize: 14, fontWeight: 600, lineHeight: 1.3 }}>{pr.title}</div>
      <div style={{ color: "var(--fg-dim)", fontSize: 12, fontFamily: "var(--font-mono)" }}>
        {pr.headRef} <span style={{ color: "var(--fg-subtle)" }}>→</span> {pr.baseRef} · {pr.author}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--font-mono)", fontSize: 11 }}>
        <span style={{ color: "var(--success)" }}>+{pr.additions}</span>
        <span style={{ color: "var(--danger)" }}>−{pr.deletions}</span>
        <span style={{ color: "var(--fg-dim)" }}>{pr.changedFiles} files</span>
        <span style={{ color: "var(--fg-dim)" }}>·</span>
        <span style={{ color: "var(--fg-dim)" }}>{pr.mergeable === "MERGEABLE" ? "No conflicts" : pr.mergeable}</span>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button onClick={() => onOpen(pr.number)} style={pillButtonStyle}>Open ↗</button>
        {!pr.isCurrentBranch && pr.badge === "open" && (
          <button onClick={() => onCheckout(pr.number)} style={pillButtonStyle}>Checkout ↓</button>
        )}
        {pr.badge === "open" && (
          <button onClick={() => onMerge(pr.number)} style={{ ...pillButtonStyle, color: "#fff", background: "var(--accent)", borderColor: "var(--accent)" }}>Merge</button>
        )}
      </div>
      {pr.body && (
        <pre style={{
          font: "inherit", fontSize: 12, lineHeight: 1.55, color: "var(--fg)",
          whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0, padding: "8px 0",
        }}>{pr.body}</pre>
      )}
    </div>
  );
}

const pillButtonStyle: React.CSSProperties = {
  height: 26, padding: "0 10px", borderRadius: 999, fontSize: 11, fontWeight: 600, letterSpacing: "0.02em",
  background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--fg)",
  cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4,
  transition: "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
};

function BranchMenu({ branches, current, onSelect, onClose }: {
  branches: GitBranch[]; current: string;
  onSelect: (name: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return branches;
    return branches.filter((b) => b.name.toLowerCase().includes(q));
  }, [branches, query]);
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 99 }} />
      <div
        className="floating-panel"
        style={{
          position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 100,
          width: 320, maxHeight: 420, overflow: "auto", padding: 6,
          display: "flex", flexDirection: "column", gap: 2,
        }}
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && filtered[0]) { onSelect(filtered[0].name); }
            if (e.key === "Escape") onClose();
          }}
          placeholder="Filter branches…"
          style={{
            height: 28, margin: "2px 4px 6px", padding: "0 8px",
            border: "1px solid var(--border)", borderRadius: "var(--radius-sm)",
            background: "var(--bg)", color: "var(--fg-strong)", font: "inherit", fontSize: 12, outline: "none",
          }}
        />
        {filtered.length === 0 && (
          <div style={{ padding: "12px 8px", color: "var(--fg-subtle)", fontSize: 12 }}>No branches match.</div>
        )}
        {filtered.map((b) => (
          <button
            key={b.name}
            onClick={() => onSelect(b.name)}
            style={{
              display: "grid", gridTemplateColumns: "1fr auto", alignItems: "center", gap: 6,
              padding: "6px 8px", borderRadius: "var(--radius-xs)", border: "none", background: "transparent",
              color: "var(--fg)", font: "inherit", textAlign: "left", cursor: "pointer",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: b.name === current ? "var(--accent)" : "var(--fg-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {b.name}
              </div>
              <div style={{ fontSize: 11, color: "var(--fg-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {b.lastSubject}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, fontSize: 11, fontFamily: "var(--font-mono)" }}>
              {b.ahead > 0 && <span style={{ color: "var(--success)" }}>↑{b.ahead}</span>}
              {b.behind > 0 && <span style={{ color: "var(--warning)" }}>↓{b.behind}</span>}
            </div>
          </button>
        ))}
      </div>
    </>
  );
}

export function GitReview({ workspaceRoot, gitStatus, onRefreshGitStatus, onBack, theme: _theme }: Props) {
  const [log, setLog] = useState<GitLog | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [localStatus, setLocalStatus] = useState<GitStatus | null>(null);
  const [prs, setPrs] = useState<PullRequest[] | null>(null);
  const [prsLoading, setPrsLoading] = useState(false);
  const [prError, setPrError] = useState<string | null>(null);
  const [stashes, setStashes] = useState<GitStash[] | null>(null);
  const [selectedPr, setSelectedPr] = useState<PullRequestDetails | null>(null);
  const [prDetailLoading, setPrDetailLoading] = useState(false);
  const [open, setOpen] = useState<OpenFile | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [commitLoading, setCommitLoading] = useState(false);
  const [prComposer, setPrComposer] = useState<{ title: string; body: string } | null>(null);
  const [leftWidth, setLeftWidth] = useState(LEFT_DEFAULT);
  const [rightWidth, setRightWidth] = useState(RIGHT_DEFAULT);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());

  // Tick "now" once a minute so the relative timestamps on PRs and the last
  // fetch chip don't go stale. We only need minute granularity.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const refreshLog = useCallback(async () => {
    if (!workspaceRoot) return;
    setLogLoading(true);
    try {
      const next = await invoke<GitLog>("git_log", { workspaceRoot, limit: 60 });
      setLog(next);
    } catch (e) {
      setActionMessage({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setLogLoading(false);
    }
  }, [workspaceRoot]);

  const refreshStashes = useCallback(async () => {
    if (!workspaceRoot) return;
    try {
      const list = await invoke<GitStash[]>("git_stash_list", { workspaceRoot });
      setStashes(list);
    } catch {
      setStashes([]);
    }
  }, [workspaceRoot]);

  const refreshPrs = useCallback(async () => {
    if (!workspaceRoot) return;
    setPrsLoading(true);
    setPrError(null);
    try {
      const list = await invoke<PullRequest[]>("git_pr_list", { workspaceRoot });
      setPrs(list);
    } catch (e) {
      setPrError(e instanceof Error ? e.message : String(e));
      setPrs([]);
    } finally {
      setPrsLoading(false);
    }
  }, [workspaceRoot]);

  const refreshStatus = useCallback(async () => {
    if (!workspaceRoot) {
      setLocalStatus(null);
      return;
    }
    try {
      const next = await invoke<GitStatus>("git_status", { workspaceRoot });
      setLocalStatus(next);
      await onRefreshGitStatus();
    } catch (e) {
      setLocalStatus(null);
      setActionMessage({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    }
  }, [workspaceRoot, onRefreshGitStatus]);

  useEffect(() => {
    if (workspaceRoot) {
      setOpen(null);
      void refreshStatus();
      void refreshLog();
      void refreshStashes();
      void refreshPrs();
    } else {
      setLog(null);
      setLocalStatus(null);
      setPrs(null);
      setStashes(null);
    }
  }, [workspaceRoot, refreshStatus, refreshLog, refreshStashes, refreshPrs]);

  const reviewStatus = localStatus ?? gitStatus;

  // Auto-select the first file when the status changes.
  useEffect(() => {
    if (open || !reviewStatus) return;
    const first = reviewStatus.files[0];
    if (first) setOpen({ path: first.path, staged: first.staged });
  }, [reviewStatus, open]);

  // Toast-style messages auto-clear after a few seconds.
  useEffect(() => {
    if (!actionMessage) return;
    const id = setTimeout(() => setActionMessage(null), 4000);
    return () => clearTimeout(id);
  }, [actionMessage]);

  const files = reviewStatus?.files ?? [];
  const stagedFiles = files.filter((f) => f.staged);
  const changedFiles = files.filter((f) => !f.staged);
  const totalAdditions = useMemo(() => {
    return changedFiles.length + stagedFiles.length;
  }, [changedFiles.length, stagedFiles.length]);

  async function withAction<T>(label: string, fn: () => Promise<T>) {
    setActionLoading(label);
    try {
      const result = await fn();
      setActionMessage({ kind: "ok", text: label });
      return result;
    } catch (e) {
      setActionMessage({ kind: "err", text: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally {
      setActionLoading(null);
    }
  }

  async function stageFile(path: string) {
    if (!workspaceRoot) return;
    try {
      await withAction("Staged", () => invoke("git_stage", { workspaceRoot, path }));
      await refreshStatus();
    } catch { /* message already shown */ }
  }
  async function unstageFile(path: string) {
    if (!workspaceRoot) return;
    try {
      await withAction("Unstaged", () => invoke("git_unstage", { workspaceRoot, path }));
      await refreshStatus();
    } catch { /* message already shown */ }
  }
  async function discardFile(path: string) {
    if (!workspaceRoot) return;
    try {
      await withAction("Discarded", () => invoke("git_discard", { workspaceRoot, path }));
      await refreshStatus();
      if (open?.path === path) setOpen(null);
    } catch { /* message already shown */ }
  }
  async function stageAll() {
    if (!workspaceRoot) return;
    try {
      await withAction("Staged all", () => invoke("git_stage", { workspaceRoot, path: "." }));
      await refreshStatus();
    } catch { /* message already shown */ }
  }
  async function unstageAll() {
    if (!workspaceRoot) return;
    try {
      await withAction("Unstaged all", () => invoke("git_unstage", { workspaceRoot, path: "." }));
      await refreshStatus();
    } catch { /* message already shown */ }
  }

  async function commit() {
    if (!workspaceRoot || !commitMessage.trim() || stagedFiles.length === 0) return;
    setCommitLoading(true);
    try {
      await withAction("Committed", () => invoke("git_commit", { workspaceRoot, message: commitMessage }));
      setCommitMessage("");
      setOpen(null);
      await refreshStatus();
    } catch { /* message already shown */ }
    finally { setCommitLoading(false); }
  }

  async function fetch() {
    if (!workspaceRoot) return;
    try {
      await withAction("Fetched", () => invoke("git_fetch", { workspaceRoot, remote: null }));
      await refreshLog();
    } catch { /* message already shown */ }
  }
  async function pull() {
    if (!workspaceRoot) return;
    try {
      await withAction("Pulled", () => invoke("git_pull", { workspaceRoot }));
      await refreshLog();
      await refreshStatus();
    } catch { /* message already shown */ }
  }
  async function push() {
    if (!workspaceRoot) return;
    try {
      await withAction("Pushed", () => invoke("git_push", { workspaceRoot }));
      await refreshLog();
    } catch { /* message already shown */ }
  }
  async function checkoutBranch(name: string) {
    if (!workspaceRoot || !name || name === log?.branch) {
      setBranchMenuOpen(false);
      return;
    }
    try {
      await withAction(`Switched to ${name}`, () => invoke("git_checkout_branch", { workspaceRoot, branch: name }));
      setBranchMenuOpen(false);
      setOpen(null);
      await refreshLog();
      await refreshStatus();
    } catch { /* message already shown */ }
  }
  async function stashPush() {
    if (!workspaceRoot) return;
    try {
      await withAction("Stashed", () => invoke("git_stash", { workspaceRoot, action: "push", message: "WIP" }));
      await refreshStashes();
      await refreshStatus();
    } catch { /* message already shown */ }
  }
  async function stashPop() {
    if (!workspaceRoot) return;
    try {
      await withAction("Stash popped", () => invoke("git_stash", { workspaceRoot, action: "pop" }));
      await refreshStashes();
      await refreshStatus();
    } catch { /* message already shown */ }
  }

  async function selectPr(n: number) {
    if (!workspaceRoot) return;
    setPrDetailLoading(true);
    try {
      const detail = await invoke<PullRequestDetails>("git_pr_view", { workspaceRoot, number: n });
      setSelectedPr(detail);
    } catch (e) {
      setActionMessage({ kind: "err", text: e instanceof Error ? e.message : String(e) });
      setSelectedPr(null);
    } finally {
      setPrDetailLoading(false);
    }
  }
  async function openPrInBrowser(n: number) {
    if (!workspaceRoot) return;
    try {
      const url = await withAction("Opened in browser", () => invoke<string>("git_pr_open", { workspaceRoot, number: n }));
      void url;
    } catch { /* message already shown */ }
  }
  async function checkoutPr(n: number) {
    if (!workspaceRoot) return;
    try {
      await withAction(`Checked out #${n}`, () => invoke("git_pr_checkout", { workspaceRoot, number: n }));
      await refreshLog();
      await refreshStatus();
      if (selectedPr?.number === n) setSelectedPr(null);
    } catch { /* message already shown */ }
  }
  async function mergePr(n: number) {
    if (!workspaceRoot) return;
    if (!confirm(`Merge PR #${n}?`)) return;
    try {
      await withAction(`Merged #${n}`, () => invoke("git_pr_merge", { workspaceRoot, number: n, method: "merge" }));
      await refreshPrs();
      await refreshLog();
      await refreshStatus();
      if (selectedPr?.number === n) setSelectedPr(null);
    } catch { /* message already shown */ }
  }
  // Inline composer instead of window.prompt() — Tauri's macOS webview returns
  // null from prompt(), so the old flow silently did nothing.
  function createPr() {
    // PR commits only what's staged (the backend no longer `git add -A`s), so
    // require a staged set first — same contract as the commit button.
    if (!workspaceRoot || stagedFiles.length === 0) return;
    setPrComposer({ title: commitMessage || "", body: "" });
  }
  async function submitPr() {
    if (!workspaceRoot || !prComposer || !prComposer.title.trim()) return;
    try {
      const url = await withAction("Pull request created", () =>
        invoke<string>("create_pr", {
          workspaceRoot,
          title: prComposer.title.trim(),
          body: prComposer.body.trim() || null,
        })
      );
      void url;
      setPrComposer(null);
      await refreshPrs();
    } catch { /* message already shown */ }
  }

  // Keyboard shortcuts when the view is open.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "Enter" && commitMessage.trim() && stagedFiles.length > 0) {
        e.preventDefault();
        void commit();
      }
      if (mod && e.shiftKey && e.key === "P") {
        e.preventDefault();
        void createPr();
      }
      if (mod && e.key === "f" && !e.shiftKey) {
        // ⌘F would conflict with the editor find inside diff. Reserved.
      }
      if (e.key === "Escape" && branchMenuOpen) {
        setBranchMenuOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commitMessage, stagedFiles.length, branchMenuOpen, workspaceRoot, commit, createPr]);

  if (!workspaceRoot) {
    return (
      <Center>
        <div style={{ color: "var(--fg-subtle)", fontSize: 13, textAlign: "center" }}>
          <div style={{ color: "var(--fg)", marginBottom: 4, fontWeight: 600 }}>No workspace open</div>
          <div>Open a folder to review its source control.</div>
        </div>
      </Center>
    );
  }
  const reviewRootName = workspaceRoot.split("/").filter(Boolean).pop() ?? workspaceRoot;

  return (
    <div
      className="shell-enter"
      style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, background: "var(--bg)" }}
    >
      {/* Top bar */}
      <div className="glass-chrome" style={{
        height: 56, padding: "0 16px", display: "flex", alignItems: "center", gap: 12,
        position: "relative", zIndex: 2,
      }}>
        <button onClick={onBack} style={{
          width: 28, height: 28, display: "grid", placeItems: "center", borderRadius: "var(--radius-xs)",
          border: "none", background: "transparent", color: "var(--fg-subtle)", cursor: "pointer",
        }} title="Back to workbench">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 6l-6 6 6 6" />
          </svg>
        </button>
        <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
            <span style={{ fontSize: 11, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>Git Review</span>
            <span
              title={workspaceRoot}
              style={{
                maxWidth: 220,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontSize: 10.5,
                color: "var(--fg-subtle)",
                border: "1px solid var(--border)",
                borderRadius: 999,
                padding: "1px 7px",
                background: "var(--bg-elevated)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {reviewRootName}
            </span>
          </div>
          <div style={{ position: "relative" }}>
            <button
              onClick={() => setBranchMenuOpen((v) => !v)}
              style={{
                border: "none", background: "transparent", padding: 0, font: "inherit", cursor: "pointer",
              }}
              title="Switch branch"
            >
              <BranchPill branch={log?.branch ?? reviewStatus?.branch ?? "—"} ahead={log?.ahead ?? 0} behind={log?.behind ?? 0} />
            </button>
            {branchMenuOpen && log && (
              <BranchMenu
                branches={log.branches}
                current={log.branch}
                onSelect={checkoutBranch}
                onClose={() => setBranchMenuOpen(false)}
              />
            )}
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8 }}>
          <input
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void commit(); } }}
            placeholder={stagedFiles.length === 0 ? "Stage changes to commit" : `Commit ${stagedFiles.length} file${stagedFiles.length === 1 ? "" : "s"}…`}
            aria-label="Commit message"
            style={{
              flex: 1, minWidth: 0, height: 32, padding: "0 10px",
              border: "1px solid var(--border)", borderRadius: "var(--radius-sm)",
              background: "var(--bg)", color: "var(--fg-strong)", font: "inherit", outline: "none",
            }}
          />
          <button
            onClick={() => void commit()}
            disabled={!commitMessage.trim() || stagedFiles.length === 0 || commitLoading}
            title={stagedFiles.length === 0 ? "Stage changes before committing" : "Commit staged changes (⌘↩)"}
            style={{
              height: 32, padding: "0 14px", borderRadius: "var(--radius-sm)", fontWeight: 600, fontSize: 12, cursor: "pointer",
              background: commitMessage.trim() && stagedFiles.length > 0 && !commitLoading ? "var(--accent)" : "var(--bg-hover)",
              color: commitMessage.trim() && stagedFiles.length > 0 && !commitLoading ? "#fff" : "var(--fg-subtle)",
              border: "1px solid " + (commitMessage.trim() && stagedFiles.length > 0 && !commitLoading
                ? "color-mix(in srgb, var(--accent) 60%, #000)"
                : "var(--border)"),
              boxShadow: commitMessage.trim() && stagedFiles.length > 0 && !commitLoading
                ? "inset 0 1px 0 rgba(255,255,255,0.20), inset 0 0 0 1px rgba(0,0,0,0.10), 0 1px 2px rgba(0,0,0,0.05)"
                : "none",
              transition: "background var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
            }}
          >
            {commitLoading ? "Committing…" : "Commit"}
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <TopAction onClick={() => void fetch()} disabled={actionLoading === "Fetched"} title="Fetch from all remotes">Fetch</TopAction>
          <TopAction onClick={() => void pull()} disabled={actionLoading === "Pulled"} title="Pull (fast-forward only)">Pull</TopAction>
          <TopAction onClick={() => void push()} disabled={actionLoading === "Pushed"} title="Push to upstream">Push</TopAction>
          <button
            onClick={() => void createPr()}
            disabled={stagedFiles.length === 0}
            title={stagedFiles.length === 0 ? "Stage changes before opening a PR" : "Open a pull request (⌘⇧P)"}
            style={{
              height: 32, padding: "0 12px", borderRadius: "var(--radius-sm)", fontWeight: 600, fontSize: 12,
              cursor: stagedFiles.length === 0 ? "not-allowed" : "pointer",
              background: "transparent", color: stagedFiles.length === 0 ? "var(--fg-subtle)" : "var(--fg-strong)",
              border: "1px solid var(--border)",
              boxShadow: "inset 0 1px 0 var(--panel-highlight)",
              transition: "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
            }}
            onMouseEnter={(e) => { if (stagedFiles.length > 0) e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          >
            Open PR
          </button>
        </div>
      </div>

      {/* Action toast */}
      {actionMessage && (
        <div
          key={actionMessage.text}
          className="glass-toast toast-enter"
          style={{
            padding: "9px 16px", fontSize: 12, fontWeight: 500,
            display: "flex", alignItems: "center", gap: 8,
            color: actionMessage.kind === "ok" ? "var(--fg-strong)" : "var(--danger)",
          }}
        >
          <span
            aria-hidden
            style={{
              width: 6, height: 6, borderRadius: "50%",
              background: actionMessage.kind === "ok" ? "var(--success)" : "var(--danger)",
              boxShadow: actionMessage.kind === "ok"
                ? "0 0 0 3px color-mix(in srgb, var(--success) 18%, transparent)"
                : "0 0 0 3px color-mix(in srgb, var(--danger) 18%, transparent)",
              flexShrink: 0,
            }}
          />
          {actionMessage.text}
        </div>
      )}

      {/* Body — 3 panes */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* Left: files */}
        <div style={{ width: leftWidth, transition: PANE_TRANSITION, display: "flex", flexDirection: "column", minHeight: 0, borderRight: "1px solid var(--border)" }}>
          <SectionHeader title="Staged" count={stagedFiles.length} onAction={unstageAll} actionLabel="Unstage all" />
          <div style={{ overflow: "auto", maxHeight: stagedFiles.length > 0 ? "40%" : 0, minHeight: 0 }}>
            {stagedFiles.map((f) => (
              <FileRow
                key={`s-${f.path}`}
                file={f}
                active={open?.path === f.path && open?.staged === true}
                loading={actionLoading !== null}
                onOpen={(file) => setOpen({ path: file.path, staged: true })}
                onStage={stageFile} onUnstage={unstageFile} onDiscard={discardFile}
              />
            ))}
          </div>
          <SectionHeader title="Changes" count={changedFiles.length} onAction={stageAll} actionLabel="Stage all" />
          <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
            {changedFiles.length === 0 && stagedFiles.length === 0 ? (
              <div style={{ padding: "20px 14px", color: "var(--fg-subtle)", fontSize: 13, textAlign: "center" }}>
                <div style={{ color: "var(--fg)", marginBottom: 4, fontWeight: 600 }}>Working tree clean</div>
                <div>No changes to commit.</div>
              </div>
            ) : (
              changedFiles.map((f) => (
                <FileRow
                  key={`c-${f.path}`}
                  file={f}
                  active={open?.path === f.path && open?.staged === false}
                  loading={actionLoading !== null}
                  onOpen={(file) => setOpen({ path: file.path, staged: false })}
                  onStage={stageFile} onUnstage={unstageFile} onDiscard={discardFile}
                />
              ))
            )}
          </div>
        </div>

        <PaneDivider width={leftWidth} setWidth={setLeftWidth} side="left" min={LEFT_MIN} max={MAX_PANE} />

        {/* Center: diff */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
          {open && (
            <div
              className="pane-inset-top"
              style={{
                height: 36, padding: "0 14px", display: "flex", alignItems: "center", gap: 8,
                borderBottom: "1px solid var(--border)",
                background: "color-mix(in srgb, var(--bg-elevated) 70%, transparent)",
                fontSize: 12, color: "var(--fg-subtle)",
                backdropFilter: "blur(12px) saturate(1.1)",
                WebkitBackdropFilter: "blur(12px) saturate(1.1)",
              }}
            >
              <StatusDot label={statusLabel(reviewStatus?.files.find((f) => f.path === open.path)?.status ?? "")} />
              <span style={{ fontFamily: "var(--font-mono)", color: "var(--fg-strong)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{open.path}</span>
              <span style={{ color: open.staged ? "var(--accent)" : "var(--fg-dim)" }}>{open.staged ? "staged" : "working"}</span>
            </div>
          )}
          <DiffViewer workspaceRoot={workspaceRoot} open={open} onOpen={() => { /* selected via row click */ }} />
        </div>

        <PaneDivider width={rightWidth} setWidth={setRightWidth} side="right" min={RIGHT_MIN} max={MAX_PANE} />

        {/* Right: PRs */}
        <div style={{ width: rightWidth, transition: PANE_TRANSITION, display: "flex", flexDirection: "column", minHeight: 0, borderLeft: "1px solid var(--border)" }}>
          <div
            className="pane-inset-top"
            style={{
              height: 36, padding: "0 12px", display: "flex", alignItems: "center", gap: 8,
              borderBottom: "1px solid var(--border)",
              background: "color-mix(in srgb, var(--bg-elevated) 70%, transparent)",
              color: "var(--fg-subtle)", fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase",
              backdropFilter: "blur(12px) saturate(1.1)",
              WebkitBackdropFilter: "blur(12px) saturate(1.1)",
            }}
          >
            <img src="./github-invertocat.svg" alt="" width={14} height={14} style={{ color: "var(--fg)", flexShrink: 0 }} />
            Pull Requests
            {prs && <span style={{ color: "var(--fg-dim)" }}>{prs.length}</span>}
            <span style={{ flex: 1 }} />
            <button
              onClick={() => void refreshPrs()}
              disabled={prsLoading}
              title="Refresh PRs"
              style={{ ...iconButtonStyle, width: 22, height: 22 }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6v5h-5" /><path d="M4 18v-5h5" />
                <path d="M18.3 9A7 7 0 0 0 6.4 6.4L4 9" /><path d="M5.7 15A7 7 0 0 0 17.6 17.6L20 15" />
              </svg>
            </button>
          </div>
          {prDetailLoading && (
            <div style={{ padding: "8px 14px", color: "var(--fg-subtle)", fontSize: 11 }}>Loading PR…</div>
          )}
          {prError && (
            <div style={{ padding: "10px 14px", color: "var(--danger)", fontSize: 12, lineHeight: 1.4 }}>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>gh unavailable</div>
              <div>{prError}</div>
            </div>
          )}
          {prs && prs.length === 0 && !prError && (
            <div style={{ padding: "20px 14px", color: "var(--fg-subtle)", fontSize: 13, textAlign: "center" }}>
              <img src="./github-invertocat.svg" alt="" width={36} height={36} style={{ color: "var(--fg-dim)", opacity: 0.5, marginBottom: 10 }} />
              <div style={{ color: "var(--fg)", marginBottom: 4, fontWeight: 600 }}>No pull requests</div>
              <div>Open one to start a review.</div>
            </div>
          )}
          <div style={{ flex: 1, overflow: "auto", minHeight: 0, padding: 4 }}>
            {prs?.map((pr) => (
              <PRCard
                key={pr.number}
                pr={pr}
                selected={selectedPr?.number === pr.number}
                onSelect={selectPr}
                onOpen={openPrInBrowser}
                onCheckout={checkoutPr}
                onMerge={mergePr}
              />
            ))}
          </div>
          {selectedPr && (
            <PRDetail
              pr={selectedPr}
              onClose={() => setSelectedPr(null)}
              onOpen={openPrInBrowser}
              onCheckout={checkoutPr}
              onMerge={mergePr}
            />
          )}
        </div>
      </div>

      {/* Bottom: stashes + recent history + last fetch */}
      <div className="glass-chrome-bottom" style={{
        height: 32, padding: "0 16px", display: "flex", alignItems: "center", gap: 16,
        position: "relative", zIndex: 2,
        fontSize: 11, color: "var(--fg-subtle)",
      }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>Stash</span>
          {stashes && stashes.length > 0 ? (
            <>
              <span style={{ color: "var(--fg)", fontFamily: "var(--font-mono)" }}>{stashes.length}</span>
              <button onClick={() => void stashPop()} style={ghostLinkStyle}>Pop</button>
            </>
          ) : (
            <button onClick={() => void stashPush()} style={ghostLinkStyle} title="Stash all working changes">Stash</button>
          )}
        </span>
        <span style={{ width: 1, height: 14, background: "var(--border)" }} />
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0, overflow: "hidden" }}>
          <span style={{ color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>History</span>
          {log && log.commits[0] ? (
            <span style={{ color: "var(--fg)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {log.commits[0].shortHash} · {log.commits[0].subject}
            </span>
          ) : (
            <span style={{ color: "var(--fg-dim)" }}>—</span>
          )}
        </span>
        <span style={{ flex: 1 }} />
        {log?.lastFetchMs && (
          <span style={{ color: "var(--fg-dim)" }} title={new Date(log.lastFetchMs).toLocaleString()}>
            fetched {relativeTime(log.lastFetchMs, nowMs)}
          </span>
        )}
        {logLoading && <span style={{ color: "var(--fg-dim)" }}>refreshing…</span>}
        <span style={{ color: "var(--fg-dim)", fontFamily: "var(--font-mono)" }}>
          {totalAdditions === 0 ? "clean" : `${totalAdditions} change${totalAdditions === 1 ? "" : "s"}`}
        </span>
      </div>
      {prComposer && (
        <div
          onMouseDown={(e) => { if (e.target === e.currentTarget) setPrComposer(null); }}
          style={{
            position: "absolute", inset: 0, zIndex: 20, display: "flex",
            alignItems: "center", justifyContent: "center",
            background: "color-mix(in srgb, var(--bg) 60%, transparent)",
            backdropFilter: "blur(2px)",
          }}
        >
          <div
            className="glass-chrome"
            style={{
              width: 460, maxWidth: "90%", padding: 18, borderRadius: "var(--radius-md)",
              border: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 12,
              boxShadow: "0 12px 40px rgba(0,0,0,0.35)",
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 13, color: "var(--fg-strong)" }}>Open a pull request</div>
            <input
              autoFocus
              value={prComposer.title}
              placeholder="Pull request title"
              onChange={(e) => setPrComposer({ ...prComposer, title: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Escape") setPrComposer(null); }}
              aria-label="Pull request title"
              className="klide-field"
              style={{ height: 36, padding: "0 12px", fontSize: 13 }}
            />
            <textarea
              value={prComposer.body}
              placeholder="Description (optional)"
              onChange={(e) => setPrComposer({ ...prComposer, body: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Escape") setPrComposer(null); }}
              aria-label="Pull request description"
              className="klide-field"
              rows={5}
              style={{ padding: "10px 12px", fontSize: 13, resize: "vertical", fontFamily: "inherit" }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <TopAction onClick={() => setPrComposer(null)} title="Cancel">Cancel</TopAction>
              <button
                onClick={() => void submitPr()}
                disabled={!prComposer.title.trim()}
                title="Create the pull request"
                style={{
                  height: 32, padding: "0 14px", borderRadius: "var(--radius-sm)", fontWeight: 600, fontSize: 12,
                  cursor: prComposer.title.trim() ? "pointer" : "not-allowed",
                  background: prComposer.title.trim() ? "var(--accent)" : "var(--bg-hover)",
                  color: prComposer.title.trim() ? "#fff" : "var(--fg-subtle)",
                  border: "1px solid " + (prComposer.title.trim() ? "color-mix(in srgb, var(--accent) 60%, #000)" : "var(--border)"),
                }}
              >
                Create PR
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TopAction({ onClick, disabled, title, children }: { onClick: () => void; disabled?: boolean; title: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        height: 32, padding: "0 10px", borderRadius: "var(--radius-sm)", cursor: "pointer",
        background: "transparent", color: "var(--fg)",
        border: "1px solid var(--border)", fontWeight: 500, fontSize: 12,
        boxShadow: "inset 0 1px 0 var(--panel-highlight)",
        transition: "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--bg-hover)";
        e.currentTarget.style.borderColor = "var(--border-strong)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.borderColor = "var(--border)";
      }}
    >
      {children}
    </button>
  );
}

const ghostLinkStyle: React.CSSProperties = {
  border: "none", background: "transparent", color: "var(--fg-subtle)", font: "inherit", fontSize: 11,
  padding: "2px 6px", borderRadius: "var(--radius-xs)", cursor: "pointer",
};

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ flex: 1, display: "grid", placeItems: "center", minWidth: 0, minHeight: 0 }}>
      {children}
    </div>
  );
}
