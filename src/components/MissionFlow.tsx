// MissionFlow — a Mission's task graph as cards on a dotted canvas, read top
// to bottom: each dependency layer is a row, prerequisites above dependents,
// joined by measured connectors. It is the picture of a plan, built to sit in
// a conversation as readily as in Mission Control, so it owns no state the
// store doesn't: layout is `layoutMission` over the tasks' own dependencies,
// the status mark is the plan strip's `StepMark`, and the only local state is
// which card is lit and where a card was dragged this session.
//
// What it deliberately is not: a node editor. Dragging rearranges the view,
// never the plan; dependency edits stay on the detail panel, which writes the
// task's Markdown back. No pills, no dots, no shadows — a card is a hairline
// box, a status is a word, a lit card is a ring.
import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { layoutMission, type GraphTask } from "../agent/missionGraph";
import type { MissionTaskStatus } from "../agent/missionHarness";
import { presentMissionCardTone, toneColor } from "../runPresentation";
import { StepMark } from "./TodoStrip";
import "./todoStrip.css";

export type MissionFlowMeta = {
  title: string;
  /** Understand / Build / Verify — the small line above the card. */
  phase?: string;
  status: MissionTaskStatus | string;
  /** The caption under the title: who does it, or what it waits on. */
  caption?: string;
};

type MissionFlowProps = {
  tasks: GraphTask[];
  meta: Record<string, MissionFlowMeta>;
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** Cards may be dragged around the canvas (view-only, this session). */
  draggable?: boolean;
};

const CARD_W = 272;
const CARD_EST_H = 64;
const COL_GAP = 28;
const ROW_GAP = 56;
const PAD_X = 24;
const PAD_Y = 22;
const PHASE_H = 18; // the phase line sits above the card inside its slot

function markState(status: string): "todo" | "active" | "done" {
  if (status === "done") return "done";
  if (status === "running" || status === "validating") return "active";
  return "todo";
}

export function MissionFlow({ tasks, meta, selected, onSelect, draggable = true }: MissionFlowProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const [width, setWidth] = useState(0);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [offsets, setOffsets] = useState<Record<string, { dx: number; dy: number }>>({});
  const drag = useRef<{ id: string; startX: number; startY: number; baseDx: number; baseDy: number; moved: boolean } | null>(null);

  const { nodes, edges } = layoutMission(tasks);
  const order = new Map(nodes.map((node) => [node.id, node]));

  // Measure the canvas and every card; heights come from the DOM so a long
  // title or caption never clips, and the rows re-flow when the font lands.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => {
      setWidth(canvas.clientWidth);
      setHeights((prev) => {
        const next = { ...prev };
        let changed = false;
        cardRefs.current.forEach((el, id) => {
          const h = el.offsetHeight;
          if (h && Math.abs(h - (next[id] ?? 0)) > 0.5) {
            next[id] = h;
            changed = true;
          }
        });
        return changed ? next : prev;
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    cardRefs.current.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [tasks.length]);

  // Rows: one per dependency layer, each as tall as its tallest card.
  const layers = [...new Set(nodes.map((node) => node.layer))].sort((a, b) => a - b);
  const rowH = layers.map((layer) =>
    Math.max(CARD_EST_H, ...nodes.filter((node) => node.layer === layer).map((node) => heights[node.id] ?? CARD_EST_H))
  );
  const rowY: number[] = [];
  layers.forEach((_, i) => {
    rowY[i] = i === 0 ? PAD_Y : rowY[i - 1] + rowH[i - 1] + PHASE_H + ROW_GAP;
  });
  const lastRow = layers.length - 1;
  const canvasH = layers.length ? rowY[lastRow] + rowH[lastRow] + PHASE_H + PAD_Y : PAD_Y * 2 + CARD_EST_H;

  const cw = width || 560;
  // The widest row must fit: cards narrow together before any of them wraps.
  const widestRow = Math.max(1, ...layers.map((layer) => nodes.filter((node) => node.layer === layer).length));
  const cardW = Math.max(150, Math.min(CARD_W, (cw - PAD_X * 2 - (widestRow - 1) * COL_GAP) / widestRow));

  // The phase line is written once per run of a phase in reading order, so a
  // row of three Build tasks says "Build" once, not three times.
  const phaseShown = new Set<string>();
  {
    let last: string | undefined;
    for (const node of [...nodes].sort((a, b) => a.layer - b.layer || a.order - b.order)) {
      const phase = meta[node.id]?.phase;
      if (phase && phase !== last) phaseShown.add(node.id);
      last = phase;
    }
  }

  // A card's slot: its row, centred as a group with its layer siblings.
  function place(id: string) {
    const node = order.get(id);
    if (!node) return null;
    const siblings = nodes.filter((n) => n.layer === node.layer).length;
    const groupW = siblings * cardW + (siblings - 1) * COL_GAP;
    const left0 = (cw - groupW) / 2 + node.order * (cardW + COL_GAP);
    const off = offsets[id];
    return {
      left: Math.max(PAD_X / 2, left0) + (off?.dx ?? 0),
      top: rowY[layers.indexOf(node.layer)] + (off?.dy ?? 0),
      h: heights[id] ?? CARD_EST_H,
    };
  }

  function connector(edge: { from: string; to: string }) {
    const a = place(edge.from);
    const b = place(edge.to);
    if (!a || !b) return null;
    const x1 = a.left + cardW / 2;
    const y1 = a.top + PHASE_H + a.h;
    const x2 = b.left + cardW / 2;
    const y2 = b.top + PHASE_H;
    const k = Math.min(Math.max(Math.abs(y2 - y1) * 0.55, 20), 72);
    return `M ${x1} ${y1} C ${x1} ${y1 + k}, ${x2} ${y2 - k}, ${x2} ${y2}`;
  }

  // ── drag (view only) ──
  function onPointerDown(id: string) {
    return (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!draggable || event.button !== 0) return;
      const off = offsets[id];
      drag.current = { id, startX: event.clientX, startY: event.clientY, baseDx: off?.dx ?? 0, baseDy: off?.dy ?? 0, moved: false };
      event.currentTarget.setPointerCapture(event.pointerId);
    };
  }
  function onPointerMove(id: string) {
    return (event: ReactPointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d || d.id !== id) return;
      const dx = d.baseDx + event.clientX - d.startX;
      const dy = d.baseDy + event.clientY - d.startY;
      if (!d.moved && Math.hypot(dx - d.baseDx, dy - d.baseDy) < 3) return;
      d.moved = true;
      setOffsets((current) => ({ ...current, [id]: { dx, dy } }));
    };
  }
  function onPointerUp(id: string) {
    return () => {
      const d = drag.current;
      if (d?.id !== id) return;
      // A real drag must not also toggle the card; let the click see `moved`.
      if (d.moved) setTimeout(() => { drag.current = null; }, 0);
      else drag.current = null;
    };
  }

  const lit = (edge: { from: string; to: string }) => selected !== null && (edge.from === selected || edge.to === selected);

  return (
    <div
      ref={canvasRef}
      onClick={() => onSelect(null)}
      style={{
        position: "relative",
        width: "100%",
        height: canvasH,
        overflow: "hidden",
        userSelect: "none",
        borderRadius: "var(--radius-lg)",
        background: "var(--bg)",
        backgroundImage: "radial-gradient(color-mix(in srgb, var(--border-strong) 55%, transparent) 1px, transparent 1.25px)",
        backgroundSize: "22px 22px",
        backgroundPosition: "center",
        transition: "height 220ms var(--ease-out)",
      }}
    >
      <svg width={cw} height={canvasH} aria-hidden style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        {edges.map((edge) => {
          const d = connector(edge);
          if (!d) return null;
          return (
            <path
              key={`${edge.from}->${edge.to}`}
              d={d}
              fill="none"
              stroke={lit(edge) ? "var(--accent)" : "var(--border-strong)"}
              strokeWidth={1.25}
              style={{ transition: "stroke 150ms var(--ease-out)" }}
            />
          );
        })}
      </svg>

      {nodes.map((node, i) => {
        const p = place(node.id);
        if (!p) return null;
        const m = meta[node.id];
        const status = String(m?.status ?? "queued");
        const tone = presentMissionCardTone(status as MissionTaskStatus);
        const active = selected === node.id;
        const quietWord = status === "queued" || status === "ready" || status === "done";
        return (
          <div
            key={node.id}
            ref={(el) => { if (el) cardRefs.current.set(node.id, el); else cardRefs.current.delete(node.id); }}
            onPointerDown={onPointerDown(node.id)}
            onPointerMove={onPointerMove(node.id)}
            onPointerUp={onPointerUp(node.id)}
            style={{
              position: "absolute",
              left: p.left,
              top: p.top,
              width: cardW,
              touchAction: "none",
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: 4,
              zIndex: drag.current?.id === node.id ? 2 : 1,
              cursor: draggable ? "grab" : "default",
            }}
          >
            <span style={{ height: PHASE_H - 4, fontSize: 11, lineHeight: `${PHASE_H - 4}px`, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--fg-dim)", paddingLeft: 2 }}>
              {phaseShown.has(node.id) ? m?.phase : ""}
            </span>
            <button
              type="button"
              aria-pressed={active}
              onClick={(event) => {
                event.stopPropagation();
                if (drag.current?.moved) return;
                onSelect(active ? null : node.id);
              }}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 12px",
                textAlign: "left",
                cursor: "pointer",
                background: "var(--bg-elevated)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-lg)",
                boxShadow: active ? "0 0 0 1px var(--accent)" : "none",
                borderColor: active ? "var(--accent)" : "var(--border)",
                color: "inherit",
                font: "inherit",
                transition: "border-color 150ms var(--ease-out), box-shadow 150ms var(--ease-out)",
              }}
            >
              <StepMark index={i} state={markState(status)} />
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ fontSize: 13, fontWeight: status === "running" || status === "ready" ? 600 : 500, lineHeight: 1.3, color: "var(--fg-strong)", overflow: "hidden", display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2 }}>
                  {m?.title ?? node.id}
                </span>
                <span style={{ display: "block", marginTop: 2, fontSize: 11.5, lineHeight: 1.4, color: "var(--fg-subtle)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {!quietWord && (
                    <span style={{ fontFamily: "var(--font-mono)", color: toneColor(tone) }}>{status}</span>
                  )}
                  {!quietWord && m?.caption && <span style={{ color: "var(--fg-dim)" }}> · </span>}
                  {m?.caption}
                </span>
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
