// Bento-style panel layout. Each panel (other than the fixed activity bar
// and the editor surface) is a free-floating rectangle inside the workbench
// area. The user can resize any panel from its right, bottom, or corner
// edges. Layouts are saved per-workspace so switching projects keeps each
// project's preferred arrangement.

import type { ProviderId } from "./agent/types";

export type PanelId =
  | "explorer"
  | "git"
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
// box split down the middle. The "memory" panel id is kept here for
// backward compat with stored layouts; the Memory surface itself now
// opens as a centered modal, not a sidebar.
// A persisted AI panel carries its rect plus the model + provider so the
// panel can be rehydrated across sessions without losing the conversation
// binding. The id is the runtime key the React tree is keyed by — when the
// user creates a panel via Mission Control or duplicates an existing one
// we mint a fresh id and store it here so view-switches and reloads both
// resolve to the same panel.
export type StoredAiPanel = {
  id: string;
  rect: PanelRect;
  provider?: ProviderId;
  model?: string;
};

export type Layout = {
  explorer?: PanelRect;
  git?: PanelRect;
  memory?: PanelRect;
  terminal?: PanelRect;
  ai?: StoredAiPanel[];
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
  const terminalH = Math.min(220, Math.max(120, Math.floor(h * 0.28)));
  const aiW = Math.min(360, Math.max(1, w));
  const mainH = Math.max(1, h - terminalH - PANEL_GAP);
  // Side column panels — explorer + git side-by-side, both full main
  // height. Memory is now a centered modal (not a sidebar), so it has
  // no rect here.
  const explorerW = 280;
  const gitW = 280;
  return {
    explorer: { x: 0, y: 0, w: explorerW, h: mainH },
    git:      { x: explorerW + PANEL_GAP, y: 0, w: gitW, h: mainH },
    ai:       [{ id: "ai-main", rect: { x: Math.max(0, w - aiW), y: 0, w: aiW, h: mainH } }],
    terminal: { x: 0, y: mainH + PANEL_GAP, w: Math.max(1, w - aiW - PANEL_GAP), h: terminalH },
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

// Old layouts stored `ai` as either a single PanelRect, or a PanelRect[]
// without provider/model. Wrap a single rect, and backfill id+provider
// +model for each entry so the new id-keyed join doesn't drop them.
function migrateLayout(layout: Layout): Layout {
  if (!layout) return layout;
  const aiRaw = (layout as unknown as { ai?: PanelRect | PanelRect[] | StoredAiPanel[] }).ai;
  if (!aiRaw) return layout;
  if (Array.isArray(aiRaw) && aiRaw.length > 0 && "rect" in aiRaw[0]) {
    return layout;
  }
  const list: StoredAiPanel[] = [];
  if (!Array.isArray(aiRaw)) {
    list.push({ id: "ai-main", rect: aiRaw });
  } else {
    aiRaw.forEach((entry, idx) => {
      if ("rect" in entry) {
        list.push({ id: idx === 0 ? "ai-main" : `ai-${idx}`, rect: entry.rect, provider: entry.provider, model: entry.model });
      } else {
        list.push({ id: idx === 0 ? "ai-main" : `ai-${idx}`, rect: entry });
      }
    });
  }
  return { ...layout, ai: list };
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
  const boundsW = Math.max(1, workbenchW);
  const boundsH = Math.max(1, workbenchH);
  const x = Math.max(0, Math.min(rect.x, boundsW - 1));
  const y = Math.max(0, Math.min(rect.y, boundsH - 1));
  const availableW = Math.max(1, boundsW - x);
  const availableH = Math.max(1, boundsH - y);
  // Normal panel minimums are ergonomic constraints, not layout invariants.
  // When the window is smaller than a panel's min size, shrink below the min
  // so the whole rect remains reachable inside the workbench.
  const minW = Math.min(constraints.minW, availableW);
  const minH = Math.min(constraints.minH, availableH);
  const maxW = Math.min(constraints.maxW, availableW);
  const maxH = Math.min(constraints.maxH, availableH);
  const w = Math.min(maxW, Math.max(minW, rect.w));
  const h = Math.min(maxH, Math.max(minH, rect.h));
  return { x, y, w, h };
}
