import { describe, expect, it } from "vitest";
import {
  baseFromStorage,
  baseShowing,
  baseToStorage,
  ownsTitlebar,
  resolveSurface,
  showsRail,
  showsStatusBar,
  surfaceHostKey,
  surfaceReducer,
  type Surface,
  type SurfaceAction,
  type SurfaceCore,
} from "./useSurface";

// Representative cores: every base kind, alone and under an overlay.
const PANELS: SurfaceCore = { overlay: null, base: { kind: "panels" } };
const FOCUS: SurfaceCore = { overlay: null, base: { kind: "focus" } };
const GRID: SurfaceCore = { overlay: null, base: { kind: "grid", gridId: "g1" } };
const RUNS_OVER_PANELS: SurfaceCore = { overlay: "runs", base: { kind: "panels" } };
const SETTINGS_OVER_FOCUS: SurfaceCore = { overlay: "settings", base: { kind: "focus" } };
const GIT_OVER_GRID: SurfaceCore = {
  overlay: "git-review",
  base: { kind: "grid", gridId: "g1" },
};

const ALL_CORES: Array<[string, SurfaceCore]> = [
  ["panels", PANELS],
  ["focus", FOCUS],
  ["grid", GRID],
  ["runs over panels", RUNS_OVER_PANELS],
  ["settings over focus", SETTINGS_OVER_FOCUS],
  ["git-review over grid", GIT_OVER_GRID],
];

describe("surfaceReducer — transition table", () => {
  // Every verb from every state. Each row: action, then the expected core
  // per starting state, in ALL_CORES order.
  const table: Array<[SurfaceAction, SurfaceCore[]]> = [
    [
      { type: "enter-focus" },
      // Entering Focus lands on Focus from anywhere: overlay closed, grid
      // cleared (every old call site paired setFocusMode(true) with
      // exitGrid() + setView("workbench")).
      [FOCUS, FOCUS, FOCUS, FOCUS, FOCUS, FOCUS],
    ],
    [
      { type: "exit-focus" },
      // Leaves Focus for the panels workbench; a no-op off Focus (the old
      // bare setFocusMode(false)). Overlay untouched.
      [
        PANELS,
        PANELS,
        GRID,
        RUNS_OVER_PANELS,
        { overlay: "settings", base: { kind: "panels" } },
        GIT_OVER_GRID,
      ],
    ],
    [
      { type: "enter-workbench", layout: "anchored" },
      [PANELS, PANELS, PANELS, PANELS, PANELS, PANELS],
    ],
    [
      { type: "enter-workbench", layout: "free" },
      // The anchored/free choice lives in the panel-layout store; the core
      // transition is identical for both.
      [PANELS, PANELS, PANELS, PANELS, PANELS, PANELS],
    ],
    [
      { type: "apply-grid", gridId: "g2" },
      // Applying a grid closes any overlay (old applyGrid did
      // setView("workbench")) and replaces the base outright.
      [
        { overlay: null, base: { kind: "grid", gridId: "g2" } },
        { overlay: null, base: { kind: "grid", gridId: "g2" } },
        { overlay: null, base: { kind: "grid", gridId: "g2" } },
        { overlay: null, base: { kind: "grid", gridId: "g2" } },
        { overlay: null, base: { kind: "grid", gridId: "g2" } },
        { overlay: null, base: { kind: "grid", gridId: "g2" } },
      ],
    ],
    [
      { type: "exit-grid" },
      // Leaves the grid for panels; a no-op off a grid; overlay untouched
      // (the old setActiveGridId(null) never changed the view).
      [
        PANELS,
        FOCUS,
        PANELS,
        RUNS_OVER_PANELS,
        SETTINGS_OVER_FOCUS,
        { overlay: "git-review", base: { kind: "panels" } },
      ],
    ],
    [
      { type: "open-overlay", view: "runs" },
      // Overlays cover the base without disturbing it.
      [
        { overlay: "runs", base: { kind: "panels" } },
        { overlay: "runs", base: { kind: "focus" } },
        { overlay: "runs", base: { kind: "grid", gridId: "g1" } },
        { overlay: "runs", base: { kind: "panels" } },
        { overlay: "runs", base: { kind: "focus" } },
        { overlay: "runs", base: { kind: "grid", gridId: "g1" } },
      ],
    ],
    [
      { type: "toggle-overlay", view: "git-review" },
      // ⌘⇧G: open git-review, or return to the base when it is already up.
      [
        { overlay: "git-review", base: { kind: "panels" } },
        { overlay: "git-review", base: { kind: "focus" } },
        { overlay: "git-review", base: { kind: "grid", gridId: "g1" } },
        { overlay: "git-review", base: { kind: "panels" } },
        { overlay: "git-review", base: { kind: "focus" } },
        { overlay: null, base: { kind: "grid", gridId: "g1" } },
      ],
    ],
    [
      { type: "back" },
      // Esc / the rail's Home: close the overlay, keep the base.
      [
        PANELS,
        FOCUS,
        GRID,
        PANELS,
        { overlay: null, base: { kind: "focus" } },
        { overlay: null, base: { kind: "grid", gridId: "g1" } },
      ],
    ],
  ];

  for (const [action, expected] of table) {
    for (let i = 0; i < ALL_CORES.length; i++) {
      const [name, from] = ALL_CORES[i];
      it(`${action.type} from ${name}`, () => {
        expect(surfaceReducer(from, action)).toEqual(expected[i]);
      });
    }
  }

  it("focus over a grid is unrepresentable: entering focus drops the grid", () => {
    const afterFocus = surfaceReducer(GRID, { type: "enter-focus" });
    expect(afterFocus.base).toEqual({ kind: "focus" });
    // And coming back out lands on panels — the grid is gone, not latent.
    expect(surfaceReducer(afterFocus, { type: "exit-focus" }).base).toEqual({
      kind: "panels",
    });
  });
});

describe("resolveSurface", () => {
  const ctx = (over: Partial<Parameters<typeof resolveSurface>[1]> = {}) => ({
    workspaceOpen: true,
    panelsAnchored: true,
    gridExists: (id: string) => id === "g1",
    ...over,
  });

  it("derives Welcome when no workspace is open", () => {
    expect(resolveSurface(PANELS, ctx({ workspaceOpen: false }))).toEqual({
      kind: "welcome",
    });
  });

  it("derives Welcome over a latent non-settings overlay (old `view !== \"settings\"` guard)", () => {
    expect(resolveSurface(RUNS_OVER_PANELS, ctx({ workspaceOpen: false }))).toEqual({
      kind: "welcome",
    });
  });

  it("keeps Settings reachable without a workspace (API-key setup before any folder)", () => {
    expect(resolveSurface(SETTINGS_OVER_FOCUS, ctx({ workspaceOpen: false }))).toEqual({
      kind: "overlay",
      view: "settings",
    });
  });

  it("an overlay wins over the base once a workspace is open", () => {
    expect(resolveSurface(RUNS_OVER_PANELS, ctx())).toEqual({
      kind: "overlay",
      view: "runs",
    });
    expect(resolveSurface(GIT_OVER_GRID, ctx())).toEqual({
      kind: "overlay",
      view: "git-review",
    });
  });

  it("resolves the focus base to the Focus surface", () => {
    expect(resolveSurface(FOCUS, ctx())).toEqual({ kind: "focus" });
  });

  it("resolves a known grid to the grid workbench", () => {
    expect(resolveSurface(GRID, ctx())).toEqual({
      kind: "workbench",
      layout: { kind: "grid", gridId: "g1" },
    });
  });

  it("falls back to anchored/free when the stored grid was deleted", () => {
    const dangling: SurfaceCore = {
      overlay: null,
      base: { kind: "grid", gridId: "deleted" },
    };
    expect(resolveSurface(dangling, ctx())).toEqual({
      kind: "workbench",
      layout: { kind: "anchored" },
    });
    expect(resolveSurface(dangling, ctx({ panelsAnchored: false }))).toEqual({
      kind: "workbench",
      layout: { kind: "free" },
    });
  });

  it("resolves panels per the anchored bit", () => {
    expect(resolveSurface(PANELS, ctx())).toEqual({
      kind: "workbench",
      layout: { kind: "anchored" },
    });
    expect(resolveSurface(PANELS, ctx({ panelsAnchored: false }))).toEqual({
      kind: "workbench",
      layout: { kind: "free" },
    });
  });
});

describe("surface predicates", () => {
  const WELCOME: Surface = { kind: "welcome" };
  const FOCUS_S: Surface = { kind: "focus" };
  const ANCHORED_S: Surface = { kind: "workbench", layout: { kind: "anchored" } };
  const FREE_S: Surface = { kind: "workbench", layout: { kind: "free" } };
  const GRID_S: Surface = { kind: "workbench", layout: { kind: "grid", gridId: "g1" } };
  const RUNS_S: Surface = { kind: "overlay", view: "runs" };
  const SETTINGS_S: Surface = { kind: "overlay", view: "settings" };
  const GIT_S: Surface = { kind: "overlay", view: "git-review" };

  // surface → [ownsTitlebar, showsRail, showsStatusBar, baseShowing]
  const table: Array<[string, Surface, boolean, boolean, boolean, boolean]> = [
    ["welcome", WELCOME, false, false, false, false],
    // Focus shows the rail too: one instance across every surface is what
    // keeps the sidebar still through a mode change.
    ["focus", FOCUS_S, true, true, false, true],
    ["workbench anchored", ANCHORED_S, false, true, true, true],
    ["workbench free", FREE_S, false, true, true, true],
    ["workbench grid", GRID_S, false, true, true, true],
    ["overlay runs", RUNS_S, false, true, true, false],
    ["overlay settings", SETTINGS_S, false, false, false, false],
    ["overlay git-review", GIT_S, false, true, false, false],
  ];

  for (const [name, surface, titlebar, rail, statusBar, base] of table) {
    it(`${name}: titlebar=${titlebar} rail=${rail} statusBar=${statusBar} base=${base}`, () => {
      expect(ownsTitlebar(surface)).toBe(titlebar);
      expect(showsRail(surface)).toBe(rail);
      expect(showsStatusBar(surface)).toBe(statusBar);
      expect(baseShowing(surface)).toBe(base);
    });
  }
});

describe("persistence codec", () => {
  it("round-trips the focus base through the legacy keys", () => {
    const stored = baseToStorage({ kind: "focus" });
    expect(stored).toEqual({ focusFlag: "true", gridId: null });
    expect(baseFromStorage(stored.focusFlag, stored.gridId)).toEqual({ kind: "focus" });
  });

  it("round-trips a grid base", () => {
    const stored = baseToStorage({ kind: "grid", gridId: "g1" });
    expect(stored).toEqual({ focusFlag: "false", gridId: "g1" });
    expect(baseFromStorage(stored.focusFlag, stored.gridId)).toEqual({
      kind: "grid",
      gridId: "g1",
    });
  });

  it("round-trips the panels base", () => {
    const stored = baseToStorage({ kind: "panels" });
    expect(stored).toEqual({ focusFlag: "false", gridId: null });
    expect(baseFromStorage(stored.focusFlag, stored.gridId)).toEqual({ kind: "panels" });
  });

  it("reads the old atoms' exact values (String(bool) / raw id)", () => {
    expect(baseFromStorage("true", null)).toEqual({ kind: "focus" });
    expect(baseFromStorage("false", "g1")).toEqual({ kind: "grid", gridId: "g1" });
    expect(baseFromStorage(null, null)).toEqual({ kind: "panels" });
  });

  it("legacy contradiction — both keys set — resolves to Focus, as the old render precedence did", () => {
    expect(baseFromStorage("true", "g1")).toEqual({ kind: "focus" });
  });
});

describe("surfaceHostKey", () => {
  it("changes when the overlay changes (the workbench host node swaps)", () => {
    expect(surfaceHostKey(PANELS)).not.toBe(surfaceHostKey(RUNS_OVER_PANELS));
  });

  it("changes when the base kind changes", () => {
    expect(surfaceHostKey(PANELS)).not.toBe(surfaceHostKey(FOCUS));
    expect(surfaceHostKey(PANELS)).not.toBe(surfaceHostKey(GRID));
  });

  it("is stable across a grid-to-grid switch (same absent host node)", () => {
    const g2: SurfaceCore = { overlay: null, base: { kind: "grid", gridId: "g2" } };
    expect(surfaceHostKey(GRID)).toBe(surfaceHostKey(g2));
  });
});
