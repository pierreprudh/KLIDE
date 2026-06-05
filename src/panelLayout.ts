// Bento-style panel layout. Each panel (other than the fixed activity bar
// and the editor surface) is a free-floating rectangle inside the workbench
// area. The user can resize any panel from its right, bottom, or corner
// edges. Layouts are saved per-workspace so switching projects keeps each
// project's preferred arrangement.

export type PanelId =
  | "explorer"
  | "git"
  | "graph"
  | "memory"
  | "terminal"
  | "ai";

export type PanelRect = {
  x: number; // left edge, in px from the workbench origin (right of activity bar)
  y: number; // top edge, in px from the workbench origin
  w: number; // width in px
  h: number; // height in px
};

// "ai" is special: the user can spawn multiple AI panels (one per
// provider / conversation), and each one carries its own rect so they
// can be dragged and resized independently instead of all sharing one
// box split down the middle.
export type Layout = {
  explorer?: PanelRect;
  git?: PanelRect;
  graph?: PanelRect;
  memory?: PanelRect;
  terminal?: PanelRect;
  ai?: PanelRect[];
};

export type PanelConstraints = {
  minW: number;
  minH: number;
  maxW: number;
  maxH: number;
};

// Sensible bounds per panel. The activity bar (44px) and the workbench
// margin (6px on each edge) are subtracted from maxW at apply-time.
export const PANEL_CONSTRAINTS: { [P in PanelId]: PanelConstraints } = {
  explorer: { minW: 200, minH: 160, maxW: 600, maxH: 1600 },
  git:      { minW: 200, minH: 160, maxW: 600, maxH: 1600 },
  graph:    { minW: 240, minH: 200, maxW: 720, maxH: 1600 },
  memory:   { minW: 240, minH: 200, maxW: 640, maxH: 1600 },
  terminal: { minW: 320, minH: 120, maxW: 2400, maxH: 900 },
  ai:       { minW: 280, minH: 240, maxW: 720, maxH: 1600 },
};

// Activity bar width — kept in sync with --size-activity-bar in tokens.css.
export const ACTIVITY_BAR_WIDTH = 44;
// Default gap between adjacent panels when the layout is "stacked" mode.
export const PANEL_GAP = 6;

// Build the default layout from the workbench dimensions. The default
// mirrors the legacy flexbox layout: side panels in a left column, AI on
// the right, terminal at the bottom.
export function defaultLayout(workbenchW: number, workbenchH: number): Layout {
  const w = Math.max(0, workbenchW);
  const h = Math.max(0, workbenchH);
  const terminalH = Math.min(220, Math.max(140, Math.floor(h * 0.28)));
  const aiW = 360;
  const mainH = h - terminalH;
  // Side column panels — explorer, git, graph side-by-side, all full main height.
  const explorerW = 280;
  const gitW = 280;
  const graphW = 320;
  return {
    explorer: { x: 0, y: 0, w: explorerW, h: mainH },
    git:      { x: explorerW + PANEL_GAP, y: 0, w: gitW, h: mainH },
    graph:    { x: explorerW + PANEL_GAP + gitW + PANEL_GAP, y: 0, w: graphW, h: mainH },
    memory:   { x: explorerW + PANEL_GAP + gitW + PANEL_GAP + graphW + PANEL_GAP, y: 0, w: 320, h: mainH },
    ai:       [{ x: w - aiW, y: 0, w: aiW, h: mainH }],
    terminal: { x: 0, y: mainH + PANEL_GAP, w: w - aiW - PANEL_GAP, h: terminalH },
  };
}

const STORE_KEY = "klide-panel-layouts";

type Stored = { [workspaceRoot: string]: Layout };

function readAll(): Stored {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Stored) : {};
  } catch {
    return {};
  }
}

function writeAll(stored: Stored): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(stored));
  } catch {
    // Quota / private mode — fall back silently. Layouts are convenience,
    // not critical state.
  }
}

export function loadLayout(workspaceRoot: string | null): Layout | null {
  if (!workspaceRoot) return null;
  const all = readAll();
  const raw = all[workspaceRoot];
  if (!raw) return null;
  return migrateLayout(raw);
}

// Old layouts stored `ai` as a single PanelRect. The new format is an
// array so multiple AI panels can each have their own box. Wrap a
// legacy single-rect `ai` in an array on load.
function migrateLayout(layout: Layout): Layout {
  if (!layout) return layout;
  const aiRaw = (layout as unknown as { ai?: PanelRect | PanelRect[] }).ai;
  if (aiRaw && !Array.isArray(aiRaw)) {
    return { ...layout, ai: [aiRaw] };
  }
  return layout;
}

export function saveLayout(workspaceRoot: string | null, layout: Layout): void {
  if (!workspaceRoot) return;
  const all = readAll();
  all[workspaceRoot] = layout;
  writeAll(all);
}

export function clearLayout(workspaceRoot: string): void {
  const all = readAll();
  delete all[workspaceRoot];
  writeAll(all);
}

// Clamp a panel rect to the workbench bounds and the panel's own min/max.
// Both the *position* and the *size* are bounded so a panel that was sized
// to fit a larger workbench shrinks (rather than overflowing) when the
// window is resized down.
export function clampRect(
  rect: PanelRect,
  workbenchW: number,
  workbenchH: number,
  constraints: PanelConstraints
): PanelRect {
  // First pin the position inside the workbench. The rect may extend past
  // the edge, so we allow x up to workbenchW and y up to workbenchH — the
  // size clamp below takes care of the actual extent.
  const x = Math.max(0, Math.min(rect.x, workbenchW));
  const y = Math.max(0, Math.min(rect.y, workbenchH));
  // Then clamp the size: not smaller than the panel's min, not larger than
  // the panel's max, and not larger than the remaining workbench space at
  // (x, y) so the rect actually fits when the window shrinks.
  const maxWHere = Math.max(constraints.minW, workbenchW - x);
  const maxHHere = Math.max(constraints.minH, workbenchH - y);
  const w = Math.min(
    constraints.maxW,
    Math.max(constraints.minW, Math.min(rect.w, maxWHere))
  );
  const h = Math.min(
    constraints.maxH,
    Math.max(constraints.minH, Math.min(rect.h, maxHHere))
  );
  return { x, y, w, h };
}
