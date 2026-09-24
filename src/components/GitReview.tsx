import type { GitDestination } from "../gitNavigation";
// Git Review — a full-window surface for source control, branch management,
// and pull requests. Replaces the old floating `GitPanel` as the single
// entry point for staging, committing, syncing, browsing history, and
// managing PRs.
//
// Layout: 3-pane horizontal — files (left), diff (center), PRs (right).
// The header is a plain typographic row — project name, branch, the commit
// composer (only while there is something to commit), and sync actions. No
// bottom shelf: stashes live at the foot of the files pane, the last fetch
// time sits beside the branch. History is the graph itself.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { relativeTimeLong } from "../time";
import { errMessage } from "../errors";
import type { ThemeId } from "../theme";
import type { GitFile, GitStatus } from "../gitTypes";
import { UNNAMED_GIT_STATUS, gitStatusMark } from "../gitStatusMark";
import {
  clampDetailPct,
  CommitDetailPane,
  DETAIL_PCT_DEFAULT,
  DETAIL_PCT_KEY,
  GitHistoryGraph,
} from "./GitHistoryGraph";
import { parseDiffBlocks, DiffView } from "./diffView";
import {
  formatDiffComment,
  sendTextToDelegatePty,
  type DiffLineComment,
} from "../diffComments";
import { notify } from "../toast";
import { listLiveDelegateSessions } from "../ipc/delegatePty";
import {
  checkoutBranchOutcome,
  checkoutPrOutcome,
  commitOutcome,
  discardFileOutcome,
  fetchOutcome,
  mergePrOutcome,
  mergePrTimeline,
  openPrInBrowserOutcome,
  prCounts as derivePrCounts,
  pullOutcome,
  pushOutcome,
  splitStatusFiles,
  stageAllOutcome,
  stageFileOutcome,
  stashPopOutcome,
  stashPushOutcome,
  submitPrOutcome,
  unstageAllOutcome,
  unstageFileOutcome,
  visiblePrs as deriveVisiblePrs,
  type GitActionOutcome,
  type GitReviewRefresh,
  type PullRequestFilter,
  branchDisplay,
  mergeBranchesForMenu,
} from "../gitReview";
import {
  createPr as createPrRequest,
  gitCheckoutBranch,
  gitCommit,
  gitCommitDetails,
  gitDiff,
  gitDiscard,
  gitFetch,
  gitLog,
  gitPrCheckout,
  gitPrList,
  gitPrMerge,
  gitPrOpen,
  gitPrView,
  gitPull,
  gitPush,
  gitStage,
  gitStash,
  gitStashList,
  gitStatus as fetchGitStatus,
  gitUnstage,
  type CommitDetails,
  type GitBranch,
  type GitTag,
  type GitLog,
  type GitStash,
  type PullRequest,
  type PullRequestDetails,
} from "../ipc/git";
import { renderMarkdown } from "./markdown";
import { KlideMark, ProviderLogo } from "./ai/icons";
import { SearchIcon } from "../icons";
import { useFlipIndicator } from "../hooks/useFlipIndicator";

type Props = {
  initialPr?: GitDestination | null;
  workspaceRoot: string | null;
  gitStatus: GitStatus | null;
  onRefreshGitStatus: () => Promise<void> | void;
  theme: ThemeId;
};

type OpenFile = { path: string; staged: boolean };

// Sub-pane widths live in the parent state so the user can resize and
// we keep both halves animated with the workbench resize transition.
// The history graph is the centre pane and takes whatever the two side
// panes leave, so their defaults are what decides how much of it you see.
// Both start narrow — a file list and a PR list are both narrow things —
// and the graph keeps the rest until you drag a divider.
const LEFT_DEFAULT = 260;
const RIGHT_DEFAULT = 320;
const LEFT_MIN = 220;
const RIGHT_MIN = 260;
const MAX_PANE = 720;
const PANE_TRANSITION = "width var(--motion-med) var(--ease-soft)";
const DIFF_RENDER_LIMIT = 1600;


function splitPath(path: string) {
  const parts = path.split("/");
  const name = parts.pop() ?? path;
  return { name, folder: parts.join("/") };
}

function StatusLetter({ status }: { status: string }) {
  const mark = gitStatusMark(status) ?? UNNAMED_GIT_STATUS;
  return (
    <span className="klide-file-row-mark" title={mark.title} style={{ color: mark.color }}>
      {mark.label}
    </span>
  );
}

type DiffViewerProps = {
  workspaceRoot: string | null;
  open: OpenFile | null;
};

const DiffViewer = memo(function DiffViewer({ workspaceRoot, open }: DiffViewerProps) {
  const [diff, setDiff] = useState<{ path: string; diff: string; additions: number; deletions: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openPath = open?.path ?? null;
  const openStaged = open?.staged ?? false;
  const diffKey = `${openPath ?? ""}::${openStaged ? "staged" : "work"}`;

  // Every effect run fetches; the per-run `cancelled` flag drops a stale
  // result instead of applying it. Deliberately NO ref-based "already loaded"
  // dedupe here: under StrictMode's double-invoked dev effects, run A gets
  // cancelled after claiming the key and run B early-returns on it — leaving
  // "Loading diff…" on screen forever (the HAIKU.md bug).
  useEffect(() => {
    if (!workspaceRoot || !openPath) {
      setDiff(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    let cancelled = false;
    gitDiff(workspaceRoot, openPath, openStaged)
      .then((d) => {
        if (!cancelled) setDiff(d);
      })
      .catch((e) => {
        if (cancelled) return;
        setDiff(null);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [openPath, openStaged, workspaceRoot]);

  const blocks = useMemo(() => {
    if (!diff || !diff.diff.trim()) return [];
    const parsed = parseDiffBlocks(diff.diff.replace(/\n$/, "").split("\n"));
    // A single-file diff may arrive without its `diff --git` header — line
    // comments anchor to the nearest file block, so guarantee one.
    if (parsed.length > 0 && parsed[0].kind !== "file") {
      parsed.unshift({ kind: "file", path: diff.path });
    }
    return parsed;
  }, [diff]);

  // Diff Comment → Agent: route a line comment to the live delegate session
  // working this checkout; without one, the contract goes to the clipboard so
  // it can be pasted into any agent (or the AI panel).
  const sendLineComment = useCallback(
    async (comment: DiffLineComment) => {
      const text = formatDiffComment(comment);
      try {
        const live = await listLiveDelegateSessions();
        const exact = live.find((s) => s.cwd === workspaceRoot);
        const target = exact ?? live.find((s) => !s.cwd) ?? null;
        if (target) {
          await sendTextToDelegatePty(target.sessionId, text);
          notify(`Review comment sent to ${target.provider}.`);
          return;
        }
      } catch {
        // Outside Tauri or command unavailable — fall through to clipboard.
      }
      try {
        await navigator.clipboard.writeText(text);
        notify("No live agent here — review comment copied to the clipboard.");
      } catch {
        notify("Couldn't deliver the review comment.", { tone: "error" });
      }
    },
    [workspaceRoot]
  );

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
  if (blocks.length === 0) {
    return (
      <div style={{ flex: 1, display: "grid", placeItems: "center", color: "var(--fg-subtle)", fontSize: 13 }}>
        No diff available.
      </div>
    );
  }
  return (
    <div style={{ flex: 1, overflow: "auto", background: "var(--bg)", padding: "8px 0" }}>
      <DiffView
        key={diffKey}
        blocks={blocks}
        limit={DIFF_RENDER_LIMIT}
        onLineComment={(c) => void sendLineComment(c)}
        commentActionLabel="Send to agent"
      />
    </div>
  );
});

function BranchLabel({ branch, ahead, behind }: { branch: string; ahead: number; behind: number }) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--fg-strong)", fontSize: 13 }}>
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
  const mark = gitStatusMark(file.status) ?? UNNAMED_GIT_STATUS;
  const [hovered, setHovered] = useState(false);
  return (
    <div
      // Chrome — fills, radius, ellipsis, the action reveal — comes from
      // .klide-file-row, the same recipe the Explorer tree uses. Only this
      // list's own columns and density are set here.
      className="klide-file-row"
      data-active={active}
      onClick={() => onOpen(file)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      // Rows sit one step in from their section header (10px) so the list
      // reads as header → children, not a flat column.
      style={{ gridTemplateColumns: "1fr auto", gap: 8, padding: "5px 10px 5px 18px", fontSize: 13 }}
    >
      {/* No status letter: the name itself wears the status colour (warning
          for modified, success for new, danger for deleted). The word stays
          in the tooltip for anyone who needs it spelled out. */}
      <div style={{ minWidth: 0 }}>
        <div className="klide-file-row-name" title={mark.title} style={{ color: mark.color }}>{name}</div>
        {/* The folder whispers under the name, set one step further in —
            quieter than the Explorer's shared sub style, since here the
            status-coloured name is the point. Hovering the row brings it up. */}
        {folder && (
          <div
            className="klide-file-row-sub"
            style={{ paddingLeft: 8, opacity: hovered || active ? 1 : 0.55, transition: "opacity var(--motion-fast) var(--ease-out)" }}
          >
            {folder}
          </div>
        )}
      </div>
      <div className="klide-file-row-actions">
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

function SectionHeader({ title, count, spaced, onAction, actionLabel, actionIcon }: {
  title: string; count: number; spaced?: boolean; onAction?: () => void; actionLabel?: string; actionIcon?: React.ReactNode;
}) {
  // Icon-only action, but hover reveals its label inline in the header —
  // the Klide hover-reveal pattern, so the icon never has to be guessed.
  const [hover, setHover] = useState(false);
  return (
    <div style={{
      height: 28, marginTop: spaced ? 14 : 0, padding: "0 10px", display: "flex", alignItems: "center", gap: 6,
      color: "var(--fg-subtle)", fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase",
    }}>
      <span style={{ color: "var(--fg)" }}>{title}</span>
      {/* An empty section says its name and nothing else — a "0" is noise. */}
      {count > 0 && <span style={{ color: "var(--fg-dim)" }}>{count}</span>}
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

const PR_STATUS: Record<PullRequest["badge"], { color: string; label: string }> = {
  open: { color: "var(--success)", label: "Open" },
  merged: { color: "var(--accent)", label: "Merged" },
  closed: { color: "var(--danger)", label: "Closed" },
  draft: { color: "var(--fg-subtle)", label: "Draft" },
};

// Status reads as a quiet colored word, not a pill — chips/dots are off-brand
// here. The colour carries the state; the type stays flat and hairline-clean.
type PRBadgeProps = { badge: PullRequest["badge"] };
function PRBadge({ badge }: PRBadgeProps) {
  const m = PR_STATUS[badge];
  return (
    <span style={{ color: m.color, fontSize: 11.5, fontWeight: 600, letterSpacing: "-0.01em", whiteSpace: "nowrap" }}>
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

// Small line-icons so counts read as glyphs, not sentences. currentColor keeps
// them tinting with whatever text colour the row sets.
function GlyphFile() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z" />
    </svg>
  );
}
function GlyphCommitNode() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3.5" />
      <path d="M3 12h5.5" /><path d="M15.5 12H21" />
    </svg>
  );
}
function GlyphAlert() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <path d="M12 9v4" /><path d="M12 17h.01" />
    </svg>
  );
}

// GitHub logins resolve straight to a profile picture — github.com/<login>.png,
// no API/auth. Falls back to an initial disc if the image 404s.
function GhAvatar({ login, size = 18 }: { login: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const ring = { boxShadow: "0 0 0 1.5px var(--bg-elevated)" };
  if (failed) {
    return (
      <span
        title={login}
        style={{
          width: size, height: size, borderRadius: "50%", flexShrink: 0,
          display: "grid", placeItems: "center",
          background: "var(--bg-hover)", color: "var(--fg-subtle)",
          fontSize: Math.max(8, size * 0.5), fontWeight: 600, ...ring,
        }}
      >
        {(login[0] ?? "?").toUpperCase()}
      </span>
    );
  }
  return (
    <img
      src={`https://github.com/${login}.png?size=64`}
      alt={login}
      title={login}
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
      style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0, ...ring }}
    />
  );
}

// Overlapping avatar stack + "Commented" — who weighed in, at a glance.
function CommenterStack({ authors }: { authors: string[] }) {
  const shown = authors.slice(0, 3);
  const title = authors.length > 3 ? `${authors.slice(0, 3).join(", ")} +${authors.length - 3} more` : authors.join(", ");
  return (
    <span title={title} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ display: "inline-flex" }}>
        {shown.map((login, i) => (
          <span key={login} style={{ marginLeft: i === 0 ? 0 : -6, zIndex: shown.length - i, display: "inline-flex" }}>
            <GhAvatar login={login} />
          </span>
        ))}
      </span>
      <span style={{ color: "var(--fg-subtle)", fontSize: 11.5 }}>Commented</span>
    </span>
  );
}

function GlyphMetric({ icon, value, title, highlight }: { icon: React.ReactNode; value: number; title: string; highlight?: boolean }) {
  return (
    <span
      title={title}
      style={{
        display: "inline-flex", alignItems: "center", gap: 4,
        color: highlight ? "var(--fg-subtle)" : "var(--fg-dim)",
        fontFamily: "var(--font-mono)", fontSize: 11, whiteSpace: "nowrap",
      }}
    >
      {icon}
      {value}
    </span>
  );
}

// Bare "open on GitHub" glyph — no container, no hover fill; just the mark,
// brightening on hover. The link out shouldn't compete with the Merge CTA.
function PRGithubLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      title="Open on GitHub"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--fg-strong)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-subtle)"; }}
      style={{
        display: "inline-grid", placeItems: "center",
        padding: 0, border: "none", background: "transparent",
        color: "var(--fg-subtle)", cursor: "pointer",
        transition: "color var(--motion-fast) var(--ease-out)",
      }}
    >
      <svg width={15} height={15} viewBox="0 0 16 16" fill="currentColor" aria-hidden>
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
      </svg>
    </button>
  );
}

// Bare "check out locally" glyph — a git-branch mark, same quiet icon treatment
// as the GitHub link so it doesn't compete with Merge.
function PRCheckoutLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      title="Check out branch locally"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--fg-strong)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-subtle)"; }}
      style={{
        display: "inline-grid", placeItems: "center",
        padding: 0, border: "none", background: "transparent",
        color: "var(--fg-subtle)", cursor: "pointer",
        transition: "color var(--motion-fast) var(--ease-out)",
      }}
    >
      <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <line x1="6" y1="3" x2="6" y2="15" />
        <circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" />
        <path d="M18 9a9 9 0 0 1-9 9" />
      </svg>
    </button>
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
      onMouseEnter={(e) => {
        if (disabled) return;
        // Primary is a real button (fill lifts a touch toward the foreground,
        // hue kept — --accent-hover isn't themed everywhere and would flash the
        // root sage); ghost is bare text (colour only).
        if (primary) e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 90%, var(--fg-strong))";
        else e.currentTarget.style.color = "var(--fg-strong)";
      }}
      onMouseLeave={(e) => {
        if (primary) e.currentTarget.style.background = "var(--accent)";
        else e.currentTarget.style.color = "var(--fg-subtle)";
      }}
      style={{
        height: 24,
        padding: primary ? "0 10px" : "0 4px",
        borderRadius: "var(--radius-sm)",
        border: "1px solid transparent",
        background: primary ? "var(--accent)" : "transparent",
        color: primary ? "var(--control-primary-fg)" : "var(--fg-subtle)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.4 : 1,
        fontSize: 11.5,
        fontWeight: primary ? 600 : 550,
        whiteSpace: "nowrap",
        transition: "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
      }}
    >
      {children}
    </button>
  );
}

function PRBranchLine({ pr }: { pr: Pick<PullRequest, "headRef" | "baseRef"> }) {
  return (
    <div style={{ minWidth: 0, color: "var(--fg-dim)", fontSize: 11, fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
      {pr.headRef}<span style={{ color: "var(--fg-subtle)", margin: "0 6px" }}>→</span>{pr.baseRef}
    </div>
  );
}

// A big number over a quiet uppercase label — the fintech-card hierarchy: the
// value leads, the caption whispers.
function HeroStat({ value, label, tone }: { value: string | number; label: string; tone?: "good" | "bad" }) {
  const color = tone === "good" ? "var(--success)" : tone === "bad" ? "var(--danger)" : "var(--fg-strong)";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
      <span style={{ fontSize: 21, fontWeight: 600, fontFamily: "var(--font-mono)", color, lineHeight: 1, letterSpacing: "-0.02em" }}>{value}</span>
      <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: "0.09em", textTransform: "uppercase", color: "var(--fg-dim)" }}>{label}</span>
    </div>
  );
}

// Premium "opened" header — the reference fintech card translated to KIDE's
// brand: an uppercase eyebrow, the title as the hero, then big diff stats with
// whispered captions. Status stays type-only (no pills), spacing does the work.
function PRHero({ pr, canCheckout, canMerge, onOpen, onCheckout, onMerge }: {
  pr: PullRequest;
  canCheckout: boolean;
  canMerge: boolean;
  onOpen: (n: number) => void;
  onCheckout: (n: number) => void;
  onMerge: (n: number) => void;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 9, marginBottom: 11, minWidth: 0 }}>
        <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.09em", textTransform: "uppercase", color: "var(--fg-dim)" }}>Pull request</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--fg-subtle)" }}>#{pr.number}</span>
        {pr.badge !== "open" && <PRBadge badge={pr.badge} />}
        <span style={{ flex: 1 }} />
        <PRGithubLink onClick={() => onOpen(pr.number)} />
      </div>
      <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.3, color: "var(--fg-strong)", marginBottom: 7, letterSpacing: "-0.01em" }}>{pr.title}</div>
      <PRBranchLine pr={pr} />
      <div style={{ display: "flex", gap: 26, marginTop: 18, flexWrap: "wrap" }}>
        <HeroStat value={`+${pr.additions}`} label="Added" tone="good" />
        <HeroStat value={`−${pr.deletions}`} label="Removed" tone="bad" />
        <HeroStat value={pr.changedFiles} label="Files" />
        <HeroStat value={pr.comments} label="Comments" />
      </div>
      {(canCheckout || canMerge) && (
        <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10, marginTop: 16 }}>
          {canCheckout && <PRCheckoutLink onClick={() => onCheckout(pr.number)} />}
          {canMerge && <PRActionButton title="Merge pull request" onClick={() => onMerge(pr.number)} primary>Merge</PRActionButton>}
        </div>
      )}
    </div>
  );
}


function PRCard({ pr, selected, detail, detailLoading, nowMs, onSelect, onOpen, onCheckout, onMerge }: {
  pr: PullRequest; selected: boolean;
  detail: PullRequestDetails | null;
  detailLoading: boolean;
  nowMs: number;
  onSelect: (n: number) => void;
  onOpen: (n: number) => void;
  onCheckout: (n: number) => void;
  onMerge: (n: number) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const canCheckout = !pr.isCurrentBranch && pr.badge === "open";
  const canMerge = pr.badge === "open";
  const lift = hovered && !selected;
  const current = pr.isCurrentBranch;
  // Highlight, not colour: selected reads as a brighter, lifted surface (solid
  // elevated + inset sheen + ring), current branch as a glossy sheen, and the
  // rest as plain translucent cards. No accent wash anywhere.
  const border = selected || current || lift ? "var(--border-strong)" : "var(--border)";
  const background = selected
    ? "var(--bg-elevated)"
    : current
      ? "linear-gradient(180deg, color-mix(in srgb, var(--fg-strong) 7%, var(--bg-elevated)), var(--bg-elevated) 62%)"
      : "color-mix(in srgb, var(--bg-elevated) 82%, transparent)";
  const boxShadow = selected
    ? "0 0 0 1px var(--border-strong), var(--shadow-raised), inset 0 1px 0 var(--panel-highlight)"
    : current
      ? "var(--shadow-raised), inset 0 1px 0 var(--panel-highlight)"
      : lift ? "var(--shadow-raised)" : "none";
  return (
    <div
      data-pr-number={pr.number}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(pr.number)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(pr.number);
        }
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: selected ? 16 : "11px 12px",
        borderRadius: selected ? "var(--radius-lg)" : "var(--radius-md)",
        border: `1px solid ${border}`,
        // Translucent elevated surface — layered depth without literal frost
        // (backdrop-filter breaks high-z panels in the webview).
        background,
        boxShadow,
        transform: lift ? "translateY(-1px)" : "translateY(0)",
        cursor: "pointer",
        outline: "none",
        transition: "border-color 160ms var(--ease-out), background 160ms var(--ease-out), box-shadow 160ms var(--ease-out), transform 160ms var(--ease-out), padding 160ms var(--ease-out)",
      }}
    >
      {selected ? (
        // Opened: the premium fintech-style hero, then the conversation timeline.
        <>
          <PRHero pr={pr} canCheckout={canCheckout} canMerge={canMerge} onOpen={onOpen} onCheckout={onCheckout} onMerge={onMerge} />
          <PRExpandedDetail detail={detail} loading={detailLoading} nowMs={nowMs} />
        </>
      ) : (
        // Resting: the compact list row.
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, minWidth: 0 }}>
            <span style={{ color: "var(--fg-dim)", fontSize: 11.5, fontFamily: "var(--font-mono)" }}>#{pr.number}</span>
            {pr.badge !== "open" && <PRBadge badge={pr.badge} />}
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: "var(--fg-dim)", whiteSpace: "nowrap" }}>{relativeTimeLong(pr.updatedAtMs, nowMs)}</span>
          </div>
          <div style={{ color: "var(--fg-strong)", fontSize: 13, lineHeight: 1.4, fontWeight: 500, marginBottom: 3, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
            {pr.title}
          </div>
          <PRBranchLine pr={pr} />
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 10, minWidth: 0, minHeight: 24 }}>
            {/* Metrics yield first: when the card is narrow they clip, so the
                actions never get pushed past the card edge. */}
            <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0, overflow: "hidden" }}>
              <PRMetric value={`+${pr.additions}`} tone="good" label="Additions" />
              <PRMetric value={`−${pr.deletions}`} tone="bad" label="Deletions" />
              <GlyphMetric icon={<GlyphFile />} value={pr.changedFiles} title="Changed files" />
            </div>
            <div style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
              <PRGithubLink onClick={() => onOpen(pr.number)} />
              {canCheckout && (
                // At rest the GitHub mark hugs Merge; on hover the checkout glyph
                // slides in between them (width 0 → glyph + gap). The metrics
                // group beside us clips, so the slide never pushes past the card.
                <span
                  aria-hidden={!hovered}
                  style={{
                    display: "grid", justifyContent: "end", alignItems: "center",
                    width: hovered ? 15 + 12 : 0,
                    overflow: "hidden",
                    opacity: hovered ? 1 : 0,
                    transition: "width 160ms var(--ease-out), opacity var(--motion-fast) var(--ease-out)",
                  }}
                >
                  <PRCheckoutLink onClick={() => onCheckout(pr.number)} />
                </span>
              )}
              {canMerge && (
                <span style={{ marginLeft: 12, display: "inline-grid" }}>
                  <PRActionButton title="Merge pull request" onClick={() => onMerge(pr.number)} primary>Merge</PRActionButton>
                </span>
              )}
            </div>
          </div>
          {pr.commentAuthors.length > 0 && (
            <div style={{ marginTop: 9 }}>
              <CommenterStack authors={pr.commentAuthors} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

// One row of the conversation timeline: a node (avatar / commit glyph) at the
// top of a fixed gutter, with a connector that drops from *below* the node to
// the next row — so the rail visibly stops around each node instead of running
// through it. `last` omits the trailing connector.
const TL_NODE_TOP = 3;
const TL_NODE = 20;
const TL_GAP = 6;
const TL_ROW_GAP = 14;
function TimelineRow({ node, children, last }: { node: React.ReactNode; children: React.ReactNode; last?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
      <div style={{ width: 22, flexShrink: 0, position: "relative", alignSelf: "stretch" }}>
        {!last && (
          <span
            aria-hidden
            style={{
              position: "absolute", left: 10, width: 1, background: "var(--border)",
              // Start below this node and stop above the next one, so there's a
              // gap around BOTH ends of the connector, not just the bottom.
              top: TL_NODE_TOP + TL_NODE + TL_GAP,
              bottom: -(TL_ROW_GAP + TL_NODE_TOP - TL_GAP),
            }}
          />
        )}
        <div style={{ position: "absolute", top: TL_NODE_TOP, left: "50%", transform: "translateX(-50%)" }}>{node}</div>
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>{children}</div>
    </div>
  );
}

// A small commit node — sits on the rail like GitHub's commit dots.
function CommitNode() {
  return (
    <span
      style={{
        width: 20, height: 20, borderRadius: "50%", flexShrink: 0,
        display: "grid", placeItems: "center",
        background: "var(--bg-elevated)", border: "1px solid var(--border)",
        color: "var(--fg-subtle)",
      }}
    >
      <GlyphCommitNode />
    </span>
  );
}

// A comment/description as a flat hairline "note card" — the header bar carries
// who + when, the body holds markdown. Cards make the human replies stand out
// from the thin commit rows without any heavy chrome.
function TimelineCard({ author, action, at, nowMs, children }: {
  author: string; action: string; at: number; nowMs: number; children: React.ReactNode;
}) {
  return (
    <div style={{ minWidth: 0, border: "1px solid var(--border)", borderRadius: "var(--radius-md)", background: "color-mix(in srgb, var(--bg-elevated) 55%, transparent)", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6, padding: "7px 11px", borderBottom: "1px solid var(--border)", background: "color-mix(in srgb, var(--bg-hover) 45%, transparent)" }}>
        <span style={{ fontSize: 12, fontWeight: 650, color: "var(--fg-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{author}</span>
        <span style={{ fontSize: 11.5, color: "var(--fg-subtle)" }}>{action}</span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--fg-dim)", whiteSpace: "nowrap" }}>{relativeTimeLong(at, nowMs)}</span>
      </div>
      {/* minWidth:0 lets code blocks scroll internally; wrapping catches long
          tokens/URLs so the card never widens past the pane and spills off-screen. */}
      <div style={{ minWidth: 0, padding: "9px 11px", fontSize: 12.5, lineHeight: 1.6, color: "var(--fg)", overflowWrap: "anywhere", wordBreak: "break-word" }}>{children}</div>
    </div>
  );
}

// GitHub-style conversation: the opening description, then commits + comments
// interleaved in time, threaded on a single rail.
function PRTimeline({ detail, nowMs }: { detail: PullRequestDetails; nowMs: number }) {
  const events = useMemo(() => mergePrTimeline(detail), [detail]);
  const body = detail.body?.trim();
  return (
    <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: TL_ROW_GAP }}>
      {/* Opening = the PR description. */}
      <TimelineRow node={<GhAvatar login={detail.author} size={20} />} last={events.length === 0}>
        <TimelineCard author={detail.author} action="opened" at={detail.createdAtMs} nowMs={nowMs}>
          {body ? renderMarkdown(body) : <span style={{ color: "var(--fg-subtle)", fontStyle: "italic" }}>No description</span>}
        </TimelineCard>
      </TimelineRow>
      {events.map((e, i) =>
        e.kind === "commit" ? (
          <TimelineRow key={`c${i}`} node={<CommitNode />} last={i === events.length - 1}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, minHeight: 20 }}>
              <span title={e.commit.headline} style={{ flex: 1, minWidth: 0, fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--fg-subtle)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {e.commit.headline}
              </span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-dim)", flexShrink: 0 }}>{e.commit.shortHash}</span>
            </div>
          </TimelineRow>
        ) : (
          <TimelineRow key={`m${i}`} node={<GhAvatar login={e.comment.author} size={20} />} last={i === events.length - 1}>
            <TimelineCard author={e.comment.author} action="commented" at={e.comment.createdAtMs} nowMs={nowMs}>
              {renderMarkdown(e.comment.body)}
            </TimelineCard>
          </TimelineRow>
        )
      )}
    </div>
  );
}

// Inline body — the PR conversation timeline, rendered as markdown.
// Mounts inside the expanded card; fades/slides in so opening feels smooth.
// Collapsed height for a freshly opened PR — a few lines, then "Show more".
const PR_DETAIL_PEEK = 104;
// Expanded cap — past this the body scrolls in place instead of stretching
// the card down the whole list.
const PR_DETAIL_MAX = 360;

function PRExpandedDetail({ detail, loading, nowMs }: {
  detail: PullRequestDetails | null;
  loading: boolean;
  nowMs: number;
}) {
  const [shown, setShown] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const toggleExpanded = () => {
    setExpanded((v) => {
      // Collapsing: snap back to the top so it reopens at the start of the text.
      if (v && scrollRef.current) scrollRef.current.scrollTop = 0;
      return !v;
    });
  };
  // Measure once the detail lands: is there more than the peek height?
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    setOverflowing(el.scrollHeight > PR_DETAIL_PEEK + 12);
  }, [detail]);
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)",
        opacity: shown ? 1 : 0,
        transform: shown ? "translateY(0)" : "translateY(4px)",
        transition: "opacity 200ms var(--ease-out), transform 200ms var(--ease-out)",
      }}
    >
      {loading && !detail && (
        <div style={{ color: "var(--fg-subtle)", fontSize: 11.5 }}>Loading…</div>
      )}
      {detail && (
        <>
          <div
            ref={scrollRef}
            style={{
              position: "relative",
              maxHeight: expanded ? PR_DETAIL_MAX : (overflowing ? PR_DETAIL_PEEK : undefined),
              overflowY: expanded ? "auto" : "hidden",
              // Never let wide content (code, long tokens) bleed off the pane —
              // it wraps or scrolls inside its own block instead.
              overflowX: "hidden",
              transition: "max-height 220ms var(--ease-out)",
              // Fade the last peeked line so the truncation reads as intentional.
              maskImage: !expanded && overflowing ? "linear-gradient(to bottom, #000 62%, transparent)" : undefined,
              WebkitMaskImage: !expanded && overflowing ? "linear-gradient(to bottom, #000 62%, transparent)" : undefined,
            }}
          >
            <div ref={contentRef} style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
              {detail.badge === "open" && detail.mergeable === "CONFLICTING" && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--fg-subtle)", fontSize: 11.5, fontWeight: 550 }}>
                  <GlyphAlert /> Merge conflicts
                </div>
              )}
              <PRTimeline detail={detail} nowMs={nowMs} />
            </div>
          </div>
          {overflowing && (
            <div style={{ display: "flex", justifyContent: "center", marginTop: 8 }}>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); toggleExpanded(); }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--fg-strong)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-subtle)"; }}
                style={{
                  padding: 0, border: "none", background: "transparent",
                  color: "var(--fg-subtle)", cursor: "pointer", fontSize: 11.5, fontWeight: 600,
                  transition: "color var(--motion-fast) var(--ease-out)",
                }}
              >
                {expanded ? "Show less" : "Show more"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Just the section header now — the current-branch PR lives in the list like
// any other, marked inline. No pinned, colour-washed "main" card on top.
/** The head of the GitHub pane: one line — the title, and at the far end the
 *  refresh mark and New PR. No count beside the title: the Open segment below
 *  already says how many are in flight, and there is no "GitHub" eyebrow
 *  above it any more — the pane is the pull requests, so it says that once. */
function GitHubSummaryCard({
  canCreate,
  refreshing,
  onCreate,
  onRefresh,
}: {
  canCreate: boolean;
  refreshing: boolean;
  onCreate: () => void;
  onRefresh: () => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "14px 12px 10px" }}>
      <span style={{ color: "var(--fg-strong)", fontSize: 13, fontWeight: 650, letterSpacing: "-0.01em" }}>Pull requests</span>
      <span style={{ flex: 1 }} />
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        aria-busy={refreshing || undefined}
        title="Refresh pull requests"
        aria-label="Refresh pull requests"
        onMouseEnter={(e) => { if (!refreshing) e.currentTarget.style.color = "var(--fg-strong)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-subtle)"; }}
        style={{ ...iconButtonStyle, width: 22, height: 22, transition: "color var(--motion-fast) var(--ease-out)" }}
      >
        <SyncMark busy={refreshing} motion="spin">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M20 6v5h-5" /><path d="M4 18v-5h5" />
            <path d="M18.3 9A7 7 0 0 0 6.4 6.4L4 9" /><path d="M5.7 15A7 7 0 0 0 17.6 17.6L20 15" />
          </svg>
        </SyncMark>
      </button>
      <PRActionButton title={canCreate ? "Create pull request" : "Stage changes before creating a pull request"} onClick={onCreate} disabled={!canCreate}>New PR</PRActionButton>
    </div>
  );
}

/** The one segmented switch, in the macOS shape: a soft track holding equal
 *  segments and a single raised thumb that glides to whichever is chosen
 *  (transform only, see .klide-segmented). The segments themselves never
 *  fill — only their colour answers the thumb — so a change reads as one
 *  thing moving, not two boxes swapping. */
function SegmentedTabs<T extends string>({
  value,
  options,
  onChange,
  margin = "0 12px 10px",
}: {
  value: T;
  options: { id: T; label: string; count?: number }[];
  onChange: (value: T) => void;
  margin?: string;
}) {
  const index = Math.max(0, options.findIndex((o) => o.id === value));
  return (
    <div
      role="tablist"
      className="klide-segmented"
      style={{ margin, "--seg-count": options.length, "--seg-index": index } as React.CSSProperties}
    >
      <span aria-hidden className="klide-segmented-thumb" />
      {options.map((option) => {
        const active = value === option.id;
        return (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={active}
            data-active={active}
            className="klide-segmented-seg"
            onClick={() => onChange(option.id)}
          >
            {option.label}
            {/* Only the chosen segment says how many; the others are just
                names until the thumb reaches them, and the count fades in
                behind it. */}
            {active && option.count !== undefined && option.count > 0 && (
              <span className="klide-segmented-count">{option.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** The PR list with departing cards spliced back in where they stood. A
 *  departing PR the list still shows (the merge is in flight, or the filter is
 *  "all" and it stays as Merged) is not doubled — the live card wins. */
function withDepartingPrs(
  visible: PullRequest[],
  departing: { pr: PullRequest; index: number }[],
): { pr: PullRequest; departing: boolean }[] {
  const out = visible.map((pr) => ({ pr, departing: false }));
  const live = new Set(visible.map((pr) => pr.number));
  for (const d of [...departing].sort((a, b) => a.index - b.index)) {
    if (live.has(d.pr.number)) continue;
    out.splice(Math.min(d.index, out.length), 0, { pr: d.pr, departing: true });
  }
  return out;
}

/** A merged card on its way out. Its height is measured once on mount and
 *  handed to the CSS as --depart-h, so the fold animates real pixels (the
 *  cards below glide up with it) rather than a grid track the webview may
 *  snap. The body fades and lifts while the shell folds; the shell's end
 *  event, the later of the two, is what removes the card. */
function DepartingPrCard({ pr, nowMs, onDone }: { pr: PullRequest; nowMs: number; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (ref.current) setHeight(ref.current.getBoundingClientRect().height);
  }, []);
  return (
    <div
      ref={ref}
      className="klide-pr-depart"
      data-measured={height !== null || undefined}
      style={height !== null ? ({ "--depart-h": `${height}px` } as React.CSSProperties) : undefined}
      aria-hidden
      onAnimationEnd={(e) => { if (e.target === e.currentTarget) onDone(); }}
    >
      <div className="klide-pr-depart-body">
        <PRCard
          pr={pr}
          nowMs={nowMs}
          selected={false}
          detail={null}
          detailLoading={false}
          onSelect={() => {}}
          onOpen={() => {}}
          onCheckout={() => {}}
          onMerge={() => {}}
        />
      </div>
    </div>
  );
}

function PRFilterTabs({
  value,
  counts,
  onChange,
}: {
  value: PullRequestFilter;
  counts: { open: number; draft: number; merged: number; closed: number };
  onChange: (value: PullRequestFilter) => void;
}) {
  return (
    <SegmentedTabs
      value={value}
      onChange={onChange}
      options={[
        { id: "open", label: "Open", count: counts.open + counts.draft },
        { id: "closed", label: "Closed", count: counts.merged + counts.closed },
      ]}
    />
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

function BranchMenu({ branches, tags, defaultBranch, current, onSelect, onClose }: {
  branches: GitBranch[]; tags: GitTag[]; defaultBranch: string | null; current: string;
  onSelect: (name: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"branches" | "tags">("branches");
  // The tab underline is one bar that slides between the two words (the
  // TabBar's FLIP move), sized to the active word each time it lands.
  const flip = useFlipIndicator(tab, { size: 1.5, active: true, axis: "x" });
  const tabEls = useRef<Map<string, HTMLElement | null>>(new Map());
  const [barWidth, setBarWidth] = useState(0);
  useLayoutEffect(() => {
    const el = tabEls.current.get(tab);
    if (el) setBarWidth(el.getBoundingClientRect().width);
  }, [tab]);
  const q = query.trim().toLowerCase();
  const rows = useMemo(() => mergeBranchesForMenu(branches, defaultBranch), [branches, defaultBranch]);
  const shownBranches = useMemo(() => (q ? rows.filter((b) => b.name.toLowerCase().includes(q)) : rows), [rows, q]);
  const shownTags = useMemo(() => (q ? tags.filter((t) => t.name.toLowerCase().includes(q)) : tags), [tags, q]);
  const first = tab === "branches" ? shownBranches[0]?.name : shownTags[0]?.name;
  // Rows are soft: a little taller than a list needs, a wide radius, and
  // the fill eases in rather than snapping.
  const rowStyle: React.CSSProperties = {
    display: "grid", gridTemplateColumns: "12px 1fr auto", alignItems: "center", gap: 8,
    height: 30, padding: "0 10px", borderRadius: "var(--radius-md)", border: "none", background: "transparent",
    color: "var(--fg)", font: "inherit", textAlign: "left", cursor: "pointer",
    transition: "background var(--motion-med) var(--ease-soft)",
  };
  const tabStyle = (active: boolean): React.CSSProperties => ({
    border: "none", background: "transparent", padding: "2px 1px 9px", font: "inherit", fontSize: 12,
    cursor: "pointer", color: active ? "var(--fg-strong)" : "var(--fg-subtle)",
    display: "inline-flex", alignItems: "center", gap: 4, position: "relative",
    transition: "color var(--motion-med) var(--ease-soft)",
  });
  const hover = {
    onMouseEnter: (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.background = "var(--bg-hover)"; },
    onMouseLeave: (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.background = "transparent"; },
  };
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 99 }} />
      <div
        className="floating-panel popover-enter"
        style={{
          position: "absolute", top: "calc(100% + 10px)", left: -12, zIndex: 100,
          width: 304, maxHeight: 440, overflow: "hidden", padding: 8, borderRadius: "var(--radius-lg)",
          display: "flex", flexDirection: "column", gap: 0, transformOrigin: "top left",
        }}
      >
        {/* Head — the filter as a bare text line with a dim glyph, then the
            Branches / Tags words on a hairline. Everything shares one left
            edge with the row text below (8px pad + 12px check column + 8px gap). */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, height: 38, padding: "0 10px", flexShrink: 0 }}>
          <SearchIcon size={12} style={{ color: query ? "var(--fg-subtle)" : "var(--fg-dim)", flexShrink: 0, transition: "color var(--motion-med) var(--ease-soft)" }} />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && first) { onSelect(first); }
              if (e.key === "Escape") { if (query) setQuery(""); else onClose(); }
            }}
            placeholder={tab === "branches" ? "Find a branch" : "Find a tag"}
            aria-label={tab === "branches" ? "Find a branch" : "Find a tag"}
            className="klide-bare-filter"
            style={{
              flex: 1, minWidth: 0, height: "100%", padding: 0,
              border: "none", background: "transparent",
              color: "var(--fg-strong)", font: "inherit", fontSize: 12.5, outline: "none",
            }}
          />
        </div>
        <div
          role="tablist"
          ref={flip.trackRef}
          data-flip={flip.flip}
          className="klide-flip-track"
          style={{ position: "relative", display: "flex", gap: 16, padding: "0 10px 0 30px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}
        >
          {([
            { id: "branches" as const, label: "Branches", count: rows.length },
            { id: "tags" as const, label: "Tags", count: tags.length },
          ]).map((o) => {
            const active = tab === o.id;
            const setFlipRef = flip.setItemRef(o.id);
            return (
              <button
                key={o.id}
                role="tab"
                aria-selected={active}
                onClick={() => setTab(o.id)}
                style={tabStyle(active)}
                ref={(el) => { tabEls.current.set(o.id, el); setFlipRef(el); }}
              >
                {o.label}
                {o.count > 0 && <span style={{ fontSize: 10.5, color: "var(--fg-dim)", fontFamily: "var(--font-mono)" }}>{o.count}</span>}
              </button>
            );
          })}
          <span
            aria-hidden
            className="klide-flip-indicator"
            style={{ ...flip.style, left: 0, bottom: -1, height: 1.5, width: barWidth, borderRadius: 1, background: "var(--fg-strong)" }}
          />
        </div>
        <div key={tab} className="klide-enter-rise" style={{ overflow: "auto", minHeight: 0, display: "flex", flexDirection: "column", gap: 1, padding: "8px 0 2px" }}>
          {tab === "branches" && shownBranches.length === 0 && (
            <div style={{ padding: "10px 8px", color: "var(--fg-subtle)", fontSize: 12 }}>No branches match.</div>
          )}
          {tab === "tags" && shownTags.length === 0 && (
            <div style={{ padding: "10px 8px", color: "var(--fg-subtle)", fontSize: 12 }}>{tags.length === 0 ? "No tags yet." : "No tags match."}</div>
          )}
          {tab === "branches" && shownBranches.map((b) => {
            const d = branchDisplay(b.name);
            const isCurrent = b.name === current;
            return (
              <button
                key={b.name}
                onClick={() => onSelect(b.name)}
                title={b.remoteOnly ? `${b.name} — on the remote only; checking out creates the local branch` : b.lastSubject}
                style={rowStyle}
                {...hover}
              >
                {/* Check column — the current branch, GitHub-style, in the
                    accent with a light stroke so it reads as a note, not a stamp. */}
                <span aria-hidden style={{ display: "grid", placeItems: "center", width: 12, height: 12 }}>
                  {isCurrent && (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12.5l4.5 4.5L19 7.5" />
                    </svg>
                  )}
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                  {/* The agent's mark stands in for its `codex/` or `claude/`
                      prefix — one small glyph in the text run. */}
                  {d.agent && (
                    <span aria-hidden style={{ display: "inline-grid", placeItems: "center", width: 13, height: 13, flexShrink: 0, opacity: 0.85 }}>
                      {d.agent === "klide" ? <KlideMark size={12} /> : <ProviderLogo id={d.agent} size={12} />}
                    </span>
                  )}
                  <span style={{
                    minWidth: 0, fontFamily: "var(--font-mono)", fontSize: 11.5,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    // The current branch is the strong one; the rest sit a
                    // step quieter, and a remote-only branch (not here yet) two.
                    color: isCurrent ? "var(--fg-strong)" : b.remoteOnly ? "var(--fg-subtle)" : "var(--fg)",
                  }}>
                    {d.prefix && <span style={{ color: "var(--fg-subtle)" }}>{d.prefix}</span>}
                    {d.leaf}
                  </span>
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 10.5, flexShrink: 0 }}>
                  {b.ahead > 0 && <span style={{ color: "var(--fg-dim)", fontFamily: "var(--font-mono)" }}>↑{b.ahead}</span>}
                  {b.behind > 0 && <span style={{ color: "var(--fg-dim)", fontFamily: "var(--font-mono)" }}>↓{b.behind}</span>}
                  {b.isDefault && <span style={{ color: "var(--fg-dim)" }}>default</span>}
                </span>
              </button>
            );
          })}
          {tab === "tags" && shownTags.map((t) => (
            <button
              key={t.name}
              onClick={() => onSelect(t.name)}
              title={`${t.subject} — checks out ${t.name} (detached)`}
              style={rowStyle}
              {...hover}
            >
              <span aria-hidden style={{ display: "grid", placeItems: "center", width: 12, height: 12 }}>
                {current === t.name && (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12.5l4.5 4.5L19 7.5" />
                  </svg>
                )}
              </span>
              <span style={{
                minWidth: 0, fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--fg)",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>
                {t.name}
              </span>
              <span style={{ fontSize: 10.5, color: "var(--fg-dim)", flexShrink: 0 }}>
                {relativeTimeLong(t.timestamp * 1000, Date.now())}
              </span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

export function GitReview({ initialPr, workspaceRoot, gitStatus, onRefreshGitStatus, theme: _theme }: Props) {
  const [log, setLog] = useState<GitLog | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [localStatus, setLocalStatus] = useState<GitStatus | null>(null);
  const [prs, setPrs] = useState<PullRequest[] | null>(null);
  // A PR merged from here lingers one beat after the re-fetch drops it from
  // the list — wearing its Merged badge, then fading and folding shut — instead
  // of vanishing on the refresh. Kept at the index its card had, so it leaves
  // from where it stood. Cleared when its exit animation ends.
  const [departingPrs, setDepartingPrs] = useState<{ pr: PullRequest; index: number }[]>([]);
  const [prsLoading, setPrsLoading] = useState(false);
  const [prError, setPrError] = useState<string | null>(null);
  const [stashes, setStashes] = useState<GitStash[] | null>(null);
  const [selectedPr, setSelectedPr] = useState<PullRequestDetails | null>(null);
  // Which card is expanded. Tracked separately from the fetched detail so the
  // card highlights + expands instantly on click while `git pr view` loads.
  const [expandedPr, setExpandedPr] = useState<number | null>(null);
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
    gitCommitDetails(workspaceRoot, selectedCommit)
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
      const next = await gitLog(workspaceRoot, 60);
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
      const list = await gitStashList(workspaceRoot);
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
      const list = await gitPrList(workspaceRoot);
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
      const next = await fetchGitStatus(workspaceRoot);
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
  const { stagedFiles, changedFiles } = splitStatusFiles(files);
  const prList = useMemo(() => {
    const rows = prs ?? [];
    if (!selectedPr || rows.some(pr => pr.number === selectedPr.number)) return rows;
    // A direct destination may be older than the latest 50 PRs returned by gh.
    const pr: PullRequest = { ...selectedPr, commentAuthors: [], isCurrentBranch: false };
    return [pr, ...rows];
  }, [prs, selectedPr]);
  const prCounts = useMemo(() => derivePrCounts(prList), [prList]);
  const visiblePrs = useMemo(() => deriveVisiblePrs(prList, prFilter), [prFilter, prList]);

  useEffect(() => {
    if (initialPr && expandedPr === initialPr.pr && selectedPr) {
      rootRef.current?.querySelector(`[data-pr-number="${initialPr.pr}"]`)?.scrollIntoView({ block: "nearest" });
    }
  }, [initialPr, expandedPr, selectedPr, prs]);

  const refreshers: Record<GitReviewRefresh, () => Promise<void>> = {
    status: refreshStatus,
    log: refreshLog,
    prs: refreshPrs,
    stashes: refreshStashes,
  };

  // The one place a Git Review action lands: run the command, show the
  // outcome's notice (or the error), and — on success only — apply what the
  // outcome says the surface needs: cleared selections first, re-fetches after.
  async function runGitAction(outcome: GitActionOutcome, fn: () => Promise<unknown>): Promise<boolean> {
    setActionLoading(outcome.message);
    try {
      await fn();
      setActionMessage({ kind: "ok", text: outcome.message });
    } catch (e) {
      setActionMessage({ kind: "err", text: errMessage(e) });
      return false;
    } finally {
      setActionLoading(null);
    }
    if (outcome.clearCommitMessage) setCommitMessage("");
    if (outcome.closeBranchMenu) setBranchMenuOpen(false);
    if (outcome.closeDiff) setOpen(null);
    if (outcome.collapseExpandedPr) {
      setExpandedPr(null);
      setSelectedPr(null);
    }
    if (outcome.closePrComposer) setPrComposer(null);
    for (const target of outcome.refresh) await refreshers[target]();
    return true;
  }

  async function stageFile(path: string) {
    if (!workspaceRoot) return;
    await runGitAction(stageFileOutcome(), () => gitStage(workspaceRoot, path));
  }
  async function unstageFile(path: string) {
    if (!workspaceRoot) return;
    await runGitAction(unstageFileOutcome(), () => gitUnstage(workspaceRoot, path));
  }
  async function discardFile(path: string) {
    if (!workspaceRoot) return;
    await runGitAction(discardFileOutcome(path, open?.path ?? null), () => gitDiscard(workspaceRoot, path));
  }
  async function stageAll() {
    if (!workspaceRoot) return;
    await runGitAction(stageAllOutcome(), () => gitStage(workspaceRoot, "."));
  }
  async function unstageAll() {
    if (!workspaceRoot) return;
    await runGitAction(unstageAllOutcome(), () => gitUnstage(workspaceRoot, "."));
  }

  async function commit() {
    if (!workspaceRoot || !commitMessage.trim() || stagedFiles.length === 0) return;
    setCommitLoading(true);
    try {
      await runGitAction(commitOutcome(), () => gitCommit(workspaceRoot, commitMessage));
    } finally {
      setCommitLoading(false);
    }
  }

  async function fetch() {
    if (!workspaceRoot) return;
    await runGitAction(fetchOutcome(), () => gitFetch(workspaceRoot));
  }
  async function pull() {
    if (!workspaceRoot) return;
    await runGitAction(pullOutcome(), () => gitPull(workspaceRoot));
  }
  async function push() {
    if (!workspaceRoot) return;
    await runGitAction(pushOutcome(), () => gitPush(workspaceRoot));
  }
  async function checkoutBranch(name: string) {
    if (!workspaceRoot || !name || name === log?.branch) {
      setBranchMenuOpen(false);
      return;
    }
    // On failure the branch menu stays open (the outcome never applies).
    await runGitAction(checkoutBranchOutcome(name), () => gitCheckoutBranch(workspaceRoot, name));
  }
  async function stashPush() {
    if (!workspaceRoot) return;
    await runGitAction(stashPushOutcome(), () => gitStash(workspaceRoot, "push", "WIP"));
  }
  async function stashPop() {
    if (!workspaceRoot) return;
    await runGitAction(stashPopOutcome(), () => gitStash(workspaceRoot, "pop"));
  }

  async function selectPr(n: number) {
    if (!workspaceRoot) return;
    // Toggle: clicking the open card closes it.
    if (expandedPr === n) {
      setExpandedPr(null);
      setSelectedPr(null);
      return;
    }
    setExpandedPr(n);
    setSelectedPr(null);
    setPrDetailLoading(true);
    try {
      const detail = await gitPrView(workspaceRoot, n);
      setSelectedPr(detail);
    } catch (e) {
      setActionMessage({ kind: "err", text: errMessage(e) });
      setExpandedPr(null);
    } finally {
      setPrDetailLoading(false);
    }
  }
  useEffect(() => {
    if (!initialPr || !workspaceRoot) return;
    let alive = true;
    setExpandedPr(initialPr.pr);
    setSelectedPr(null);
    setPrDetailLoading(true);
    void gitPrView(workspaceRoot, initialPr.pr).then(detail => {
      if (!alive) return;
      setSelectedPr(detail);
      setPrFilter(detail.state === "OPEN" ? "open" : "closed");
    }).catch(error => { if (alive) setActionMessage({ kind: "err", text: errMessage(error) }); })
      .finally(() => { if (alive) setPrDetailLoading(false); });
    return () => { alive = false; };
  }, [initialPr, workspaceRoot]);
  async function openPrInBrowser(n: number) {
    if (!workspaceRoot) return;
    await runGitAction(openPrInBrowserOutcome(), () => gitPrOpen(workspaceRoot, n));
  }
  async function checkoutPr(n: number) {
    if (!workspaceRoot) return;
    await runGitAction(checkoutPrOutcome(n, expandedPr), () => gitPrCheckout(workspaceRoot, n));
  }
  async function mergePr(n: number) {
    if (!workspaceRoot) return;
    if (!confirm(`Merge PR #${n}?`)) return;
    const index = visiblePrs.findIndex((p) => p.number === n);
    if (index >= 0) {
      const leaving = { ...visiblePrs[index], badge: "merged" as const };
      setDepartingPrs((d) => [...d.filter((x) => x.pr.number !== n), { pr: leaving, index }]);
    }
    const ok = await runGitAction(mergePrOutcome(n, expandedPr), () => gitPrMerge(workspaceRoot, n));
    if (!ok) setDepartingPrs((d) => d.filter((x) => x.pr.number !== n));
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
    await runGitAction(submitPrOutcome(), () =>
      createPrRequest(workspaceRoot, prComposer.title.trim(), prComposer.body.trim() || null)
    );
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
  const hasWork = stagedFiles.length > 0 || changedFiles.length > 0;

  return (
    <div
      ref={rootRef}
      className="shell-enter"
      style={{ position: "relative", flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, background: "var(--bg)" }}
    >
      {/* Action feedback — a notification tucked into the bottom-right corner,
          clear of the panes so it doesn't cover file/PR content. */}
      {actionMessage && (
        <div
          key={actionMessage.text}
          className="floating-panel toast-enter"
          style={{
            position: "absolute", bottom: 16, right: 16, zIndex: 50, maxWidth: 340,
            padding: "9px 13px", fontSize: 12, fontWeight: 500, borderRadius: 10,
            display: "flex", alignItems: "center", gap: 8,
            color: actionMessage.kind === "ok" ? "var(--fg-strong)" : "var(--danger)",
          }}
        >
          <span aria-hidden style={{ color: actionMessage.kind === "ok" ? "var(--success)" : "var(--danger)", fontWeight: 600, flexShrink: 0 }}>
            {actionMessage.kind === "ok" ? "✓" : "×"}
          </span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{actionMessage.text}</span>
        </div>
      )}
      {/* Header — one quiet row on the page background. A hairline below,
          no fill, no glass. It leads with the branch (the rail already names
          the project and the view); the fetch time sits dim beside it. */}
      <div style={{
        minHeight: 60, padding: "0 20px", display: "flex", alignItems: "center", gap: 16,
        borderBottom: "1px solid var(--border)", position: "relative", zIndex: 2,
      }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, minWidth: 0, flexShrink: 0 }}>
          <div style={{ position: "relative", display: "inline-flex", alignItems: "baseline", gap: 10 }}>
            <button
              onClick={() => setBranchMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={branchMenuOpen}
              style={{
                border: "none", background: "transparent", padding: 0, font: "inherit", cursor: "pointer",
                display: "inline-flex", alignItems: "center", gap: 5,
              }}
              title="Switch branch"
            >
              <BranchLabel branch={log?.branch ?? reviewStatus?.branch ?? "—"} ahead={log?.ahead ?? 0} behind={log?.behind ?? 0} />
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ color: "var(--fg-dim)" }}>
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            {(log?.lastFetchMs || logLoading) && (
              <span
                style={{ fontSize: 11, color: "var(--fg-dim)", whiteSpace: "nowrap" }}
                title={log?.lastFetchMs ? new Date(log.lastFetchMs).toLocaleString() : undefined}
              >
                {logLoading ? "refreshing…" : `fetched ${relativeTimeLong(log!.lastFetchMs!, nowMs)}`}
              </span>
            )}
            {branchMenuOpen && log && (
              <BranchMenu
                branches={log.branches}
                tags={log.tags}
                defaultBranch={log.defaultBranch}
                current={log.branch}
                onSelect={checkoutBranch}
                onClose={() => setBranchMenuOpen(false)}
              />
            )}
          </div>
        </div>
        {/* Commit composer — present only while there is work to commit. A
            clean tree shows nothing here; the header states a fact instead
            of holding a dead field. */}
        {hasWork ? (
          <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8 }}>
            <input
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void commit(); } }}
              placeholder={stagedFiles.length === 0 ? "Stage changes to commit" : `Commit ${stagedFiles.length} file${stagedFiles.length === 1 ? "" : "s"}…`}
              aria-label="Commit message"
              style={{
                flex: 1, minWidth: 0, height: 32, padding: "0 12px",
                border: "1px solid transparent", borderRadius: "var(--radius-lg)",
                background: "var(--bg-hover)", color: "var(--fg-strong)", font: "inherit", fontSize: 13, outline: "none",
                transition: "border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)",
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg)"; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = "transparent"; e.currentTarget.style.background = "var(--bg-hover)"; }}
            />
            <button
              onClick={() => void commit()}
              disabled={!commitMessage.trim() || stagedFiles.length === 0 || commitLoading}
              title={stagedFiles.length === 0 ? "Stage changes before committing" : "Commit staged changes (⌘↩)"}
              style={{
                height: 32, padding: "0 14px", borderRadius: "var(--radius-lg)", fontWeight: 600, fontSize: 12, cursor: "pointer",
                background: commitMessage.trim() && stagedFiles.length > 0 && !commitLoading ? "var(--accent)" : "transparent",
                color: commitMessage.trim() && stagedFiles.length > 0 && !commitLoading ? "var(--control-primary-fg)" : "var(--fg-subtle)",
                border: "1px solid " + (commitMessage.trim() && stagedFiles.length > 0 && !commitLoading
                  ? "color-mix(in srgb, var(--accent) 60%, var(--inset-ring))"
                  : "var(--border)"),
                transition: "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
              }}
            >
              {commitLoading ? "Committing…" : "Commit"}
            </button>
          </div>
        ) : (
          <span style={{ flex: 1 }} />
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
          <TopAction onClick={() => void fetch()} busy={actionLoading === "Fetched"} motion="spin" title="Fetch from all remotes" iconOnly>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M20 6v5h-5" /><path d="M4 18v-5h5" />
              <path d="M18.3 9A7 7 0 0 0 6.4 6.4L4 9" /><path d="M5.7 15A7 7 0 0 0 17.6 17.6L20 15" />
            </svg>
          </TopAction>
          <TopAction onClick={() => void pull()} busy={actionLoading === "Pulled"} motion="down" title="Pull (fast-forward only)" iconOnly>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <g className="klide-git-arrow"><path d="M12 3v13" /><path d="M6 11l6 6 6-6" /></g><path d="M5 21h14" />
            </svg>
          </TopAction>
          <TopAction onClick={() => void push()} busy={actionLoading === "Pushed"} motion="up" title="Push to upstream" iconOnly>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <g className="klide-git-arrow"><path d="M12 21V8" /><path d="M6 13l6-6 6 6" /></g><path d="M5 3h14" />
            </svg>
          </TopAction>
          <button
            onClick={() => void createPr()}
            disabled={stagedFiles.length === 0}
            title={stagedFiles.length === 0 ? "Stage changes before opening a PR" : "Open a pull request (⌘⇧P)"}
            style={{
              height: 30, marginLeft: 8, padding: "0 12px", borderRadius: "var(--radius-lg)", fontWeight: 600, fontSize: 12,
              cursor: stagedFiles.length === 0 ? "not-allowed" : "pointer",
              background: "transparent", color: stagedFiles.length === 0 ? "var(--fg-subtle)" : "var(--fg-strong)",
              border: "1px solid var(--border)",
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
          {/* Staged only exists once something is staged. An empty section
              header is a label for nothing, and its "Unstage all" action has
              nothing to act on — so the clean tree shows neither. */}
          {stagedFiles.length > 0 && (
            <>
              <SectionHeader
                title="Staged"
                count={stagedFiles.length}
                onAction={unstageAll}
                actionLabel="Unstage all"
                actionIcon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d="M5 12h14" /></svg>}
              />
              <div style={{ overflow: "auto", maxHeight: "40%", minHeight: 0 }}>
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
            </>
          )}
          {hasWork && (
            <SectionHeader
              title="Changes"
              count={changedFiles.length}
              spaced={stagedFiles.length > 0}
              onAction={stageAll}
              actionLabel="Stage all"
              actionIcon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d="M12 5v14" /><path d="M5 12h14" /></svg>}
            />
          )}
          <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
            {!hasWork ? (
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
          {/* Stash foot — the one fact the old bottom shelf carried that the
              panes didn't already. Shown when there is a stash to pop, or
              working changes to stash; a clean tree with no stash shows nothing. */}
          {((stashes && stashes.length > 0) || changedFiles.length > 0) && (
            <div style={{
              height: 30, padding: "0 10px", display: "flex", alignItems: "center", gap: 6, flexShrink: 0,
              borderTop: "1px solid var(--border)",
              fontSize: 11, color: "var(--fg-subtle)",
            }}>
              <span style={{ color: "var(--fg)", fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" }}>Stash</span>
              <span style={{ color: "var(--fg-dim)" }}>{stashes?.length ?? 0}</span>
              <span style={{ flex: 1 }} />
              {stashes && stashes.length > 0 && (
                <button onClick={() => void stashPop()} style={ghostLinkStyle} title="Pop the latest stash">Pop</button>
              )}
              {changedFiles.length > 0 && (
                <button onClick={() => void stashPush()} style={ghostLinkStyle} title="Stash all working changes">Stash</button>
              )}
            </div>
          )}
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
                <StatusLetter status={reviewStatus?.files.find((f) => f.path === open.path)?.status ?? ""} />
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
          <GitHubSummaryCard
            canCreate={stagedFiles.length > 0}
            refreshing={prsLoading}
            onCreate={createPr}
            onRefresh={() => void refreshPrs()}
          />
          <PRFilterTabs value={prFilter} counts={prCounts} onChange={setPrFilter} />
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
          <div style={{ flex: 1, overflow: "auto", minHeight: 0, padding: "2px 12px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
            {/* Only the first load takes over the panel; background refreshes
                keep the existing cards on screen so nothing flashes. */}
            {prsLoading && !prs && !prError && (
              <GitHubPanelState title="Loading GitHub" detail="Fetching pull requests." />
            )}
            {!prsLoading && !prError && prs && prs.length > 0 && visiblePrs.length === 0 && (
              <GitHubPanelState title={`No ${prFilter} pull requests`} />
            )}
            {withDepartingPrs(visiblePrs, departingPrs).map(({ pr, departing }) =>
              departing ? (
                <DepartingPrCard
                  key={`departing-${pr.number}`}
                  pr={pr}
                  nowMs={nowMs}
                  onDone={() => setDepartingPrs((d) => d.filter((x) => x.pr.number !== pr.number))}
                />
              ) : (
                <PRCard
                  key={pr.number}
                  pr={pr}
                  nowMs={nowMs}
                  selected={expandedPr === pr.number}
                  detail={selectedPr?.number === pr.number ? selectedPr : null}
                  detailLoading={prDetailLoading}
                  onSelect={selectPr}
                  onOpen={openPrInBrowser}
                  onCheckout={checkoutPr}
                  onMerge={mergePr}
                />
              ),
            )}
          </div>
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

type SyncMotion = "spin" | "down" | "up";

/** A sync icon that moves while its action runs (`motion` picks how — see
 *  .klide-git-sync-mark). It keeps playing until the cycle under way finishes
 *  after `busy` clears, so the mark never snaps back mid-frame and a
 *  sub-second fetch still shows one complete turn. */
function SyncMark({ busy, motion, children }: { busy?: boolean; motion?: SyncMotion; children: React.ReactNode }) {
  const [playing, setPlaying] = useState(false);
  if (busy && !playing) setPlaying(true);
  return (
    <span
      className="klide-git-sync-mark"
      data-motion={motion}
      data-playing={playing}
      onAnimationIteration={() => { if (!busy) setPlaying(false); }}
    >
      {children}
    </span>
  );
}

function TopAction({ onClick, disabled, busy, motion, title, iconOnly, children }: {
  onClick: () => void; disabled?: boolean; busy?: boolean; motion?: SyncMotion; title: string; iconOnly?: boolean; children: React.ReactNode;
}) {
  // Icon-only actions are bare marks — no container, just a hover brighten,
  // matching the quiet icon buttons in the PR list. The motion is the busy
  // signal, so a busy button is not also dimmed the way a disabled one is.
  if (iconOnly) {
    return (
      <button
        onClick={onClick}
        disabled={disabled || busy}
        aria-busy={busy || undefined}
        title={title}
        aria-label={title}
        style={{
          width: 30, height: 30, display: "grid", placeItems: "center",
          border: "none", background: "transparent", color: "var(--fg-subtle)",
          cursor: disabled || busy ? "default" : "pointer", opacity: disabled && !busy ? 0.4 : 1,
          transition: "color var(--motion-fast) var(--ease-out)",
        }}
        onMouseEnter={(e) => { if (!disabled && !busy) e.currentTarget.style.color = "var(--fg-strong)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-subtle)"; }}
      >
        <SyncMark busy={busy} motion={motion}>{children}</SyncMark>
      </button>
    );
  }
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      style={{
        height: 32, padding: "0 10px",
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
