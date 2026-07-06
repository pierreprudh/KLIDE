// Git Review — a full-window surface for source control, branch management,
// and pull requests. Replaces the old floating `GitPanel` as the single
// entry point for staging, committing, syncing, browsing history, and
// managing PRs.
//
// Layout: 3-pane horizontal — files (left), diff (center), PRs (right).
// Top bar carries the branch selector, commit composer, and sync actions.
// A bottom shelf shows stashes and history at a glance.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ThemeId } from "../theme";
import type { GitFile, GitStatus } from "../gitTypes";
import {
  clampDetailPct,
  CommitDetailPane,
  DETAIL_PCT_DEFAULT,
  DETAIL_PCT_KEY,
  GitHistoryGraph,
  type CommitDetails,
} from "./GitHistoryGraph";

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

type PullRequestFilter = "open" | "draft" | "all";

type Props = {
  workspaceRoot: string | null;
  gitStatus: GitStatus | null;
  onRefreshGitStatus: () => Promise<void> | void;
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
const DIFF_RENDER_LIMIT = 1600;

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

function StatusLetter({ label }: { label: string }) {
  return (
    <span
      style={{
        width: "1.2em", flexShrink: 0, textAlign: "center",
        fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 600,
        color: statusColor(label),
      }}
    >
      {label}
    </span>
  );
}

const DiffLine = memo(function DiffLine({ line, index }: { line: string; index: number }) {
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
});

type DiffViewerProps = {
  workspaceRoot: string | null;
  open: OpenFile | null;
};

const DiffViewer = memo(function DiffViewer({ workspaceRoot, open }: DiffViewerProps) {
  const [diff, setDiff] = useState<{ path: string; diff: string; additions: number; deletions: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showFullDiff, setShowFullDiff] = useState(false);
  const lastLoadedRef = useRef<string>("");
  const openPath = open?.path ?? null;
  const openStaged = open?.staged ?? false;

  useEffect(() => {
    if (!workspaceRoot || !openPath) {
      setDiff(null);
      setError(null);
      lastLoadedRef.current = "";
      return;
    }
    const key = `${openPath}::${openStaged ? "staged" : "work"}`;
    if (key === lastLoadedRef.current) return;
    lastLoadedRef.current = key;
    setShowFullDiff(false);
    setLoading(true);
    setError(null);
    let cancelled = false;
    invoke<{ path: string; diff: string; additions: number; deletions: number }>(
      "git_diff",
      { workspaceRoot, path: openPath, staged: openStaged }
    )
      .then((d) => {
        if (!cancelled) setDiff(d);
      })
      .catch((e) => {
        if (cancelled) return;
        setDiff(null);
        setError(e instanceof Error ? e.message : String(e));
        lastLoadedRef.current = "";
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [openPath, openStaged, workspaceRoot]);

  const lines = useMemo(
    () => {
      if (!diff) return [];
      return diff.diff.trim() ? diff.diff.replace(/\n$/, "").split("\n") : ["No diff available."];
    },
    [diff]
  );
  const visibleLines = showFullDiff ? lines : lines.slice(0, DIFF_RENDER_LIMIT);
  const hiddenLines = Math.max(0, lines.length - visibleLines.length);

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
  return (
    <div style={{ flex: 1, overflow: "auto", background: "var(--bg)", padding: "8px 0", fontFamily: "var(--font-mono)" }}>
      {visibleLines.map((line, i) => (
        <DiffLine key={i} line={line} index={i} />
      ))}
      {hiddenLines > 0 && (
        <div style={{ padding: "12px 44px", color: "var(--fg-subtle)", fontSize: 12, borderTop: "1px solid var(--border)" }}>
          {hiddenLines} more lines hidden for smoother scrolling.{" "}
          <button
            type="button"
            onClick={() => setShowFullDiff(true)}
            style={{ border: "none", background: "transparent", color: "var(--accent)", cursor: "pointer", font: "inherit", padding: 0 }}
          >
            Show full diff
          </button>
        </div>
      )}
    </div>
  );
});

function BranchLabel({ branch, ahead, behind }: { branch: string; ahead: number; behind: number }) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--fg-strong)", fontSize: 12, fontWeight: 600 }}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: "var(--fg-subtle)" }}>
        <circle cx="6" cy="5" r="2.3" />
        <circle cx="6" cy="19" r="2.3" />
        <circle cx="18" cy="12" r="2.3" />
        <path d="M6 7.3v9.4" />
        <path d="M8.1 6.2A8.3 8.3 0 0 1 15.8 10" />
      </svg>
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
      <StatusLetter label={label} />
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

function SectionHeader({ title, count, onAction, actionLabel, actionIcon }: {
  title: string; count: number; onAction?: () => void; actionLabel?: string; actionIcon?: React.ReactNode;
}) {
  // Icon-only action, but hover reveals its label inline in the header —
  // the Klide hover-reveal pattern, so the icon never has to be guessed.
  const [hover, setHover] = useState(false);
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
          onClick={onAction}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          style={{
            height: 22, padding: actionIcon ? "0 5px" : "2px 7px",
            display: "inline-flex", alignItems: "center", gap: hover && actionIcon ? 5 : 0,
            fontSize: 10, borderRadius: "var(--radius-xs)", border: "none", cursor: "pointer",
            background: hover ? "var(--bg-hover)" : "transparent",
            color: hover ? "var(--fg-strong)" : "var(--fg-subtle)",
            fontWeight: 500, letterSpacing: "0.03em",
            transition: "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
          }}
        >
          {actionIcon && (
            <span style={{
              maxWidth: hover ? 90 : 0, opacity: hover ? 1 : 0, overflow: "hidden", whiteSpace: "nowrap",
              transition: "max-width var(--motion-med) var(--ease-soft), opacity var(--motion-fast) var(--ease-out)",
            }}>
              {actionLabel}
            </span>
          )}
          {actionIcon ?? actionLabel}
        </button>
      )}
    </div>
  );
}

type PRBadgeProps = { badge: PullRequest["badge"] };
function PRBadge({ badge }: PRBadgeProps) {
  const map: Record<PullRequest["badge"], { color: string; label: string }> = {
    open: { color: "var(--success)", label: "Open" },
    merged: { color: "var(--accent)", label: "Merged" },
    closed: { color: "var(--danger)", label: "Closed" },
    draft: { color: "var(--fg-subtle)", label: "Draft" },
  };
  const m = map[badge];
  return (
    <span
      style={{
        height: 20,
        padding: "0 7px",
        borderRadius: 999,
        display: "inline-flex",
        alignItems: "center",
        border: "1px solid color-mix(in srgb, currentColor 32%, transparent)",
        background: "color-mix(in srgb, currentColor 10%, transparent)",
        fontSize: 10.5,
        fontWeight: 700,
        color: m.color,
      }}
    >
      {m.label}
    </span>
  );
}

function PRMetric({
  value,
  tone,
  label,
}: {
  value: string | number;
  tone?: "good" | "bad";
  label?: string;
}) {
  const color = tone === "good" ? "var(--success)" : tone === "bad" ? "var(--danger)" : "var(--fg-dim)";
  return (
    <span title={label} style={{ color, fontFamily: "var(--font-mono)", fontSize: 11, whiteSpace: "nowrap" }}>
      {value}
    </span>
  );
}

function PRActionButton({
  children,
  onClick,
  primary,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      disabled={disabled}
      title={title}
      style={{
        height: 26,
        padding: "0 9px",
        borderRadius: "var(--radius-sm)",
        border: `1px solid ${primary ? "color-mix(in srgb, var(--accent) 70%, var(--border))" : "var(--border)"}`,
        background: primary ? "var(--accent)" : "var(--bg-elevated)",
        color: primary ? "var(--control-primary-fg)" : "var(--fg)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
        fontSize: 11,
        fontWeight: 650,
        whiteSpace: "nowrap",
        boxShadow: primary ? "inset 0 1px 0 var(--inset-highlight), 0 1px 2px var(--inset-drop)" : "inset 0 1px 0 var(--panel-highlight)",
      }}
    >
      {children}
    </button>
  );
}

function PRBranchLine({ pr }: { pr: Pick<PullRequest, "headRef" | "baseRef" | "author"> }) {
  return (
    <div style={{ minWidth: 0, color: "var(--fg-dim)", fontSize: 11, fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
      {pr.headRef} <span style={{ color: "var(--fg-subtle)" }}>→</span> {pr.baseRef} · {pr.author}
    </div>
  );
}

function mergeabilityLabel(value: string): string {
  if (value === "MERGEABLE") return "No conflicts";
  if (value === "CONFLICTING") return "Conflicts";
  if (value === "UNKNOWN") return "Checking";
  return value.toLowerCase();
}

function PRCard({ pr, selected, nowMs, onSelect, onOpen, onCheckout, onMerge }: {
  pr: PullRequest; selected: boolean;
  nowMs: number;
  onSelect: (n: number) => void;
  onOpen: (n: number) => void;
  onCheckout: (n: number) => void;
  onMerge: (n: number) => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(pr.number)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(pr.number);
        }
      }}
      style={{
        padding: "11px 12px",
        borderRadius: "var(--radius-sm)",
        border: `1px solid ${selected ? "color-mix(in srgb, var(--accent) 46%, var(--border))" : "transparent"}`,
        background: selected ? "color-mix(in srgb, var(--accent-soft) 72%, transparent)" : "transparent",
        cursor: "pointer",
        outline: "none",
        transition: "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
      }}
      onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = "transparent"; }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 7, minWidth: 0 }}>
        <span style={{ color: "var(--fg-dim)", fontSize: 11.5, fontFamily: "var(--font-mono)" }}>#{pr.number}</span>
        <PRBadge badge={pr.badge} />
        {pr.isCurrentBranch && (
          <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--accent)" }}>
            Current
          </span>
        )}
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--fg-dim)", whiteSpace: "nowrap" }}>{relativeTime(pr.updatedAtMs, nowMs)}</span>
      </div>
      <div style={{ color: "var(--fg-strong)", fontSize: 13, lineHeight: 1.35, fontWeight: 500, marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
        {pr.title}
      </div>
      <PRBranchLine pr={pr} />
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 9, minWidth: 0 }}>
        <PRMetric value={`+${pr.additions}`} tone="good" label="Additions" />
        <PRMetric value={`−${pr.deletions}`} tone="bad" label="Deletions" />
        <PRMetric value={`${pr.changedFiles} files`} label="Changed files" />
        <span style={{ flex: 1 }} />
        <PRActionButton title="Open pull request in browser" onClick={() => onOpen(pr.number)}>Open</PRActionButton>
        {!pr.isCurrentBranch && pr.badge === "open" && (
          <PRActionButton title="Checkout pull request locally" onClick={() => onCheckout(pr.number)}>Checkout</PRActionButton>
        )}
        {pr.badge === "open" && (
          <PRActionButton title="Merge pull request" onClick={() => onMerge(pr.number)} primary>Merge</PRActionButton>
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
    <div style={{ borderTop: "1px solid var(--border)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 9, maxHeight: "42%", minHeight: 168, flexShrink: 0, overflow: "auto", background: "color-mix(in srgb, var(--bg-elevated) 62%, transparent)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: "var(--fg-dim)", fontSize: 12, fontFamily: "var(--font-mono)" }}>#{pr.number}</span>
        <PRBadge badge={pr.badge} />
        <span style={{ flex: 1 }} />
        <button onClick={onClose} style={iconButtonStyle} title="Close detail">×</button>
      </div>
      <div style={{ color: "var(--fg-strong)", fontSize: 14, fontWeight: 600, lineHeight: 1.3 }}>{pr.title}</div>
      <PRBranchLine pr={pr} />
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--font-mono)", fontSize: 11 }}>
        <PRMetric value={`+${pr.additions}`} tone="good" label="Additions" />
        <PRMetric value={`−${pr.deletions}`} tone="bad" label="Deletions" />
        <PRMetric value={`${pr.changedFiles} files`} label="Changed files" />
        <span style={{ color: "var(--fg-dim)" }}>·</span>
        <span style={{ color: pr.mergeable === "CONFLICTING" ? "var(--danger)" : "var(--fg-dim)" }}>{mergeabilityLabel(pr.mergeable)}</span>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <PRActionButton title="Open pull request in browser" onClick={() => onOpen(pr.number)}>Open</PRActionButton>
        {!pr.isCurrentBranch && pr.badge === "open" && (
          <PRActionButton title="Checkout pull request locally" onClick={() => onCheckout(pr.number)}>Checkout</PRActionButton>
        )}
        {pr.badge === "open" && (
          <PRActionButton title="Merge pull request" onClick={() => onMerge(pr.number)} primary>Merge</PRActionButton>
        )}
      </div>
      {pr.body && (
        <pre style={{
          font: "inherit", fontSize: 12, lineHeight: 1.55, color: "var(--fg-subtle)",
          whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0, padding: "8px 0 0",
        }}>{pr.body}</pre>
      )}
    </div>
  );
}

function GitHubSummaryCard({
  currentPr,
  currentBranch,
  counts,
  canCreate,
  nowMs,
  onCreate,
  onSelect,
  onOpen,
  onCheckout,
  onMerge,
}: {
  currentPr: PullRequest | null;
  currentBranch: string;
  counts: { open: number; draft: number; all: number };
  canCreate: boolean;
  nowMs: number;
  onCreate: () => void;
  onSelect: (n: number) => void;
  onOpen: (n: number) => void;
  onCheckout: (n: number) => void;
  onMerge: (n: number) => void;
}) {
  return (
    <div style={{ margin: "8px 8px 6px", padding: 12, borderRadius: "var(--radius-md)", border: "1px solid var(--border)", background: "color-mix(in srgb, var(--bg-elevated) 72%, transparent)", boxShadow: "inset 0 1px 0 var(--panel-highlight)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9 }}>
        <div style={{ color: "var(--fg-strong)", fontSize: 12, fontWeight: 700 }}>GitHub</div>
        <span style={{ color: "var(--fg-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{counts.open} open</span>
        {counts.draft > 0 && <span style={{ color: "var(--fg-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{counts.draft} draft</span>}
        <span style={{ flex: 1 }} />
        <PRActionButton title={canCreate ? "Create pull request" : "Stage changes before creating a pull request"} onClick={onCreate} disabled={!canCreate}>New PR</PRActionButton>
      </div>

      {currentPr ? (
        <div
          role="button"
          tabIndex={0}
          onClick={() => onSelect(currentPr.number)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onSelect(currentPr.number);
            }
          }}
          style={{ display: "grid", gap: 7, cursor: "pointer", outline: "none" }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ color: "var(--accent)", fontSize: 11, fontWeight: 700 }}>Current branch</span>
            <span style={{ color: "var(--fg-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>#{currentPr.number}</span>
            <PRBadge badge={currentPr.badge} />
            <span style={{ marginLeft: "auto", color: "var(--fg-dim)", fontSize: 11 }}>{relativeTime(currentPr.updatedAtMs, nowMs)}</span>
          </div>
          <div style={{ color: "var(--fg-strong)", fontSize: 13, lineHeight: 1.35, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{currentPr.title}</div>
          <PRBranchLine pr={currentPr} />
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
            <PRMetric value={`+${currentPr.additions}`} tone="good" label="Additions" />
            <PRMetric value={`−${currentPr.deletions}`} tone="bad" label="Deletions" />
            <PRMetric value={`${currentPr.changedFiles} files`} label="Changed files" />
            <span style={{ flex: 1 }} />
            <PRActionButton title="Open pull request in browser" onClick={() => onOpen(currentPr.number)}>Open</PRActionButton>
            {!currentPr.isCurrentBranch && currentPr.badge === "open" && (
              <PRActionButton title="Checkout pull request locally" onClick={() => onCheckout(currentPr.number)}>Checkout</PRActionButton>
            )}
            {currentPr.badge === "open" && (
              <PRActionButton title="Merge pull request" onClick={() => onMerge(currentPr.number)} primary>Merge</PRActionButton>
            )}
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 4 }}>
          <div style={{ color: "var(--fg-subtle)", fontSize: 11, fontWeight: 700 }}>Current branch</div>
          <div title={currentBranch} style={{ color: "var(--fg-dim)", fontSize: 12, fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {currentBranch || "No branch"} has no linked PR
          </div>
        </div>
      )}
    </div>
  );
}

function PRFilterTabs({
  value,
  counts,
  onChange,
}: {
  value: PullRequestFilter;
  counts: { open: number; draft: number; all: number };
  onChange: (value: PullRequestFilter) => void;
}) {
  const options: { id: PullRequestFilter; label: string; count: number }[] = [
    { id: "open", label: "Open", count: counts.open },
    { id: "draft", label: "Draft", count: counts.draft },
    { id: "all", label: "All", count: counts.all },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4, padding: "0 8px 6px" }}>
      {options.map((option) => {
        const active = value === option.id;
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(option.id)}
            style={{
              height: 28,
              borderRadius: "var(--radius-sm)",
              border: `1px solid ${active ? "color-mix(in srgb, var(--accent) 52%, var(--border))" : "var(--border)"}`,
              background: active ? "var(--accent-soft)" : "transparent",
              color: active ? "var(--accent)" : "var(--fg-subtle)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 700,
            }}
          >
            {option.label} <span style={{ color: active ? "var(--accent)" : "var(--fg-dim)", fontFamily: "var(--font-mono)" }}>{option.count}</span>
          </button>
        );
      })}
    </div>
  );
}

function GitHubPanelState({
  icon,
  title,
  detail,
  tone = "muted",
}: {
  icon?: React.ReactNode;
  title: string;
  detail?: string;
  tone?: "muted" | "danger";
}) {
  return (
    <div style={{ padding: "22px 14px", color: tone === "danger" ? "var(--danger)" : "var(--fg-subtle)", fontSize: 12.5, textAlign: "center", lineHeight: 1.45 }}>
      {icon && <div style={{ display: "grid", placeItems: "center", marginBottom: 10, opacity: tone === "danger" ? 0.85 : 0.55 }}>{icon}</div>}
      <div style={{ color: tone === "danger" ? "var(--danger)" : "var(--fg)", marginBottom: detail ? 4 : 0, fontWeight: 700 }}>{title}</div>
      {detail && <div>{detail}</div>}
    </div>
  );
}

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

export function GitReview({ workspaceRoot, gitStatus, onRefreshGitStatus, theme: _theme }: Props) {
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
  const [prFilter, setPrFilter] = useState<PullRequestFilter>("open");
  const [leftWidth, setLeftWidth] = useState(LEFT_DEFAULT);
  const [rightWidth, setRightWidth] = useState(RIGHT_DEFAULT);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());

  // Commit selection lives here (not in the graph) so the detail pane can
  // span the FULL window width at the bottom — under the file list and the
  // GitHub pane, SourceTree-style — instead of being boxed into the center
  // column. The side panes shrink and scroll when it opens.
  const rootRef = useRef<HTMLDivElement>(null);
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [commitDetail, setCommitDetail] = useState<CommitDetails | null>(null);
  const [detailCollapsed, setDetailCollapsed] = useState(false);
  const [detailPct, setDetailPct] = useState(() => {
    const raw = Number(localStorage.getItem(DETAIL_PCT_KEY));
    return Number.isFinite(raw) && raw > 0 ? clampDetailPct(raw) : DETAIL_PCT_DEFAULT;
  });
  const resizeDetail = useCallback((pct: number) => {
    const next = clampDetailPct(pct);
    setDetailPct(next);
    localStorage.setItem(DETAIL_PCT_KEY, String(next));
  }, []);

  // A newly opened commit always presents fully open — a collapse from an
  // earlier look must not carry over.
  useEffect(() => {
    if (selectedCommit) setDetailCollapsed(false);
  }, [selectedCommit]);

  useEffect(() => {
    if (!workspaceRoot || !selectedCommit) {
      setCommitDetail(null);
      return;
    }
    let cancelled = false;
    invoke<CommitDetails>("git_commit_details", { workspaceRoot, hash: selectedCommit })
      .then((d) => { if (!cancelled) setCommitDetail(d); })
      .catch(() => { if (!cancelled) setCommitDetail(null); });
    return () => { cancelled = true; };
  }, [workspaceRoot, selectedCommit]);

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

  // Read the parent's refresh callback through a ref: App passes an inline
  // arrow, so its identity changes on every App render — and calling it SETS
  // App state. If refreshStatus depended on it directly, the mount effect
  // below would refire on each new identity → refresh → App re-render → new
  // identity → an infinite refetch loop (the "flickering to fetched" bug).
  const onRefreshGitStatusRef = useRef(onRefreshGitStatus);
  useEffect(() => {
    onRefreshGitStatusRef.current = onRefreshGitStatus;
  });

  const refreshStatus = useCallback(async () => {
    if (!workspaceRoot) {
      setLocalStatus(null);
      return;
    }
    try {
      const next = await invoke<GitStatus>("git_status", { workspaceRoot });
      setLocalStatus(next);
      await onRefreshGitStatusRef.current();
    } catch (e) {
      setLocalStatus(null);
      setActionMessage({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    }
  }, [workspaceRoot]);

  useEffect(() => {
    if (workspaceRoot) {
      setOpen(null);
      setSelectedCommit(null);
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

  // No auto-selected diff: the center pane defaults to the history graph
  // (SourceTree-style); a diff shows only when the user picks a file.

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
  const prList = prs ?? [];
  const currentBranchPr = useMemo(
    () => prList.find((pr) => pr.isCurrentBranch) ?? null,
    [prList]
  );
  const prCounts = useMemo(() => ({
    open: prList.filter((pr) => pr.badge === "open").length,
    draft: prList.filter((pr) => pr.badge === "draft").length,
    all: prList.length,
  }), [prList]);
  const visiblePrs = useMemo(() => {
    const filtered = prList.filter((pr) => {
      if (prFilter === "open") return pr.badge === "open";
      if (prFilter === "draft") return pr.badge === "draft";
      return true;
    });
    return filtered.filter((pr) => pr.number !== currentBranchPr?.number);
  }, [currentBranchPr?.number, prFilter, prList]);

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
      await refreshPrs();
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
      await refreshPrs();
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
      await refreshPrs();
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
      ref={rootRef}
      className="shell-enter"
      style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, background: "var(--bg)" }}
    >
      {/* Top bar */}
      <div className="glass-chrome" style={{
        height: 56, padding: "0 16px", display: "flex", alignItems: "center", gap: 12,
        position: "relative", zIndex: 2,
      }}>
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
              <BranchLabel branch={log?.branch ?? reviewStatus?.branch ?? "—"} ahead={log?.ahead ?? 0} behind={log?.behind ?? 0} />
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
              color: commitMessage.trim() && stagedFiles.length > 0 && !commitLoading ? "var(--control-primary-fg)" : "var(--fg-subtle)",
              border: "1px solid " + (commitMessage.trim() && stagedFiles.length > 0 && !commitLoading
                ? "color-mix(in srgb, var(--accent) 60%, var(--inset-ring))"
                : "var(--border)"),
              boxShadow: commitMessage.trim() && stagedFiles.length > 0 && !commitLoading
                ? "inset 0 1px 0 var(--inset-highlight), inset 0 0 0 1px var(--inset-ring), 0 1px 2px var(--inset-drop)"
                : "none",
              transition: "background var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
            }}
          >
            {commitLoading ? "Committing…" : "Commit"}
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <TopAction onClick={() => void fetch()} disabled={actionLoading === "Fetched"} title="Fetch from all remotes" iconOnly>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M20 6v5h-5" /><path d="M4 18v-5h5" />
              <path d="M18.3 9A7 7 0 0 0 6.4 6.4L4 9" /><path d="M5.7 15A7 7 0 0 0 17.6 17.6L20 15" />
            </svg>
          </TopAction>
          <TopAction onClick={() => void pull()} disabled={actionLoading === "Pulled"} title="Pull (fast-forward only)" iconOnly>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 3v13" /><path d="M6 11l6 6 6-6" /><path d="M5 21h14" />
            </svg>
          </TopAction>
          <TopAction onClick={() => void push()} disabled={actionLoading === "Pushed"} title="Push to upstream" iconOnly>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 21V8" /><path d="M6 13l6-6 6 6" /><path d="M5 3h14" />
            </svg>
          </TopAction>
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

      {/* Body — 3 panes. overflow:hidden matters: when the commit detail
          pane below squeezes this row, the side panes' fixed-height content
          (GitHub summary card, empty states) must clip at the row edge
          instead of painting over the detail pane. */}
      <div style={{ flex: 1, display: "flex", minHeight: 0, overflow: "hidden" }}>
        {/* Left: files */}
        <div style={{ width: leftWidth, transition: PANE_TRANSITION, display: "flex", flexDirection: "column", minHeight: 0, borderRight: "1px solid var(--border)", position: "relative" }}>
          {/* Action feedback — floats over the files column only; these are
              file/sync actions, so the message belongs where they happen. */}
          {actionMessage && (
            <div
              key={actionMessage.text}
              className="floating-panel toast-enter"
              style={{
                position: "absolute", top: 8, left: 10, right: 10, zIndex: 3,
                padding: "8px 12px", fontSize: 12, fontWeight: 500, borderRadius: 10,
                display: "flex", alignItems: "center", gap: 8,
                color: actionMessage.kind === "ok" ? "var(--fg-strong)" : "var(--danger)",
              }}
            >
              <span
                aria-hidden
                style={{
                  color: actionMessage.kind === "ok" ? "var(--success)" : "var(--danger)",
                  fontWeight: 600, flexShrink: 0,
                }}
              >
                {actionMessage.kind === "ok" ? "✓" : "×"}
              </span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{actionMessage.text}</span>
            </div>
          )}
          <SectionHeader
            title="Staged"
            count={stagedFiles.length}
            onAction={unstageAll}
            actionLabel="Unstage all"
            actionIcon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d="M5 12h14" /></svg>}
          />
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
          <SectionHeader
            title="Changes"
            count={changedFiles.length}
            onAction={stageAll}
            actionLabel="Stage all"
            actionIcon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d="M12 5v14" /><path d="M5 12h14" /></svg>}
          />
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

        {/* Center: diff for the open file, commit graph otherwise */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
          {open ? (
            <>
              <div
                className="pane-inset-top"
                style={{
                  height: 36, padding: "0 14px", display: "flex", alignItems: "center", gap: 8,
                  borderBottom: "1px solid var(--border)",
                  fontSize: 12, color: "var(--fg-subtle)",
                }}
              >
                <StatusLetter label={statusLabel(reviewStatus?.files.find((f) => f.path === open.path)?.status ?? "")} />
                <span style={{ fontFamily: "var(--font-mono)", color: "var(--fg-strong)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{open.path}</span>
                <span style={{ color: open.staged ? "var(--accent)" : "var(--fg-dim)" }}>{open.staged ? "staged" : "working"}</span>
                <button
                  onClick={() => setOpen(null)}
                  title="Close diff — back to history"
                  style={{ ...iconButtonStyle, width: 22, height: 22 }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                </button>
              </div>
              <DiffViewer workspaceRoot={workspaceRoot} open={open} />
            </>
          ) : (
            <GitHistoryGraph
              workspaceRoot={workspaceRoot}
              refreshToken={log}
              selectedCommit={selectedCommit}
              onSelectCommit={setSelectedCommit}
            />
          )}
        </div>

        <PaneDivider width={rightWidth} setWidth={setRightWidth} side="right" min={RIGHT_MIN} max={MAX_PANE} />

        {/* Right: PRs */}
        <div style={{ width: rightWidth, transition: PANE_TRANSITION, display: "flex", flexDirection: "column", minHeight: 0, borderLeft: "1px solid var(--border)" }}>
          <div
            className="pane-inset-top"
            style={{
              height: 36, padding: "0 12px", display: "flex", alignItems: "center", gap: 8,
              borderBottom: "1px solid var(--border)",
              color: "var(--fg-dim)", fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase",
            }}
          >
            <img src="./github-invertocat.svg" alt="" width={14} height={14} style={{ color: "var(--fg)", flexShrink: 0 }} />
            GitHub
            {prs && <span style={{ color: "var(--fg-dim)" }}>{prs.length}</span>}
            <span style={{ flex: 1 }} />
            <button
              onClick={() => void refreshPrs()}
              disabled={prsLoading}
              title="Refresh GitHub"
              style={{ ...iconButtonStyle, width: 22, height: 22 }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6v5h-5" /><path d="M4 18v-5h5" />
                <path d="M18.3 9A7 7 0 0 0 6.4 6.4L4 9" /><path d="M5.7 15A7 7 0 0 0 17.6 17.6L20 15" />
              </svg>
            </button>
          </div>
          <GitHubSummaryCard
            currentPr={currentBranchPr}
            currentBranch={log?.branch ?? reviewStatus?.branch ?? ""}
            counts={prCounts}
            canCreate={stagedFiles.length > 0}
            nowMs={nowMs}
            onCreate={createPr}
            onSelect={selectPr}
            onOpen={openPrInBrowser}
            onCheckout={checkoutPr}
            onMerge={mergePr}
          />
          <PRFilterTabs value={prFilter} counts={prCounts} onChange={setPrFilter} />
          {prDetailLoading && (
            <div style={{ padding: "6px 14px", color: "var(--fg-subtle)", fontSize: 11 }}>Loading PR…</div>
          )}
          {prError && (
            <GitHubPanelState
              tone="danger"
              title="GitHub unavailable"
              detail={prError}
              icon={<img src="./github-invertocat.svg" alt="" width={30} height={30} />}
            />
          )}
          {prs && prs.length === 0 && !prError && !prsLoading && (
            <GitHubPanelState
              title="No pull requests"
              detail={stagedFiles.length > 0 ? "Ready to open one from staged changes." : "Stage changes to create one from here."}
              icon={<img src="./github-invertocat.svg" alt="" width={34} height={34} />}
            />
          )}
          <div style={{ flex: 1, overflow: "auto", minHeight: 0, padding: 4 }}>
            {prsLoading && !prError && (
              <GitHubPanelState title="Loading GitHub" detail="Refreshing pull requests." />
            )}
            {!prsLoading && !prError && prs && prs.length > 0 && visiblePrs.length === 0 && (
              <GitHubPanelState title={prFilter === "all" ? "No pull requests" : `No ${prFilter} pull requests`} />
            )}
            {visiblePrs.map((pr) => (
              <PRCard
                key={pr.number}
                pr={pr}
                nowMs={nowMs}
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

      {/* Full-width commit detail — spans under all three panes, so the
          file list and GitHub pane shrink and scroll while it's open. */}
      {commitDetail && (
        <CommitDetailPane
          detail={commitDetail}
          heightPct={detailPct}
          collapsed={detailCollapsed}
          containerRef={rootRef}
          onResize={resizeDetail}
          onToggleCollapsed={() => setDetailCollapsed((v) => !v)}
          onClose={() => setSelectedCommit(null)}
        />
      )}

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
              boxShadow: "var(--panel-shadow)",
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
                  color: prComposer.title.trim() ? "var(--control-primary-fg)" : "var(--fg-subtle)",
                  border: "1px solid " + (prComposer.title.trim() ? "color-mix(in srgb, var(--accent) 60%, var(--inset-ring))" : "var(--border)"),
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

function TopAction({ onClick, disabled, title, iconOnly, children }: { onClick: () => void; disabled?: boolean; title: string; iconOnly?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      style={{
        height: 32, padding: iconOnly ? 0 : "0 10px", width: iconOnly ? 32 : undefined,
        display: iconOnly ? "grid" : undefined, placeItems: iconOnly ? "center" : undefined,
        borderRadius: "var(--radius-sm)", cursor: "pointer",
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
