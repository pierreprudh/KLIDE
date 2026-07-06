// Commit history graph for Git Review — a SourceTree-style lane graph
// rendered in Klide's language: hairline rows, the sage chart ramp for
// lanes, refs as quiet typography (no pills). Lives in the center pane
// whenever no file diff is open.
//
// Perf notes: the list is ~300 rows of SVG, so every layer is memoized —
// the component ignores parent re-renders (commit-box keystrokes), rows
// only re-render when their own selection flips, and dates go through ONE
// cached Intl formatter (per-call toLocaleDateString is ~0.3ms — 300 of
// those froze the pane). Do NOT add content-visibility here: WKWebView's
// compositor is fragile (see the backdrop-filter and zIndex incidents).

import { Component, memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { layoutGraph, splitRefs, type GraphCommit, type GraphRow } from "../gitGraph";

const ROW_H = 26;
const LANE_W = 12;
const GRAPH_PAD = 8;
const MAX_GRAPH_LANES = 10;
const LANE_COLORS = 7; // --chart-1 … --chart-7

function laneColor(index: number): string {
  return `var(--chart-${(index % LANE_COLORS) + 1})`;
}

function laneX(lane: number): number {
  return GRAPH_PAD + lane * LANE_W;
}

/** Top-half curve: row top at `from` down into the node at `to`. */
function topPath(from: number, to: number): string {
  const x1 = laneX(from);
  const x2 = laneX(to);
  const mid = ROW_H / 2;
  if (x1 === x2) return `M ${x1} 0 L ${x2} ${mid}`;
  return `M ${x1} 0 C ${x1} ${mid * 0.8}, ${x2} ${mid * 0.2}, ${x2} ${mid}`;
}

/** Bottom-half curve: node at `from` out to row bottom at `to`. */
function bottomPath(from: number, to: number): string {
  const x1 = laneX(from);
  const x2 = laneX(to);
  const mid = ROW_H / 2;
  if (x1 === x2) return `M ${x1} ${mid} L ${x2} ${ROW_H}`;
  return `M ${x1} ${mid} C ${x1} ${mid + mid * 0.8}, ${x2} ${mid + mid * 0.2}, ${x2} ${ROW_H}`;
}

const GraphCell = memo(function GraphCell({ row, width, isHead }: { row: GraphRow; width: number; isHead: boolean }) {
  const nodeX = laneX(row.lane);
  return (
    <svg width={width} height={ROW_H} style={{ display: "block", flexShrink: 0 }} aria-hidden>
      {row.passThrough.map((l) => (
        <line key={`p${l.lane}`} x1={laneX(l.lane)} y1={0} x2={laneX(l.lane)} y2={ROW_H} stroke={laneColor(l.color)} strokeWidth={1.5} />
      ))}
      {row.intoNode.map((l) => (
        <path key={`i${l.lane}`} d={topPath(l.lane, row.lane)} stroke={laneColor(l.color)} strokeWidth={1.5} fill="none" />
      ))}
      {row.outOfNode.map((l, i) => (
        <path key={`o${i}-${l.lane}`} d={bottomPath(row.lane, l.lane)} stroke={laneColor(l.color)} strokeWidth={1.5} fill="none" />
      ))}
      {isHead ? (
        <circle cx={nodeX} cy={ROW_H / 2} r={3.5} fill="var(--bg)" stroke={laneColor(row.color)} strokeWidth={2} />
      ) : (
        <circle cx={nodeX} cy={ROW_H / 2} r={3} fill={laneColor(row.color)} />
      )}
    </svg>
  );
});

const RefLabels = memo(function RefLabels({ refs }: { refs: string[] }) {
  const parts = splitRefs(refs);
  if (parts.length === 0) return null;
  return (
    <>
      {parts.map((part) => (
        <span
          key={`${part.kind}:${part.name}`}
          title={part.kind === "tag" ? `tag ${part.name}` : part.name}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10.5,
            flexShrink: 0,
            fontWeight: part.kind === "head" ? 700 : 600,
            fontStyle: part.kind === "tag" ? "italic" : undefined,
            color:
              part.kind === "head" ? "var(--accent)"
              : part.kind === "local" ? "var(--fg-strong)"
              : "var(--fg-subtle)",
          }}
        >
          {part.name}
        </span>
      ))}
    </>
  );
});

// One shared formatter — constructing Intl.DateTimeFormat per call is the
// single most expensive thing this component can do.
const dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

const selectedBg = "color-mix(in srgb, var(--accent-soft) 70%, transparent)";

const HistoryRow = memo(function HistoryRow({
  row,
  graphW,
  isHead,
  isSelected,
  onSelect,
}: {
  row: GraphRow;
  graphW: number;
  isHead: boolean;
  isSelected: boolean;
  onSelect: (hash: string) => void;
}) {
  const c = row.commit;
  return (
    <div
      onClick={() => onSelect(c.hash)}
      title={`${c.shortHash} · ${c.author}\n${c.subject}`}
      style={{
        height: ROW_H,
        display: "flex",
        alignItems: "center",
        padding: "0 14px 0 0",
        cursor: "default",
        background: isSelected ? selectedBg : undefined,
      }}
      onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = isSelected ? selectedBg : ""; }}
    >
      <GraphCell row={row} width={graphW} isHead={isHead} />
      <span style={{ width: 72, flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 11, color: isHead ? "var(--fg-strong)" : "var(--fg-subtle)", fontWeight: isHead ? 600 : 400 }}>
        {c.shortHash}
      </span>
      <span style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8, overflow: "hidden" }}>
        <RefLabels refs={c.refs} />
        <span style={{ fontSize: 12, color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {c.subject}
        </span>
      </span>
      <span style={{ width: 118, flexShrink: 0, fontSize: 11.5, color: "var(--fg-subtle)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: 8 }}>
        {c.author}
      </span>
      <span style={{ width: 92, flexShrink: 0, fontSize: 11, color: "var(--fg-dim)", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
        {dateFmt.format(c.timestamp * 1000)}
      </span>
    </div>
  );
});

const headerCellStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--fg-dim)",
};

type Props = {
  workspaceRoot: string | null;
  /** Any value that changes when history may have moved (commit, pull, …). */
  refreshToken?: unknown;
};

/** If anything in the graph throws at render time, fail to a quiet message
 *  instead of unmounting the whole app (there is no boundary above us). */
class GraphBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ flex: 1, display: "grid", placeItems: "center", color: "var(--fg-subtle)", fontSize: 13, textAlign: "center", padding: 24 }}>
          <div>
            <div style={{ color: "var(--fg)", marginBottom: 4, fontWeight: 600 }}>History graph failed to render</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{this.state.error}</div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const GitHistoryGraphInner = memo(function GitHistoryGraphInner({ workspaceRoot, refreshToken }: Props) {
  const [commits, setCommits] = useState<GraphCommit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceRoot) return;
    let cancelled = false;
    invoke<GraphCommit[]>("git_graph", { workspaceRoot, limit: 300 })
      .then((c) => { if (!cancelled) { setCommits(c); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [workspaceRoot, refreshToken]);

  const rows = useMemo(() => (commits ? layoutGraph(commits) : []), [commits]);
  const graphW = useMemo(() => {
    const lanes = Math.min(MAX_GRAPH_LANES, Math.max(1, ...rows.map((r) => r.width)));
    return GRAPH_PAD * 2 + (lanes - 1) * LANE_W;
  }, [rows]);
  const headHash = useMemo(
    () => commits?.find((c) => c.refs.some((r) => r.startsWith("HEAD -> ")))?.hash ?? null,
    [commits]
  );
  const onSelect = useCallback((hash: string) => {
    setSelected((prev) => (prev === hash ? null : hash));
  }, []);

  if (error) {
    return (
      <div style={{ flex: 1, display: "grid", placeItems: "center", color: "var(--fg-subtle)", fontSize: 13, textAlign: "center", padding: 24 }}>
        <div>
          <div style={{ color: "var(--fg)", marginBottom: 4, fontWeight: 600 }}>No history yet</div>
          <div>{error}</div>
        </div>
      </div>
    );
  }
  if (!commits) {
    return <div style={{ flex: 1, display: "grid", placeItems: "center", color: "var(--fg-dim)", fontSize: 12 }}>Loading history…</div>;
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {/* Column headers */}
      <div
        className="pane-inset-top"
        style={{ height: 28, flexShrink: 0, display: "flex", alignItems: "center", borderBottom: "1px solid var(--border)", padding: "0 14px 0 0" }}
      >
        <span style={{ ...headerCellStyle, width: graphW, paddingLeft: GRAPH_PAD }}>Graph</span>
        <span style={{ ...headerCellStyle, width: 72 }}>Commit</span>
        <span style={{ ...headerCellStyle, flex: 1 }}>Description</span>
        <span style={{ ...headerCellStyle, width: 118 }}>Author</span>
        <span style={{ ...headerCellStyle, width: 92, textAlign: "right" }}>Date</span>
      </div>
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {rows.map((row) => (
          <HistoryRow
            key={row.commit.hash}
            row={row}
            graphW={graphW}
            isHead={row.commit.hash === headHash}
            isSelected={selected === row.commit.hash}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
});

export function GitHistoryGraph(props: Props) {
  return (
    <GraphBoundary>
      <GitHistoryGraphInner {...props} />
    </GraphBoundary>
  );
}
