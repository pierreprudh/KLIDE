import { useEffect, useRef, useState } from "react";
import type { ProviderId } from "../agent/types";
import { isProviderId } from "../agent/providers";
import {
  defaultLayout as defaultPanelLayout,
  loadLayout as loadPanelLayout,
  saveLayout as savePanelLayout,
  clearLayout as clearPanelLayout,
  clampRect,
  scaleLayout,
  PANEL_CONSTRAINTS,
  type Layout as PanelLayout,
  type PanelRect,
  type PanelId as PanelLayoutId,
  type StoredAiPanel,
} from "../panelLayout";
import { Z } from "../zLayers";

// One AI panel in the workbench: its id, its rect, and which provider/model
// it was opened with. The rect is the source of truth that gets persisted
// into `PanelLayout.ai`.
export type AiPanelInstance = {
  id: string;
  rect: PanelRect;
  provider?: ProviderId;
  model?: string;
  // Per-panel workspace override — the path of a git worktree this panel's
  // runs are pinned to, so a delegate/Klide run works on an isolated branch
  // instead of the main checkout. Session-only (deliberately not persisted:
  // a reload shouldn't resurrect a panel pointing at a since-removed
  // worktree). When unset, the panel uses the app's global workspaceRoot.
  cwd?: string;
};

function newAiPanelId(): string {
  return `ai-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function storedAiProvider(id: string | undefined): ProviderId | undefined {
  return id && isProviderId(id) ? id : undefined;
}

// Local copy of the numeric-setting reader — used only by the one-time
// legacy-layout migration below. (App keeps its own for editor settings;
// see candidate #5 for unifying localStorage access.)
function readNumberSetting(key: string, fallback: number, min: number, max: number): number {
  const stored = localStorage.getItem(key);
  if (stored === null) return fallback;
  const raw = Number(stored);
  return Number.isFinite(raw) ? Math.min(max, Math.max(min, raw)) : fallback;
}

/**
 * Owns the workbench's panel geometry: the measured workbench size, the
 * persisted `PanelLayout` for the current workspace, the live AI-panel list,
 * and the z-stack focus. Every rect mutation routes through here and is
 * clamped to the workbench, so a panel-rect bug has exactly one home.
 *
 * The host passes the current `workspaceRoot` (which layout to load/persist)
 * and `view` (the workbench host node swaps per view, so the ResizeObserver
 * must re-attach). Everything else about panel geometry lives here.
 */
export function usePanelLayout(opts: {
  workspaceRoot: string | null;
  view: string;
  /** Focus mode swaps the workbench host node out entirely (the focus screen
   *  doesn't attach `workbenchRef`), so the ResizeObserver must re-attach when
   *  it toggles — same reason as `view`. */
  focusMode: boolean;
}) {
  const { workspaceRoot, view, focusMode } = opts;

  const workbenchRef = useRef<HTMLDivElement | null>(null);
  const [workbenchSize, setWorkbenchSize] = useState({ w: 0, h: 0 });
  const [panelLayout, setPanelLayout] = useState<PanelLayout>(() => ({}));
  const [layoutHydratedRoot, setLayoutHydratedRoot] = useState<string | null>(null);
  const [layoutMigrated, setLayoutMigrated] = useState(false);
  const [aiPanels, setAiPanels] = useState<AiPanelInstance[]>(() => [
    { id: "ai-main", rect: { x: 0, y: 0, w: 360, h: 360 } },
  ]);
  // Bring-to-front z-index. Bumped when the user clicks a panel.
  const [zCounter, setZCounter] = useState(10);
  const [focusedPanel, setFocusedPanel] = useState<string | null>(null);
  // Per-panel stacking order. Each panel keeps the z it last earned on focus,
  // so bringing one panel forward never reshuffles the others.
  const [zMap, setZMap] = useState<Record<string, number>>({});

  // Measure the workbench container so we can build a default layout on
  // first paint, and re-clamp every panel rect when the window resizes.
  useEffect(() => {
    const el = workbenchRef.current;
    if (!el) return;
    // A 0×0 measurement is never a real workbench — it's the observer firing
    // for a node that just got detached (focus-mode swap) or display:none'd
    // (overlay views). Committing it would make every subsequent clampRect
    // collapse panels to 1×1 at the origin and persist the wreckage, so keep
    // the last real size instead.
    const commit = (w: number, h: number) => {
      const next = { w: Math.round(w), h: Math.round(h) };
      if (next.w === 0 || next.h === 0) return;
      setWorkbenchSize((prev) =>
        prev.w === next.w && prev.h === next.h ? prev : next
      );
    };
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      commit(entry.contentRect.width, entry.contentRect.height);
    });
    ro.observe(el);
    const rect = el.getBoundingClientRect();
    commit(rect.width, rect.height);
    return () => ro.disconnect();
    // `workbenchRef` is attached to a *different* DOM node per mode:
    // AnchoredWorkbench's root (anchored), the free-mode div (free), or
    // nothing (grid, focus). When the host node swaps, the old observer is
    // left watching a detached node and `workbenchSize` goes stale — floating
    // panels then mis-clamp on interaction and the explorer won't open.
    // Re-run on every dimension that swaps the host so we always observe
    // the live node. (A `view` change happened to mask this — that's why a
    // Mission Control round-trip "fixed" it.)
  }, [view, workspaceRoot, panelLayout.anchored, focusMode]);

  function fallbackAiRect(): PanelRect {
    const w = Math.min(360, Math.max(1, workbenchSize.w));
    const h = workbenchSize.h;
    return clampRect(
      { x: Math.max(0, workbenchSize.w - w), y: 0, w, h },
      workbenchSize.w,
      workbenchSize.h,
      PANEL_CONSTRAINTS.ai
    );
  }

  function aiPanelsFromRects(
    stored: StoredAiPanel[] | undefined,
    previous: AiPanelInstance[]
  ): AiPanelInstance[] {
    const source = stored && stored.length > 0 ? stored : [{ id: "ai-main", rect: fallbackAiRect() }];
    return source.map((entry, idx) => {
      const prev = previous.find((p) => p.id === entry.id);
      return {
        id: entry.id ?? (idx === 0 ? "ai-main" : newAiPanelId()),
        rect: entry.rect,
        provider: storedAiProvider(entry.provider) ?? prev?.provider,
        model: entry.model ?? prev?.model,
        // `cwd` (worktree pin) lives only in memory — StoredAiPanel never
        // carries it — so a resync (window-resize re-clamp, hydrate) must
        // carry it forward from the previous in-memory panel, or the panel
        // would silently revert to the global workspace mid-session and an
        // agent could start writing to the main checkout.
        cwd: prev?.cwd,
      };
    });
  }

  function syncAiPanelsFromRects(stored: StoredAiPanel[] | undefined) {
    setAiPanels((previous) => {
      const next = aiPanelsFromRects(stored, previous);
      if (
        previous.length === next.length &&
        previous.every((panel, idx) => {
          const other = next[idx];
          return (
            panel.id === other.id &&
            panel.provider === other.provider &&
            panel.model === other.model &&
            panel.rect.x === other.rect.x &&
            panel.rect.y === other.rect.y &&
            panel.rect.w === other.rect.w &&
            panel.rect.h === other.rect.h
          );
        })
      ) {
        return previous;
      }
      return next;
    });
  }

  // Project an in-memory AI panel list back onto a StoredAiPanel array.
  // Preserves every panel's id+rect+provider+model so subsequent hydration
  // is a no-op rather than a destructive rebuild.
  function projectAiPanelsToRects(panels: AiPanelInstance[]): StoredAiPanel[] {
    return panels.map((p) => ({ id: p.id, rect: p.rect, provider: p.provider, model: p.model }));
  }

  // Load the saved layout for the current workspace (if any), otherwise
  // build a default. Migrate from the legacy per-key localStorage entries
  // on first run so users don't lose their existing widths.
  useEffect(() => {
    if (!workspaceRoot || workbenchSize.w === 0 || workbenchSize.h === 0) return;
    if (layoutHydratedRoot === workspaceRoot && Object.keys(panelLayout).length > 0) {
      return;
    }
    const saved = loadPanelLayout(workspaceRoot);
    if (saved) {
      // Re-open proportional to the current window: if the saved layout was
      // captured at a different size (bigger display, different monitor),
      // scale its rects to fit. No-op when the size matches or is unrecorded.
      const fitted = scaleLayout(saved, workbenchSize.w, workbenchSize.h);
      setPanelLayout(fitted);
      syncAiPanelsFromRects(fitted.ai);
      setLayoutHydratedRoot(workspaceRoot);
      return;
    }
    if (!layoutMigrated) {
      setLayoutMigrated(true);
      const migrated: PanelLayout = {
        anchored: true,
        explorer: {
          x: 0,
          y: 0,
          w: readNumberSetting("klide-left-width", 280, 220, 520),
          h: workbenchSize.h - readNumberSetting("klide-terminal-height", 240, 140, 460) - 6,
        },
        git: {
          x: 0,
          y: 0,
          w: readNumberSetting("klide-git-width", 280, 220, 520),
          h: workbenchSize.h - readNumberSetting("klide-terminal-height", 240, 140, 460) - 6,
        },
        ai: [{
          id: "ai-main",
          rect: {
            x: workbenchSize.w - readNumberSetting("klide-ai-width", 380, 300, 620),
            y: 0,
            w: readNumberSetting("klide-ai-width", 380, 300, 620),
            h: workbenchSize.h - readNumberSetting("klide-terminal-height", 240, 140, 460) - 6,
          },
        }],
        terminal: {
          x: 0,
          y: workbenchSize.h - readNumberSetting("klide-terminal-height", 240, 140, 460) - 6,
          w: workbenchSize.w - readNumberSetting("klide-ai-width", 380, 300, 620) - 6,
          h: readNumberSetting("klide-terminal-height", 240, 140, 460),
        },
        workbenchW: workbenchSize.w,
        workbenchH: workbenchSize.h,
      };
      setPanelLayout(migrated);
      syncAiPanelsFromRects(migrated.ai);
      savePanelLayout(workspaceRoot, migrated);
      setLayoutHydratedRoot(workspaceRoot);
      return;
    }
    const fresh = defaultPanelLayout(workbenchSize.w, workbenchSize.h);
    setPanelLayout(fresh);
    syncAiPanelsFromRects(fresh.ai);
    savePanelLayout(workspaceRoot, fresh);
    setLayoutHydratedRoot(workspaceRoot);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceRoot, workbenchSize.w, workbenchSize.h, layoutMigrated, layoutHydratedRoot]);

  // Persist layout on change (debounced via the React batched updates).
  // Stamp the current workbench size so a later re-open at a different size
  // can scale the layout proportionally (see `scaleLayout` on hydrate).
  useEffect(() => {
    if (!workspaceRoot) return;
    if (Object.keys(panelLayout).length === 0) return;
    const stamped =
      workbenchSize.w > 0 && workbenchSize.h > 0
        ? { ...panelLayout, workbenchW: workbenchSize.w, workbenchH: workbenchSize.h }
        : panelLayout;
    savePanelLayout(workspaceRoot, stamped);
  }, [panelLayout, workspaceRoot, workbenchSize.w, workbenchSize.h]);

  // Keep panels proportional to the workbench as it resizes — like a native
  // macOS app, where growing the window grows the panels with it instead of
  // dumping all the new space into the editor. When the workbench size changes
  // we scale every rect by the size ratio (x & w by the width ratio, y & h by
  // the height ratio); because docked panels are positioned from the far edge
  // (AI at `w - width`, terminal at `h - height`), scaling all four keeps them
  // anchored to that edge *and* preserves their share of the window. The result
  // is then clamped so a panel never drops below its min size or overflows.
  //
  // When the effect fires for any other reason (hydrate, a manual drag), the
  // size is unchanged so we skip the rescale and only clamp — the safety net
  // that stops a stale saved layout from overflowing ("panels bigger than the
  // window").
  const prevWorkbench = useRef({ w: 0, h: 0 });
  useEffect(() => {
    if (workbenchSize.w === 0 || workbenchSize.h === 0) return;
    if (Object.keys(panelLayout).length === 0) return;

    const prev = prevWorkbench.current;
    const resized =
      prev.w > 0 && prev.h > 0 && (prev.w !== workbenchSize.w || prev.h !== workbenchSize.h);
    const sx = resized ? workbenchSize.w / prev.w : 1;
    const sy = resized ? workbenchSize.h / prev.h : 1;
    prevWorkbench.current = { w: workbenchSize.w, h: workbenchSize.h };

    // Scale (when resized) then clamp a single rect to the current workbench.
    // If a panel was docked to the right/bottom edge, keep it flush there even
    // when a max-size cap stops it from scaling the whole way — otherwise a
    // capped sidebar drifts inward and leaves a gap on a very wide window.
    const fit = (rect: PanelRect, c: (typeof PANEL_CONSTRAINTS)[keyof typeof PANEL_CONSTRAINTS]) => {
      if (!resized) return clampRect(rect, workbenchSize.w, workbenchSize.h, c);
      const rightDocked = rect.x + rect.w >= prev.w - 2;
      const bottomDocked = rect.y + rect.h >= prev.h - 2;
      const scaled = {
        x: Math.round(rect.x * sx),
        y: Math.round(rect.y * sy),
        w: Math.round(rect.w * sx),
        h: Math.round(rect.h * sy),
      };
      let out = clampRect(scaled, workbenchSize.w, workbenchSize.h, c);
      if (rightDocked) {
        out = clampRect({ ...out, x: Math.max(0, workbenchSize.w - out.w) }, workbenchSize.w, workbenchSize.h, c);
      }
      if (bottomDocked) {
        out = clampRect({ ...out, y: Math.max(0, workbenchSize.h - out.h) }, workbenchSize.w, workbenchSize.h, c);
      }
      return out;
    };

    let dirty = false;
    const next: PanelLayout = { ...panelLayout };
    for (const id of ["explorer", "git", "memory", "terminal"] as const) {
      const rect = panelLayout[id];
      if (!rect) continue;
      const fitted = fit(rect, PANEL_CONSTRAINTS[id]);
      if (
        fitted.x !== rect.x ||
        fitted.y !== rect.y ||
        fitted.w !== rect.w ||
        fitted.h !== rect.h
      ) {
        next[id] = fitted;
        dirty = true;
      }
    }
    if (panelLayout.ai) {
      const fittedAi: StoredAiPanel[] = [];
      let aiDirty = false;
      panelLayout.ai.forEach((entry) => {
        const c = fit(entry.rect, PANEL_CONSTRAINTS.ai);
        fittedAi.push({ ...entry, rect: c });
        if (
          c.x !== entry.rect.x ||
          c.y !== entry.rect.y ||
          c.w !== entry.rect.w ||
          c.h !== entry.rect.h
        ) {
          aiDirty = true;
        }
      });
      if (aiDirty) {
        next.ai = fittedAi;
        syncAiPanelsFromRects(fittedAi);
        dirty = true;
      }
    }
    if (dirty) setPanelLayout(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workbenchSize.w, workbenchSize.h, panelLayout]);

  function resetPanelLayout() {
    if (!workspaceRoot) return;
    clearPanelLayout(workspaceRoot);
    const fresh = defaultPanelLayout(workbenchSize.w, workbenchSize.h);
    setPanelLayout(fresh);
    syncAiPanelsFromRects(fresh.ai);
    savePanelLayout(workspaceRoot, fresh);
    setLayoutHydratedRoot(workspaceRoot);
  }

  function setAnchoredLayout(anchored: boolean) {
    setPanelLayout((prev) => ({ ...prev, anchored }));
  }

  function updatePanelRect(panelId: PanelLayoutId, next: PanelRect) {
    setPanelLayout((prev) => ({ ...prev, [panelId]: next }));
  }

  // Saved layouts can lack an `ai` rect (pre-panel-management saves, or a
  // layout persisted while AI was hidden). Seed one so toggling AI on
  // always has something to render.
  function ensureAiRect() {
    const panels =
      aiPanels.length > 0
        ? aiPanels
        : [{ id: "ai-main", rect: fallbackAiRect() }];
    if (aiPanels.length === 0) setAiPanels(panels);
    setPanelLayout((prev) =>
      prev.ai && prev.ai.length > 0
        ? prev
        : { ...prev, ai: projectAiPanelsToRects(panels) }
    );
  }

  function updateAiRect(id: string, next: PanelRect) {
    const rect = clampRect(next, workbenchSize.w, workbenchSize.h, PANEL_CONSTRAINTS.ai);
    setAiPanels((prev) => {
      const updated = prev.map((panel) => panel.id === id ? { ...panel, rect } : panel);
      setPanelLayout((prevLayout) => ({ ...prevLayout, ai: projectAiPanelsToRects(updated) }));
      return updated;
    });
  }

  function focusPanel(panelId: string) {
    setFocusedPanel(panelId);
    setZCounter((n) => {
      const next = n + 1;
      // Only the focused panel gets a fresh top z; the rest keep theirs. The
      // panel base keeps any focused panel above the array-index fallback used
      // for panels that haven't been focused yet (see Z.panel in zLayers).
      setZMap((m) => ({ ...m, [panelId]: Z.panel + next }));
      return next;
    });
  }

  // Append a fresh AI panel, offset from the last so the user can see both,
  // clamped inside the workbench. Returns the new panel's id. Used by both
  // "duplicate panel" and the Mission Control "open in {CLI}" handoff.
  function appendAiPanel(seed?: { provider?: ProviderId; model?: string; cwd?: string; rect?: PanelRect }): string {
    const id = newAiPanelId();
    setAiPanels((prevPanels) => {
      const last = prevPanels[prevPanels.length - 1]?.rect;
      const baseW = last?.w ?? Math.min(360, Math.max(1, workbenchSize.w));
      const baseH = last?.h ?? workbenchSize.h;
      const offset = 20;
      // An explicit seed rect wins over the cascade — used by the race
      // "watch live" handoff to split two panels across the workbench.
      const rect = clampRect(
        seed?.rect ?? {
          x: (last?.x ?? workbenchSize.w - baseW) - offset,
          y: (last?.y ?? 0) + offset,
          w: baseW,
          h: baseH,
        },
        workbenchSize.w,
        workbenchSize.h,
        PANEL_CONSTRAINTS.ai
      );
      const nextPanels = [
        ...prevPanels,
        { id, rect, provider: seed?.provider, model: seed?.model, cwd: seed?.cwd },
      ];
      setPanelLayout((prevLayout) => ({
        ...prevLayout,
        ai: projectAiPanelsToRects(nextPanels),
      }));
      return nextPanels;
    });
    // A freshly opened panel comes up on top and becomes focused.
    setZCounter((n) => { const next = n + 1; setZMap((m) => ({ ...m, [id]: Z.panel + next })); return next; });
    setFocusedPanel(id);
    return id;
  }

  function setAiPanelProvider(id: string, provider: ProviderId) {
    setAiPanels((panels) => {
      // Self-heal an empty list — see setAiPanelModel.
      const seed = panels.length === 0
        ? [{ id, rect: fallbackAiRect() }]
        : panels;
      const next = seed.map((panel) => panel.id === id ? { ...panel, provider } : panel);
      setPanelLayout((prev) => ({ ...prev, ai: projectAiPanelsToRects(next) }));
      return next;
    });
  }

  function setAiPanelModel(id: string, model: string) {
    setAiPanels((panels) => {
      // If the in-memory list is empty (e.g. the persisted layout had no
      // AI panels, or a previous state mutation dropped them), seed the
      // requested id with a default rect before applying the model change.
      const seed = panels.length === 0
        ? [{ id, rect: fallbackAiRect() }]
        : panels;
      const next = seed.map((panel) => panel.id === id ? { ...panel, model } : panel);
      setPanelLayout((prev) => ({ ...prev, ai: projectAiPanelsToRects(next) }));
      return next;
    });
  }

  function closeAiPanel(id: string) {
    setAiPanels((panels) => {
      if (panels.length <= 1) return panels;
      const next = panels.filter((panel) => panel.id !== id);
      if (next.length === panels.length) return panels;
      setPanelLayout((prev) => {
        return { ...prev, ai: projectAiPanelsToRects(next) };
      });
      return next;
    });
    setZMap((m) => { if (!(id in m)) return m; const copy = { ...m }; delete copy[id]; return copy; });
  }

  return {
    workbenchRef,
    workbenchSize,
    setWorkbenchSize,
    panelLayout,
    aiPanels,
    zCounter,
    zMap,
    focusedPanel,
    updatePanelRect,
    updateAiRect,
    ensureAiRect,
    focusPanel,
    resetPanelLayout,
    setAnchoredLayout,
    appendAiPanel,
    setAiPanelProvider,
    setAiPanelModel,
    closeAiPanel,
  };
}
