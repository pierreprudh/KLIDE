import { useCallback, useEffect, useState } from "react";

/**
 * The Surface — which of Klide's screens the app is on.
 *
 * "Three surfaces, one state" used to be encoded in four unrelated atoms plus
 * a derived condition: `view` (workbench/runs/settings/git-review),
 * `focusMode` (boolean + localStorage), `panelLayout.anchored` (per-workspace),
 * `activeGridId` (+ localStorage), and Welcome as `view !== "settings" &&
 * !workspaceRoot`. Every screen switch had to set 3–4 of them in the right
 * combination, and guards like `activeGrid && !focusMode` re-encoded their
 * mutual exclusion by hand in the render tree.
 *
 * This module is the one owner. The stored state is small and honest:
 *
 * - `base` — what the main canvas is: the chat-first **Focus** screen, a saved
 *   **grid**, or the **panels** workbench (anchored vs free is a per-workspace
 *   *geometry* bit that stays owned by the panel-layout store; the Surface
 *   projects it into its union but does not store it). Focus-over-a-grid is
 *   unrepresentable: `base` is one of them.
 * - `overlay` — a full-window view sitting over the base (Mission Control,
 *   Settings, Git Review). The base stays mounted underneath so
 *   live run subscriptions keep streaming; `back()` returns to it.
 * - **Welcome** stays derived, exactly like the old `view !== "settings" &&
 *   !workspaceRoot` condition: `resolveSurface` yields it whenever no
 *   workspace is open and the overlay is not Settings (Settings must stay
 *   reachable to set up API keys before any folder is opened).
 *
 * Persistence keeps the pre-existing keys and values ("klide-focus-mode",
 * "klide-active-grid") so nothing migrates. One legacy contradiction is
 * resolved at load: if both keys were set, the old render tree let Focus win
 * (`focusMode` trumped `activeGrid`), so the loader picks Focus and the next
 * persist drops the stale grid id.
 */

/** The full-window views that sit over the base surface. This is the old
 *  `view` enum minus "workbench" (which is the absence of an overlay). */
export type OverlayView = "runs" | "settings" | "git-review";

/** What the main canvas is when no overlay covers it. `panels` means the
 *  anchored/free workbench — which of the two is the panel-layout store's
 *  `anchored` bit, resolved at render time. */
export type BaseSurface =
  | { kind: "focus" }
  | { kind: "grid"; gridId: string }
  | { kind: "panels" };

/** The stored surface state: a base plus at most one overlay over it. */
export type SurfaceCore = {
  overlay: OverlayView | null;
  base: BaseSurface;
};

/** The workbench's layout in the resolved union. A `gridId` only appears here
 *  when the grid still exists — a dangling id resolves to anchored/free, the
 *  same fallback the old `gridLayouts.find(...) ?? null` lookup produced. */
export type WorkbenchLayout =
  | { kind: "anchored" }
  | { kind: "free" }
  | { kind: "grid"; gridId: string };

/** The resolved Surface — what the app is actually showing. */
export type Surface =
  | { kind: "welcome" }
  | { kind: "focus" }
  | { kind: "workbench"; layout: WorkbenchLayout }
  | { kind: "overlay"; view: OverlayView };

/** Everything the resolver needs from outside the module: whether a workspace
 *  is open (Welcome derivation), the panel-layout store's anchored bit, and
 *  whether a stored grid id still names a real grid. */
export type SurfaceContext = {
  workspaceOpen: boolean;
  panelsAnchored: boolean;
  gridExists: (gridId: string) => boolean;
};

export type SurfaceAction =
  /** Enter the chat-first Focus screen. Clears any overlay and any grid —
   *  every historical caller paired `setFocusMode(true)` with `exitGrid()`
   *  and `setView("workbench")`, so the pairing is now the verb. */
  | { type: "enter-focus" }
  /** Leave Focus for the panels workbench. A no-op when the base is not
   *  Focus (mirrors the old bare `setFocusMode(false)`, which callers used
   *  defensively before applying another layout). Does not touch the overlay:
   *  the layout picker only shows on the base, so there is never one to close. */
  | { type: "exit-focus" }
  /** Land on the anchored/free workbench: overlay closed, focus and grid
   *  cleared. The anchored/free choice itself is applied by the hook through
   *  `applyPanelsMode` — it is panel-layout geometry, not Surface state. */
  | { type: "enter-workbench"; layout: "anchored" | "free" }
  /** Apply a saved grid as the base (and close any overlay — the old
   *  `applyGrid` did `setView("workbench")`). Focus clears by construction. */
  | { type: "apply-grid"; gridId: string }
  /** Leave the grid for the panels workbench. No-op off a grid. Leaves the
   *  overlay alone, exactly like the old `setActiveGridId(null)`. */
  | { type: "exit-grid" }
  /** Show a full-window view over the current base. */
  | { type: "open-overlay"; view: OverlayView }
  /** Toggle a full-window view: open it, or return to the base if it is
   *  already showing (⌘⇧G's git-review behaviour). */
  | { type: "toggle-overlay"; view: OverlayView }
  /** Close any overlay and return to the base (Esc, the rail's Home). */
  | { type: "back" };

export const initialSurfaceCore: SurfaceCore = {
  overlay: null,
  base: { kind: "panels" },
};

export function surfaceReducer(core: SurfaceCore, action: SurfaceAction): SurfaceCore {
  switch (action.type) {
    case "enter-focus":
      return { overlay: null, base: { kind: "focus" } };
    case "exit-focus":
      return core.base.kind === "focus" ? { ...core, base: { kind: "panels" } } : core;
    case "enter-workbench":
      return { overlay: null, base: { kind: "panels" } };
    case "apply-grid":
      return { overlay: null, base: { kind: "grid", gridId: action.gridId } };
    case "exit-grid":
      return core.base.kind === "grid" ? { ...core, base: { kind: "panels" } } : core;
    case "open-overlay":
      return { ...core, overlay: action.view };
    case "toggle-overlay":
      return { ...core, overlay: core.overlay === action.view ? null : action.view };
    case "back":
      return core.overlay === null ? core : { ...core, overlay: null };
  }
}

/** Resolve the stored core against the world into the Surface being shown. */
export function resolveSurface(core: SurfaceCore, ctx: SurfaceContext): Surface {
  // Welcome derivation, verbatim from the old early return: no workspace and
  // not in Settings → the full-screen welcome page. Any other overlay is
  // latent underneath it (as `view` used to be) and shows again if a
  // workspace opens while it is still set.
  if (!ctx.workspaceOpen && core.overlay !== "settings") return { kind: "welcome" };
  if (core.overlay !== null) return { kind: "overlay", view: core.overlay };
  if (core.base.kind === "focus") return { kind: "focus" };
  if (core.base.kind === "grid" && ctx.gridExists(core.base.gridId)) {
    return { kind: "workbench", layout: { kind: "grid", gridId: core.base.gridId } };
  }
  return {
    kind: "workbench",
    layout: { kind: ctx.panelsAnchored ? "anchored" : "free" },
  };
}

// ── Derived predicates ────────────────────────────────────────────────
// The old hand-written guards, each with one home.

/** Focus owns the titlebar band (`data-titlebar-owner="focus"`); everything
 *  else leaves it to the app row. Was `focusMode && view === "workbench"`. */
export function ownsTitlebar(surface: Surface): boolean {
  return surface.kind === "focus";
}

/** The sidebar shows on every surface but Welcome (its own full-screen page)
 *  and Settings (its own full shell, with its own rail).
 *
 *  Focus used to be excluded because it drew a second copy of the very same
 *  component. One instance is what makes the sidebar hold still across a mode
 *  change: two of them meant an unmount and a mount, which replays the rail's
 *  entrance animation and throws away the tree's expanded folders and scroll.
 *  The shells now differ only in the props they hand it. */
export function showsRail(surface: Surface): boolean {
  return (
    surface.kind === "focus" ||
    surface.kind === "workbench" ||
    (surface.kind === "overlay" && surface.view !== "settings")
  );
}

/** The status bar shows everywhere but Focus (chrome-free), Welcome (its own
 *  full-screen page), Settings — which, like Welcome, renders its own full
 *  shell (its own rail, its own back affordance) and has no file, branch or
 *  editor state for the bar to report — and Git Review, whose header already
 *  names the branch, so the bar would only repeat it under the panes. */
export function showsStatusBar(surface: Surface): boolean {
  return (
    surface.kind !== "focus" &&
    surface.kind !== "welcome" &&
    !(surface.kind === "overlay" && (surface.view === "settings" || surface.view === "git-review"))
  );
}

/** The base canvas (Focus or workbench) is what's showing — no overlay over
 *  it. This is the old `view === "workbench"` guard (which was true in Focus
 *  too, since Focus was `view === "workbench"` plus a flag). */
export function baseShowing(surface: Surface): boolean {
  return surface.kind === "focus" || surface.kind === "workbench";
}

// ── Persistence codec ─────────────────────────────────────────────────
// Same keys, same values as the old per-atom effects, so nothing migrates:
//   "klide-focus-mode"  ← String(focusMode)
//   "klide-active-grid" ← activeGridId (removed when null)

export const FOCUS_MODE_KEY = "klide-focus-mode";
export const ACTIVE_GRID_KEY = "klide-active-grid";

/** Decode the base surface from the two stored values. If a legacy session
 *  left both set, Focus wins — that is what the old render precedence did
 *  (`focusMode` hid the grid) — and the next persist drops the grid id. */
export function baseFromStorage(
  focusFlag: string | null,
  storedGridId: string | null,
): BaseSurface {
  if (focusFlag === "true") return { kind: "focus" };
  if (storedGridId) return { kind: "grid", gridId: storedGridId };
  return { kind: "panels" };
}

/** Encode the base surface back into the two stored values. `gridId: null`
 *  means "remove the key", matching the old `activeGridId` effect. */
export function baseToStorage(base: BaseSurface): {
  focusFlag: string;
  gridId: string | null;
} {
  return {
    focusFlag: String(base.kind === "focus"),
    gridId: base.kind === "grid" ? base.gridId : null,
  };
}

/** Identity of the DOM node hosting the workbench. `usePanelLayout` re-attaches
 *  its ResizeObserver when this changes — the host node is a different element
 *  per overlay view and per base kind (AnchoredWorkbench's root, the free-mode
 *  div, or nothing in grid/Focus), and an observer left on a detached node
 *  reports a stale size. Base *kind* only: switching grid A → grid B keeps the
 *  same (absent) host. */
export function surfaceHostKey(core: SurfaceCore): string {
  return `${core.overlay ?? "workbench"}|${core.base.kind}`;
}

// ── React binding ─────────────────────────────────────────────────────

export type SurfaceApi = {
  /** The stored state — for guards that need the base regardless of overlay
   *  (e.g. the status bar's Focus styling while Settings covers it). */
  core: SurfaceCore;
  /** Re-measure signal for the panel-layout module. */
  hostKey: string;
  enterFocus: () => void;
  exitFocus: () => void;
  enterWorkbench: (layout: "anchored" | "free") => void;
  applyGrid: (gridId: string) => void;
  exitGrid: () => void;
  openOverlay: (view: OverlayView) => void;
  toggleOverlay: (view: OverlayView) => void;
  back: () => void;
};

/**
 * The Surface store. `applyPanelsMode` is the seam to the panel-layout
 * module: `enterWorkbench("anchored" | "free")` forwards the choice there,
 * because the anchored bit is per-workspace panel geometry (persisted with
 * the rects), not Surface state.
 */
export function useSurface(opts: {
  applyPanelsMode: (anchored: boolean) => void;
}): SurfaceApi {
  const { applyPanelsMode } = opts;
  const [core, setCore] = useState<SurfaceCore>(() => ({
    overlay: null,
    base: baseFromStorage(
      localStorage.getItem(FOCUS_MODE_KEY),
      localStorage.getItem(ACTIVE_GRID_KEY) || null,
    ),
  }));

  useEffect(() => {
    const stored = baseToStorage(core.base);
    localStorage.setItem(FOCUS_MODE_KEY, stored.focusFlag);
    if (stored.gridId) localStorage.setItem(ACTIVE_GRID_KEY, stored.gridId);
    else localStorage.removeItem(ACTIVE_GRID_KEY);
  }, [core.base]);

  const dispatch = useCallback((action: SurfaceAction) => {
    setCore((prev) => surfaceReducer(prev, action));
  }, []);

  const enterFocus = useCallback(() => dispatch({ type: "enter-focus" }), [dispatch]);
  const exitFocus = useCallback(() => dispatch({ type: "exit-focus" }), [dispatch]);
  const enterWorkbench = useCallback(
    (layout: "anchored" | "free") => {
      dispatch({ type: "enter-workbench", layout });
      applyPanelsMode(layout === "anchored");
    },
    [dispatch, applyPanelsMode],
  );
  const applyGrid = useCallback(
    (gridId: string) => dispatch({ type: "apply-grid", gridId }),
    [dispatch],
  );
  const exitGrid = useCallback(() => dispatch({ type: "exit-grid" }), [dispatch]);
  const openOverlay = useCallback(
    (view: OverlayView) => dispatch({ type: "open-overlay", view }),
    [dispatch],
  );
  const toggleOverlay = useCallback(
    (view: OverlayView) => dispatch({ type: "toggle-overlay", view }),
    [dispatch],
  );
  const back = useCallback(() => dispatch({ type: "back" }), [dispatch]);

  return {
    core,
    hostKey: surfaceHostKey(core),
    enterFocus,
    exitFocus,
    enterWorkbench,
    applyGrid,
    exitGrid,
    openOverlay,
    toggleOverlay,
    back,
  };
}
