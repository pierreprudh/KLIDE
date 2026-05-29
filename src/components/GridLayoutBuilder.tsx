import { useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  GRID_COLS,
  GRID_ROWS,
  PANEL_KINDS,
  SHAPES,
  canPlace,
  loadGridLayouts,
  makeGridId,
  panelLabel,
  saveGridLayouts,
  type GridArea,
  type GridLayout,
  type PanelKind,
} from "../gridLayouts";

type DragShape = { w: number; h: number; label: string } | null;
type Cell = { x: number; y: number } | null;

const GRID_GAP = 6;

export function GridLayoutBuilder() {
  const [areas, setAreas] = useState<GridArea[]>([]);
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dragShape, setDragShape] = useState<DragShape>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [hover, setHover] = useState<Cell>(null);
  const [drawOrigin, setDrawOrigin] = useState<Cell>(null);
  const [saved, setSaved] = useState<GridLayout[]>(() => loadGridLayouts());

  const gridRef = useRef<HTMLDivElement>(null);

  // Which grid cell is under a viewport point (null if outside the grid).
  function cellFromPoint(clientX: number, clientY: number): Cell {
    const el = gridRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom)
      return null;
    return clampedCellFromPoint(clientX, clientY);
  }

  // Like cellFromPoint, but clamps to the nearest in-grid cell even when the
  // pointer strays outside — so a draw drag can extend to the edges smoothly.
  function clampedCellFromPoint(clientX: number, clientY: number): Cell {
    const el = gridRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cw = r.width / GRID_COLS;
    const ch = r.height / GRID_ROWS;
    const x = Math.floor((clientX - r.left) / cw);
    const y = Math.floor((clientY - r.top) / ch);
    return {
      x: Math.max(0, Math.min(GRID_COLS - 1, x)),
      y: Math.max(0, Math.min(GRID_ROWS - 1, y)),
    };
  }

  function boundingRect(a: Cell, b: Cell) {
    if (!a || !b) return null;
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(a.x - b.x) + 1,
      h: Math.abs(a.y - b.y) + 1,
    };
  }

  // Origin clamped so the shape always lands fully inside the grid.
  function candidateFor(shape: DragShape, cell: Cell) {
    if (!shape || !cell) return null;
    const x = Math.max(0, Math.min(cell.x, GRID_COLS - shape.w));
    const y = Math.max(0, Math.min(cell.y, GRID_ROWS - shape.h));
    return { x, y, w: shape.w, h: shape.h };
  }

  // The footprint to show — either the dragged palette shape, or the rectangle
  // currently being drawn by holding across cells.
  const drawRect = boundingRect(drawOrigin, hover);
  const candidate = drawRect ?? candidateFor(dragShape, hover);
  const candidateOk = candidate ? canPlace(candidate, areas) : false;

  function startDraw(e: ReactMouseEvent<HTMLDivElement>) {
    if (dragShape) return; // a palette drag is already in progress
    e.preventDefault();
    const origin = clampedCellFromPoint(e.clientX, e.clientY);
    if (!origin) return;
    setDrawOrigin(origin);
    setHover(origin);
    document.body.style.userSelect = "none";

    function onMove(ev: MouseEvent) {
      setHover(clampedCellFromPoint(ev.clientX, ev.clientY));
    }
    function onUp(ev: MouseEvent) {
      const end = clampedCellFromPoint(ev.clientX, ev.clientY);
      const rect = boundingRect(origin, end);
      if (rect) {
        setAreas((cur) =>
          canPlace(rect, cur)
            ? [...cur, { id: makeGridId("area"), ...rect, panel: null }]
            : cur
        );
      }
      setDrawOrigin(null);
      setHover(null);
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function startDrag(
    shape: { w: number; h: number; label: string },
    e: ReactMouseEvent<HTMLDivElement>
  ) {
    e.preventDefault();
    setDragShape(shape);
    setPointer({ x: e.clientX, y: e.clientY });
    setHover(cellFromPoint(e.clientX, e.clientY));
    document.body.style.userSelect = "none";

    function onMove(ev: MouseEvent) {
      setPointer({ x: ev.clientX, y: ev.clientY });
      setHover(cellFromPoint(ev.clientX, ev.clientY));
    }
    function onUp(ev: MouseEvent) {
      const cell = cellFromPoint(ev.clientX, ev.clientY);
      const cand = candidateFor(shape, cell);
      if (cand) {
        // Use the functional updater so the overlap check sees current areas.
        setAreas((cur) =>
          canPlace(cand, cur)
            ? [...cur, { id: makeGridId("area"), ...cand, panel: null }]
            : cur
        );
      }
      setDragShape(null);
      setPointer(null);
      setHover(null);
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function assign(id: string, panel: PanelKind | null) {
    setAreas((cur) => cur.map((a) => (a.id === id ? { ...a, panel } : a)));
  }

  function removeArea(id: string) {
    setAreas((cur) => cur.filter((a) => a.id !== id));
  }

  function clearAll() {
    setAreas([]);
    setName("");
    setEditingId(null);
  }

  function persist(next: GridLayout[]) {
    setSaved(next);
    saveGridLayouts(next);
  }

  function saveLayout() {
    const trimmed = name.trim() || "Untitled grid";
    const layout: GridLayout = {
      id: editingId ?? makeGridId("grid"),
      name: trimmed,
      cols: GRID_COLS,
      rows: GRID_ROWS,
      areas,
    };
    if (editingId && saved.some((l) => l.id === editingId)) {
      persist(saved.map((l) => (l.id === editingId ? layout : l)));
    } else {
      persist([...saved, layout]);
    }
    clearAll();
  }

  function loadLayout(layout: GridLayout) {
    setEditingId(layout.id);
    setName(layout.name);
    setAreas(layout.areas.map((a) => ({ ...a })));
  }

  function deleteLayout(id: string) {
    persist(saved.filter((l) => l.id !== id));
    if (editingId === id) clearAll();
  }

  const cells = Array.from({ length: GRID_COLS * GRID_ROWS }, (_, i) => ({
    x: i % GRID_COLS,
    y: Math.floor(i / GRID_COLS),
  }));

  const gridTemplate = {
    display: "grid" as const,
    gridTemplateColumns: `repeat(${GRID_COLS}, 1fr)`,
    gridTemplateRows: `repeat(${GRID_ROWS}, 1fr)`,
    gap: GRID_GAP,
  };

  return (
    <div style={{ padding: "16px 18px" }}>
      {/* Shape palette */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
        {SHAPES.map((shape) => {
          const isDragging =
            dragShape?.label === shape.label &&
            dragShape.w === shape.w &&
            dragShape.h === shape.h;
          return (
            <div
              key={shape.id}
              onMouseDown={(e) =>
                startDrag({ w: shape.w, h: shape.h, label: shape.label }, e)
              }
              title={`${shape.label} — ${shape.w}×${shape.h} · drag onto the grid`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 10px",
                borderRadius: "var(--radius-sm)",
                border: `1px solid ${isDragging ? "var(--accent)" : "var(--border-strong)"}`,
                background: isDragging ? "var(--accent-soft)" : "var(--bg-elevated)",
                cursor: "grab",
                userSelect: "none",
              }}
            >
              <ShapeGlyph w={shape.w} h={shape.h} />
              <span style={{ fontSize: 12, color: "var(--fg)" }}>{shape.label}</span>
            </div>
          );
        })}
      </div>

      {/* The grid canvas */}
      <div
        style={{
          position: "relative",
          height: 252,
          padding: 8,
          borderRadius: "var(--radius-md)",
          border: `1px solid ${dragShape ? "var(--accent)" : "var(--border)"}`,
          background: "var(--bg)",
          transition: "border-color var(--motion-med) var(--ease-out)",
        }}
      >
        {/* Layer 1: empty cells (visual guide) + draw surface */}
        <div
          ref={gridRef}
          onMouseDown={startDraw}
          style={{
            position: "absolute",
            inset: 8,
            ...gridTemplate,
            zIndex: 1,
            cursor: dragShape ? "default" : "crosshair",
          }}
        >
          {cells.map((cell) => (
            <div
              key={`${cell.x}-${cell.y}`}
              style={{
                borderRadius: "var(--radius-xs)",
                border: "1px dashed var(--border)",
                opacity: dragShape || drawOrigin ? 0.8 : 0.45,
                pointerEvents: "none",
              }}
            />
          ))}
        </div>

        {/* Layer 2: placed areas (container is click-through; blocks are not) */}
        <div
          style={{
            position: "absolute",
            inset: 8,
            ...gridTemplate,
            zIndex: 2,
            pointerEvents: "none",
          }}
        >
          {areas.map((area) => (
            <div
              key={area.id}
              style={{
                gridColumn: `${area.x + 1} / span ${area.w}`,
                gridRow: `${area.y + 1} / span ${area.h}`,
                position: "relative",
                borderRadius: "var(--radius-sm)",
                border: `1px solid ${area.panel ? "var(--accent)" : "var(--border-strong)"}`,
                background: area.panel ? "var(--accent-soft)" : "var(--bg-elevated)",
                display: "grid",
                placeItems: "center",
                padding: 6,
                // Blocks are interactive only when not dragging/drawing.
                pointerEvents: dragShape || drawOrigin ? "none" : "auto",
              }}
            >
              <select
                aria-label="Panel content"
                value={area.panel ?? ""}
                onChange={(e) =>
                  assign(area.id, (e.target.value || null) as PanelKind | null)
                }
                style={{
                  maxWidth: "100%",
                  height: 28,
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--border)",
                  background: "var(--bg)",
                  color: area.panel ? "var(--accent)" : "var(--fg-subtle)",
                  font: "inherit",
                  fontSize: 12,
                  padding: "0 8px",
                }}
              >
                <option value="">Pick panel…</option>
                {PANEL_KINDS.map((kind) => (
                  <option key={kind.id} value={kind.id}>
                    {kind.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                aria-label="Remove block"
                title="Remove block"
                onClick={() => removeArea(area.id)}
                style={{
                  position: "absolute",
                  top: 4,
                  right: 4,
                  width: 16,
                  height: 16,
                  borderRadius: "50%",
                  border: "none",
                  background: "var(--bg)",
                  color: "var(--fg-subtle)",
                  fontSize: 12,
                  lineHeight: "14px",
                  cursor: "pointer",
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>

        {/* Layer 3: live drop footprint */}
        {candidate && (
          <div style={{ position: "absolute", inset: 8, ...gridTemplate, zIndex: 3, pointerEvents: "none" }}>
            <div
              style={{
                gridColumn: `${candidate.x + 1} / span ${candidate.w}`,
                gridRow: `${candidate.y + 1} / span ${candidate.h}`,
                borderRadius: "var(--radius-sm)",
                border: `2px solid ${candidateOk ? "var(--accent)" : "var(--danger, #c0392b)"}`,
                background: candidateOk ? "var(--accent-soft)" : "rgba(192,57,43,0.14)",
              }}
            />
          </div>
        )}
      </div>

      {/* Cursor-following ghost while dragging */}
      {dragShape && pointer && (
        <div
          style={{
            position: "fixed",
            left: pointer.x + 14,
            top: pointer.y + 14,
            zIndex: 1000,
            pointerEvents: "none",
            padding: "5px 9px",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--accent)",
            background: "var(--accent-soft)",
            color: "var(--accent)",
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            gap: 7,
            boxShadow: "0 6px 18px rgba(0,0,0,0.18)",
          }}
        >
          <ShapeGlyph w={dragShape.w} h={dragShape.h} />
          {dragShape.label}
        </div>
      )}

      <div
        style={{
          marginTop: 8,
          fontSize: 11,
          color: "var(--fg-subtle)",
          fontFamily: "var(--font-ui)",
        }}
      >
        Drag a shape onto the grid, or hold and drag across empty cells to draw any
        size · pick a panel in each block (AI can repeat) · × to remove
      </div>

      {/* Builder actions */}
      <div style={{ marginTop: 14, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <input
          aria-label="Grid layout name"
          value={name}
          placeholder="Name this grid…"
          onChange={(e) => setName(e.target.value)}
          style={{
            flex: "1 1 200px",
            minWidth: 160,
            height: 34,
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--border)",
            background: "var(--bg-hover)",
            color: "var(--fg-strong)",
            font: "inherit",
            padding: "0 12px",
          }}
        />
        <button
          type="button"
          onClick={clearAll}
          style={{
            height: 34,
            padding: "0 14px",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--border)",
            background: "transparent",
            color: "var(--fg)",
            fontSize: 13,
          }}
        >
          Clear
        </button>
        <button
          type="button"
          onClick={saveLayout}
          disabled={areas.length === 0}
          style={{
            height: 34,
            padding: "0 16px",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--accent)",
            background: areas.length ? "var(--accent)" : "var(--bg-hover)",
            color: areas.length ? "#FFFFFF" : "var(--fg-subtle)",
            fontSize: 13,
            cursor: areas.length ? "pointer" : "not-allowed",
          }}
        >
          {editingId ? "Save changes" : "Save grid"}
        </button>
      </div>

      {/* Saved grids */}
      {saved.length > 0 && (
        <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 8 }}>
          {saved.map((layout) => (
            <div
              key={layout.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "10px 14px",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--border)",
                background: "var(--bg-elevated)",
              }}
            >
              <MiniGrid layout={layout} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ color: "var(--fg-strong)", fontSize: 14 }}>{layout.name}</div>
                <div
                  style={{
                    color: "var(--fg-subtle)",
                    fontSize: 12,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {layout.areas.length} block{layout.areas.length === 1 ? "" : "s"}
                  {" · "}
                  {layout.areas.map((a) => panelLabel(a.panel)).join(", ")}
                </div>
              </div>
              <button
                type="button"
                onClick={() => loadLayout(layout)}
                style={{
                  height: 30,
                  padding: "0 12px",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--fg)",
                  fontSize: 13,
                }}
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => deleteLayout(layout.id)}
                style={{
                  height: 30,
                  padding: "0 12px",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--fg)",
                  fontSize: 13,
                }}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ShapeGlyph({ w, h }: { w: number; h: number }) {
  return (
    <span
      aria-hidden
      style={{
        width: 22,
        height: 22,
        display: "grid",
        gridTemplateColumns: `repeat(${GRID_COLS}, 1fr)`,
        gridTemplateRows: `repeat(${GRID_ROWS}, 1fr)`,
        gap: 1,
      }}
    >
      <span
        style={{
          gridColumn: `1 / span ${w}`,
          gridRow: `1 / span ${h}`,
          background: "var(--accent)",
          borderRadius: 1,
        }}
      />
    </span>
  );
}

function MiniGrid({ layout }: { layout: GridLayout }) {
  return (
    <span
      style={{
        width: 56,
        height: 38,
        flex: "0 0 auto",
        display: "grid",
        gridTemplateColumns: `repeat(${layout.cols}, 1fr)`,
        gridTemplateRows: `repeat(${layout.rows}, 1fr)`,
        gap: 1,
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-xs)",
        padding: 2,
        background: "var(--bg)",
      }}
    >
      {layout.areas.map((area) => (
        <span
          key={area.id}
          title={panelLabel(area.panel)}
          style={{
            gridColumn: `${area.x + 1} / span ${area.w}`,
            gridRow: `${area.y + 1} / span ${area.h}`,
            background: area.panel ? "var(--accent)" : "var(--border-strong)",
            borderRadius: 1,
          }}
        />
      ))}
    </span>
  );
}
