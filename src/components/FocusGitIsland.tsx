import { memo, useEffect, useMemo, useRef, useState } from "react";
import { gitGraph } from "../ipc/git";
import { layoutGraph, type GraphCommit, type GraphRow } from "../gitGraph";

const ISLAND_ROW_HEIGHT = 22;
const PREVIEW_ROW_HEIGHT = 38;
const LANE_WIDTH = 9;
const GRAPH_PAD = 7;
const MAX_LANES = 5;
const PREVIEW_COMMITS = 5;
const SIDE_PREVIEW_COMMITS = 16;

function laneX(lane: number): number {
  return GRAPH_PAD + lane * LANE_WIDTH;
}

function laneColor(index: number): string {
  return `var(--lane-${(index % 8) + 1})`;
}

function topPath(from: number, to: number, rowHeight: number): string {
  const x1 = laneX(from);
  const x2 = laneX(to);
  const middle = rowHeight / 2;
  if (x1 === x2) return `M ${x1} 0 L ${x2} ${middle}`;
  return `M ${x1} 0 C ${x1} ${middle * 0.8}, ${x2} ${middle * 0.2}, ${x2} ${middle}`;
}

function bottomPath(from: number, to: number, rowHeight: number): string {
  const x1 = laneX(from);
  const x2 = laneX(to);
  const middle = rowHeight / 2;
  if (x1 === x2) return `M ${x1} ${middle} L ${x2} ${rowHeight}`;
  return `M ${x1} ${middle} C ${x1} ${middle * 1.8}, ${x2} ${middle * 1.2}, ${x2} ${rowHeight}`;
}

const PreviewGraphCell = memo(function PreviewGraphCell({
  row,
  width,
  isHead,
  rowHeight,
}: {
  row: GraphRow;
  width: number;
  isHead: boolean;
  rowHeight: number;
}) {
  const nodeX = laneX(row.lane);
  return (
    <svg width={width} height={rowHeight} style={{ display: "block", flexShrink: 0 }} aria-hidden="true">
      {row.passThrough.map((line) => (
        <line
          key={`p-${line.lane}`}
          x1={laneX(line.lane)}
          y1={0}
          x2={laneX(line.lane)}
          y2={rowHeight}
          stroke={laneColor(line.color)}
          strokeWidth={1.35}
        />
      ))}
      {row.intoNode.map((line) => (
        <path
          key={`i-${line.lane}`}
          d={topPath(line.lane, row.lane, rowHeight)}
          stroke={laneColor(line.color)}
          strokeWidth={1.35}
          fill="none"
        />
      ))}
      {row.outOfNode.map((line, index) => (
        <path
          key={`o-${index}-${line.lane}`}
          d={bottomPath(row.lane, line.lane, rowHeight)}
          stroke={laneColor(line.color)}
          strokeWidth={1.35}
          fill="none"
        />
      ))}
      <circle
        cx={nodeX}
        cy={rowHeight / 2}
        r={isHead ? 3.1 : 2.5}
        fill={isHead ? "var(--bg-elevated)" : laneColor(row.color)}
        stroke={laneColor(row.color)}
        strokeWidth={isHead ? 1.7 : 0}
      />
    </svg>
  );
});

const WindowSizeIcon = memo(function WindowSizeIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className="klide-focus-git-size-icon"
      data-expanded={expanded || undefined}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 3H3v6" />
      <path d="M15 3h6v6" />
      <path d="M21 15v6h-6" />
      <path d="M9 21H3v-6" />
    </svg>
  );
});

const ProfilePicture = memo(function ProfilePicture({
  avatarUrl,
  initials,
}: {
  avatarUrl: string;
  initials: string;
}) {
  return (
    <span className="klide-focus-git-profile-picture" aria-hidden="true">
      {initials}
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt=""
          onError={(event) => { event.currentTarget.style.display = "none"; }}
        />
      ) : null}
    </span>
  );
});

type Props = {
  workspaceRoot: string;
  branch: string | null;
  changeCount: number;
  avatarUrl: string;
  profileInitials: string;
  /** Stable fingerprint of branch + file status. Avoids refetching on App's
   *  three-second status poll when Git state has not actually changed. */
  refreshToken: string;
  onOpen: () => void;
  /** Bumped by the composer strip's branch to draw the eye up here. Any change
   *  plays one pulse; the value itself is meaningless, only that it moved. */
  pingToken?: number;
};

export const FocusGitIsland = memo(function FocusGitIsland({
  workspaceRoot,
  branch,
  changeCount,
  avatarUrl,
  profileInitials,
  refreshToken,
  onOpen,
  pingToken = 0,
}: Props) {
  const [commits, setCommits] = useState<GraphCommit[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const islandRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLElement>(null);
  const [pinging, setPinging] = useState(false);

  // Hold the swell for exactly as long as the CSS takes to reach full size
  // (380ms), then release so the same curve carries it back. Releasing early
  // would reverse mid-grow and the peak would depend on timing. Skipped on the
  // first render — token 0 means "nobody has pinged yet".
  useEffect(() => {
    if (!pingToken) return;
    setPinging(true);
    const timer = setTimeout(() => setPinging(false), 380);
    return () => clearTimeout(timer);
  }, [pingToken]);

  useEffect(() => {
    let cancelled = false;
    gitGraph(workspaceRoot, 18)
      .then((next) => {
        if (cancelled) return;
        setCommits(next);
        setUnavailable(false);
      })
      .catch(() => {
        if (cancelled) return;
        setCommits([]);
        setUnavailable(true);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceRoot, refreshToken]);

  useEffect(() => {
    setExpanded(false);
  }, [workspaceRoot]);

  useEffect(() => {
    if (!expanded) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setExpanded(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded]);

  const rows = useMemo(() => layoutGraph(commits ?? []), [commits]);
  const islandRows = rows.slice(0, PREVIEW_COMMITS);
  const sideRows = rows.slice(0, SIDE_PREVIEW_COMMITS);
  const graphWidth = useMemo(() => {
    let lanes = 1;
    for (const row of rows) lanes = Math.max(lanes, Math.min(MAX_LANES, row.width));
    return GRAPH_PAD * 2 + (lanes - 1) * LANE_WIDTH;
  }, [rows]);
  const headHash = useMemo(
    () => commits?.find((commit) => commit.refs.some((ref) => ref.startsWith("HEAD -> ")))?.hash ?? commits?.[0]?.hash,
    [commits]
  );

  function toggleExpanded() {
    const island = islandRef.current;
    const preview = previewRef.current;
    if (island && preview && preview.offsetWidth > 0 && preview.offsetHeight > 0) {
      // Both windows share the same top-right anchor. Measuring their layout
      // boxes at the moment of interaction makes the large window land on the
      // compact one exactly at every viewport size; the old fixed X/Y scale
      // visibly jumped whenever the canvas dimensions differed from its
      // original tuning viewport.
      preview.style.setProperty("--git-preview-scale-x", String(island.offsetWidth / preview.offsetWidth));
      preview.style.setProperty("--git-preview-scale-y", String(island.offsetHeight / preview.offsetHeight));
    }
    setExpanded((current) => !current);
  }

  return (
    <>
      <div
        ref={islandRef}
        className="klide-focus-git-island"
        data-preview-open={expanded || undefined}
        data-ping={pinging ? "true" : undefined}
        role="group"
        aria-label="Git graph summary"
      >
        <div className="klide-focus-git-island-header">
          <span className="klide-focus-git-island-title">
            <ProfilePicture avatarUrl={avatarUrl} initials={profileInitials} />
            <span>Git</span>
          </span>
          <span className="klide-focus-git-island-meta">
            {changeCount > 0 ? `${changeCount} change${changeCount === 1 ? "" : "s"}` : branch || "Repository"}
          </span>
        </div>

        <div className="klide-focus-git-island-body">
          {commits === null ? (
            <span className="klide-focus-git-island-empty">Loading history…</span>
          ) : unavailable || islandRows.length === 0 ? (
            <span className="klide-focus-git-island-empty">{unavailable ? "Not a Git repository" : "No commits yet"}</span>
          ) : islandRows.map((row) => (
            <span className="klide-focus-git-island-row" key={row.commit.hash}>
              <PreviewGraphCell row={row} width={graphWidth} isHead={row.commit.hash === headHash} rowHeight={ISLAND_ROW_HEIGHT} />
              <span className="klide-focus-git-island-subject">{row.commit.subject}</span>
              <span className="klide-focus-git-island-hash">{row.commit.shortHash}</span>
            </span>
          ))}
        </div>
      </div>

      <div
        className="klide-focus-git-window-actions"
        data-expanded={expanded || undefined}
        role="group"
        aria-label="Git preview actions"
      >
        <button
          type="button"
          onClick={toggleExpanded}
          aria-label={expanded ? "Shrink Git preview" : "Expand Git preview"}
          aria-expanded={expanded}
          title={expanded ? "Shrink" : "Expand"}
        >
          <WindowSizeIcon expanded={expanded} />
        </button>
        <button
          type="button"
          onClick={() => {
            setExpanded(false);
            onOpen();
          }}
          aria-label="Open Git Review"
          title="Open Git Review"
        >
          <svg className="klide-focus-git-island-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </button>
      </div>

      <aside
        ref={previewRef}
        className="klide-focus-git-preview"
        data-open={expanded || undefined}
        aria-hidden={!expanded}
        aria-label="Git graph preview"
      >
        <div className="klide-focus-git-preview-header">
          <ProfilePicture avatarUrl={avatarUrl} initials={profileInitials} />
          <div className="klide-focus-git-preview-heading">
            <span>Git graph</span>
            <small>
              <span>{branch || "Repository"}</span>
              {/* Two facts, set apart by space rather than a dot. A folder that
                  isn't a repository has no working tree to call clean. */}
              {!unavailable && (
                <span style={{ marginLeft: 10 }}>
                  {changeCount > 0 ? `${changeCount} change${changeCount === 1 ? "" : "s"}` : "clean"}
                </span>
              )}
            </small>
          </div>
        </div>

        <div className="klide-focus-git-preview-list">
          {commits === null ? (
            <div className="klide-focus-git-preview-empty">Loading history…</div>
          ) : unavailable || sideRows.length === 0 ? (
            <div className="klide-focus-git-preview-empty">{unavailable ? "Not a Git repository" : "No commits yet"}</div>
          ) : sideRows.map((row) => (
            <div className="klide-focus-git-preview-row" key={row.commit.hash} title={`${row.commit.shortHash} · ${row.commit.author}\n${row.commit.subject}`}>
              <PreviewGraphCell row={row} width={graphWidth} isHead={row.commit.hash === headHash} rowHeight={PREVIEW_ROW_HEIGHT} />
              <div className="klide-focus-git-preview-copy">
                <span>{row.commit.subject}</span>
                <small>{row.commit.author}</small>
              </div>
              <code>{row.commit.shortHash}</code>
            </div>
          ))}
        </div>

      </aside>
    </>
  );
});
