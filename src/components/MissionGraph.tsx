// MissionGraph — the dependency-graph view of a Mission's tasks.
//
// It is a pure projection of the same `dependencies` the tier board and the
// durable Markdown read (v0.6 slice 2: no second graph state model). Layout and
// the acyclic check come from `missionGraph.ts`; edge edits are toggled back
// through the task's Markdown via `onToggleDependency`, so the graph never owns
// state the store doesn't. Status reads through a left spine + type weight
// (Klide idiom: no chips or dots).
import { useState } from "react";
import { layoutMission, wouldCreateCycle, type GraphTask } from "../agent/missionGraph";

export type MissionGraphMeta = {
  title: string;
  phase: string;
  /** Compiled task status: queued | ready | blocked | running | done | failed | … */
  status: string;
};

type MissionGraphProps = {
  tasks: GraphTask[];
  meta: Record<string, MissionGraphMeta>;
  editable: boolean;
  savingTaskId: string | null;
  onToggleDependency: (dependentId: string, prerequisiteId: string) => void;
};

const NODE_W = 156;
const NODE_H = 52;
const COL_GAP = 76;
const ROW_GAP = 20;
const PAD = 20;

function spineColor(status: string): string {
  if (status === "done") return "var(--accent)";
  if (status === "running") return "var(--accent)";
  if (status === "failed") return "var(--danger)";
  if (status === "ready") return "var(--fg-strong)";
  return "var(--border-strong)"; // queued / blocked
}

export function MissionGraph({ tasks, meta, editable, savingTaskId, onToggleDependency }: MissionGraphProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const { nodes, edges, layerCount } = layoutMission(tasks);

  // Center each layer's rows against the tallest layer so the graph reads
  // balanced rather than top-heavy.
  const rowsPerLayer = new Map<number, number>();
  for (const node of nodes) rowsPerLayer.set(node.layer, (rowsPerLayer.get(node.layer) ?? 0) + 1);
  const maxRows = Math.max(1, ...rowsPerLayer.values());

  const pos = new Map<string, { x: number; y: number }>();
  for (const node of nodes) {
    const rows = rowsPerLayer.get(node.layer) ?? 1;
    const offset = ((maxRows - rows) * (NODE_H + ROW_GAP)) / 2;
    pos.set(node.id, {
      x: PAD + node.layer * (NODE_W + COL_GAP),
      y: PAD + offset + node.order * (NODE_H + ROW_GAP),
    });
  }

  const width = PAD * 2 + layerCount * NODE_W + (layerCount - 1) * COL_GAP;
  const height = PAD * 2 + maxRows * NODE_H + (maxRows - 1) * ROW_GAP;

  function onNodeClick(id: string) {
    if (!editable) return;
    if (selected === null) {
      setSelected(id);
      return;
    }
    if (selected === id) {
      setSelected(null);
      return;
    }
    if (isBlockedTarget(id)) return; // linking here would close a loop
    // First click = prerequisite, second = the task that depends on it.
    onToggleDependency(id, selected);
    setSelected(null);
  }

  // A candidate target is blocked only when linking it would close a loop.
  // Clicking an already-linked pair (to unlink) is always allowed.
  function isBlockedTarget(id: string): boolean {
    if (selected === null || id === selected) return false;
    if (tasks.find((task) => task.id === id)?.dependencies.includes(selected)) return false;
    return wouldCreateCycle(tasks, id, selected);
  }

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", background: "var(--bg-elevated)", overflow: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
        <span style={{ fontSize: 11.5, color: "var(--fg-subtle)", lineHeight: 1.5 }}>
          {editable
            ? selected
              ? "Click the task that depends on the selected prerequisite. Click it again to clear."
              : "Click a prerequisite, then the task that depends on it, to link them. Click a linked pair to unlink."
            : "Approved plan — the dependency graph is read-only."}
        </span>
      </div>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: "block", minWidth: "100%" }}>
        <defs>
          <marker id="klide-graph-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M1 1 L7 4 L1 7" fill="none" stroke="var(--border-strong)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </marker>
        </defs>
        {edges.map((edge) => {
          const a = pos.get(edge.from);
          const b = pos.get(edge.to);
          if (!a || !b) return null;
          const x1 = a.x + NODE_W;
          const y1 = a.y + NODE_H / 2;
          const x2 = b.x;
          const y2 = b.y + NODE_H / 2;
          const mid = (x1 + x2) / 2;
          const touchesSel = selected !== null && (edge.from === selected || edge.to === selected);
          return (
            <path
              key={`${edge.from}->${edge.to}`}
              d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2 - 3} ${y2}`}
              fill="none"
              stroke={touchesSel ? "var(--accent)" : "var(--border-strong)"}
              strokeWidth={touchesSel ? 1.8 : 1.3}
              markerEnd="url(#klide-graph-arrow)"
              style={{ transition: "stroke 140ms var(--ease-out)" }}
            />
          );
        })}
        {nodes.map((node) => {
          const p = pos.get(node.id);
          if (!p) return null;
          const m = meta[node.id];
          const status = m?.status ?? "queued";
          const isSelected = selected === node.id;
          const blocked = isBlockedTarget(node.id);
          const saving = savingTaskId === node.id;
          return (
            <g
              key={node.id}
              transform={`translate(${p.x}, ${p.y})`}
              onClick={() => onNodeClick(node.id)}
              style={{ cursor: editable ? (blocked ? "not-allowed" : "pointer") : "default", opacity: blocked ? 0.4 : 1 }}
            >
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={8}
                fill="var(--bg)"
                stroke={isSelected ? "var(--accent)" : "var(--border)"}
                strokeWidth={isSelected ? 1.6 : 1}
              />
              <rect width={3} height={NODE_H} rx={1.5} fill={spineColor(status)} />
              <text x={14} y={21} fontSize={12} fontWeight={status === "ready" || status === "running" ? 600 : 500} fill="var(--fg-strong)" style={{ pointerEvents: "none" }}>
                {truncate(m?.title ?? node.id, 20)}
              </text>
              <text x={14} y={38} fontSize={10} fill="var(--fg-dim)" fontFamily="var(--font-mono)" style={{ pointerEvents: "none" }}>
                {saving ? "saving…" : `${m?.phase ?? ""} · ${status}`}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
