// Freeform grid layouts — drag predefined shapes onto a blank grid, then assign
// a panel to each block. Unlike the fixed-frame presets in layouts.ts, this lets
// you place any panel (including several AI panels, or Git) anywhere, and control
// height via the grid rows.
//
// Designer-only for now: these are built + saved here; wiring them to re-render
// the real workbench is a separate step.

export type PanelKind =
  | "editor"
  | "files"
  | "git"
  | "graph"
  | "skills"
  | "terminal"
  | "ai";

export const PANEL_KINDS: { id: PanelKind; label: string }[] = [
  { id: "editor", label: "Editor" },
  { id: "files", label: "Files" },
  { id: "git", label: "Git" },
  { id: "graph", label: "Project Graph" },
  { id: "skills", label: "Skills" },
  { id: "terminal", label: "Terminal" },
  { id: "ai", label: "AI" },
];

export function panelLabel(panel: PanelKind | null): string {
  return PANEL_KINDS.find((kind) => kind.id === panel)?.label ?? "Empty";
}

export const GRID_COLS = 6;
export const GRID_ROWS = 4;

export type GridArea = {
  id: string;
  x: number; // column start, 0-based
  y: number; // row start, 0-based
  w: number; // column span
  h: number; // row span
  panel: PanelKind | null;
};

export type GridLayout = {
  id: string;
  name: string;
  cols: number;
  rows: number;
  areas: GridArea[];
};

// The shapes you drag from the palette (footprints in grid cells).
export const SHAPES: { id: string; label: string; w: number; h: number }[] = [
  { id: "1x1", label: "Square", w: 1, h: 1 },
  { id: "2x1", label: "Wide", w: 2, h: 1 },
  { id: "3x1", label: "Long", w: 3, h: 1 },
  { id: "1x2", label: "Tall", w: 1, h: 2 },
  { id: "1x3", label: "Tall+", w: 1, h: 3 },
  { id: "1x4", label: "Column", w: 1, h: GRID_ROWS },
  { id: "2x2", label: "Block", w: 2, h: 2 },
  { id: "2x4", label: "Side", w: 2, h: GRID_ROWS },
  { id: "3x2", label: "Quarter", w: 3, h: 2 },
  { id: "3x4", label: "Half", w: 3, h: 4 },
  { id: "6x1", label: "Full row", w: GRID_COLS, h: 1 },
  { id: "6x4", label: "Full", w: GRID_COLS, h: GRID_ROWS },
];

type Rect = { x: number; y: number; w: number; h: number };

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function fitsGrid(
  rect: Rect,
  cols = GRID_COLS,
  rows = GRID_ROWS
): boolean {
  return (
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.x + rect.w <= cols &&
    rect.y + rect.h <= rows
  );
}

export function canPlace(rect: Rect, areas: GridArea[]): boolean {
  return fitsGrid(rect) && !areas.some((area) => overlaps(area, rect));
}

const STORE_KEY = "klide-grid-layouts";

export function loadGridLayouts(): GridLayout[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as GridLayout[]) : [];
  } catch {
    return [];
  }
}

export function saveGridLayouts(layouts: GridLayout[]): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(layouts));
}

export function makeGridId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}
