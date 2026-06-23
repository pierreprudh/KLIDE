import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { panelLabel, type GridLayout } from "../gridLayouts";
import { Z } from "../zLayers";

type Props = {
  gridLayouts: GridLayout[];
  activeGridId: string | null;
  anchored: boolean;
  onApplyGrid: (id: string) => void;
  onExitGrid: () => void;
  onSetAnchored: (anchored: boolean) => void;
  onOpenGrid: () => void;
};

function GridIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.2" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.2" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.2" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.2" />
    </svg>
  );
}

function AnchoredIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3.5" y="4" width="5" height="16" rx="1" />
      <rect x="9.5" y="4" width="8" height="11" rx="1" />
      <rect x="18.5" y="4" width="2.5" height="16" rx="0.6" />
      <line x1="9.5" y1="16" x2="18.5" y2="16" />
    </svg>
  );
}

function FreeIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3.5" y="3.5" width="8" height="8" rx="1.2" />
      <rect x="13" y="11" width="8" height="8" rx="1.2" />
      <path d="M9.5 11.5l3.5 1" />
    </svg>
  );
}

export function LayoutBento({
  gridLayouts,
  activeGridId,
  anchored,
  onApplyGrid,
  onExitGrid,
  onSetAnchored,
  onOpenGrid,
}: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // Live position of the popover, measured from the trigger. Re-measured
  // on open, on window resize, and on scroll so the popover stays glued to
  // the trigger even if the user scrolls the workbench.
  const [pos, setPos] = useState<{ bottom: number; right: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const measure = () => {
      const btn = triggerRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      setPos({
        bottom: Math.round(window.innerHeight - r.top + 8),
        right: Math.round(window.innerWidth - r.right),
      });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const target = e.target as Node | null;
      // Clicks inside the trigger or the popover itself are ignored; the
      // popover lives in document.body via createPortal, so we check both
      // refs explicitly rather than relying on .contains() up the tree.
      if (triggerRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div style={{ position: "relative", display: "flex" }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Layout"
        aria-label="Layout"
        aria-expanded={open}
        style={{
          height: 18,
          padding: "0 7px",
          borderRadius: "var(--radius-sm)",
          display: "flex",
          alignItems: "center",
          gap: 5,
          fontSize: 11,
          color: open || activeGridId ? "var(--accent)" : "var(--fg-subtle)",
          background: open || activeGridId ? "var(--accent-soft)" : "transparent",
          transition:
            "background var(--motion-med) var(--ease-out), color var(--motion-med) var(--ease-out)",
        }}
        onMouseEnter={(e) => {
          if (!open && !activeGridId) e.currentTarget.style.background = "var(--bg-hover)";
        }}
        onMouseLeave={(e) => {
          if (!open && !activeGridId) e.currentTarget.style.background = "transparent";
        }}
      >
        <GridIcon />
        {anchored && !activeGridId ? "Anchored" : "Layout"}
      </button>

      {open && pos && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Layout"
          style={{
            // The popover is portaled to document.body so it escapes any
            // ancestor stacking context (the workbench's position: relative,
            // any FloatingPanel wrapper, etc.) and sits on top of every
            // surface in the app.
            position: "fixed",
            bottom: pos.bottom,
            right: pos.right,
            width: 224,
            padding: 12,
            borderRadius: "var(--radius-md)",
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-strong)",
            boxShadow: "var(--shadow-popover, 0 8px 24px rgba(0,0,0,0.18))",
            // Top tier: above floating panels, popovers, and modals — this
            // status-bar picker should never be occluded by app chrome.
            zIndex: Z.contextMenu,
            animation: "chrome-enter var(--motion-med) var(--ease-out)",
          }}
        >
          {/* Anchored — the calm, fullscreen workbench (Ara-style). Default
              for new workspaces; no drag/resize on panels. */}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onSetAnchored(true);
            }}
            aria-pressed={anchored && !activeGridId}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "7px 8px",
              borderRadius: "var(--radius-sm)",
              border: `1px solid ${anchored && !activeGridId ? "var(--accent)" : "var(--border)"}`,
              background: anchored && !activeGridId ? "var(--accent-soft)" : "transparent",
              color: anchored && !activeGridId ? "var(--accent)" : "var(--fg-strong)",
              fontSize: 12,
              cursor: "pointer",
              textAlign: "left",
            }}
            onMouseEnter={(e) => {
              if (!(anchored && !activeGridId)) e.currentTarget.style.background = "var(--bg-hover)";
            }}
            onMouseLeave={(e) => {
              if (!(anchored && !activeGridId)) e.currentTarget.style.background = "transparent";
            }}
          >
            <AnchoredIcon />
            <span style={{ display: "flex", flexDirection: "column" }}>
              <span>Anchored</span>
              <span style={{ fontSize: 9, color: "var(--fg-subtle)", marginTop: 1 }}>
                Side / editor / AI · calm, fullscreen
              </span>
            </span>
            {anchored && !activeGridId ? <span style={{ marginLeft: "auto", fontSize: 10 }}>active</span> : null}
          </button>

          {/* Free layout — opt-in: panels become draggable, resizable
              FloatingPanels with the bento feel. */}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onSetAnchored(false);
              onExitGrid();
            }}
            aria-pressed={!anchored && !activeGridId}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "7px 8px",
              borderRadius: "var(--radius-sm)",
              border: `1px solid ${!anchored && !activeGridId ? "var(--accent)" : "var(--border)"}`,
              background: !anchored && !activeGridId ? "var(--accent-soft)" : "transparent",
              color: !anchored && !activeGridId ? "var(--accent)" : "var(--fg-strong)",
              fontSize: 12,
              cursor: "pointer",
              textAlign: "left",
            }}
            onMouseEnter={(e) => {
              if (!(!anchored && !activeGridId)) e.currentTarget.style.background = "var(--bg-hover)";
            }}
            onMouseLeave={(e) => {
              if (!(!anchored && !activeGridId)) e.currentTarget.style.background = "transparent";
            }}
          >
            <FreeIcon />
            <span style={{ display: "flex", flexDirection: "column" }}>
              <span>Free layout</span>
              <span style={{ fontSize: 9, color: "var(--fg-subtle)", marginTop: 1 }}>
                Drag &amp; resize panels
              </span>
            </span>
            {!anchored && !activeGridId ? <span style={{ marginLeft: "auto", fontSize: 10 }}>active</span> : null}
          </button>

          {gridLayouts.length > 0 && (
            <div
              style={{
                marginTop: 12,
                marginBottom: 6,
                fontSize: 9,
                letterSpacing: 0.4,
                textTransform: "uppercase",
                color: "var(--fg-subtle)",
                fontFamily: "var(--font-ui)",
              }}
            >
              Your grids
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {gridLayouts.map((grid) => {
              const isActive = grid.id === activeGridId;
              return (
                <button
                  key={grid.id}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onApplyGrid(grid.id);
                  }}
                  title={`Apply ${grid.name}`}
                  aria-pressed={isActive}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "5px 6px",
                    borderRadius: "var(--radius-sm)",
                    border: `1px solid ${isActive ? "var(--accent)" : "var(--border)"}`,
                    background: isActive ? "var(--accent-soft)" : "transparent",
                    color: "var(--fg)",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) e.currentTarget.style.background = "var(--bg-hover)";
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) e.currentTarget.style.background = "transparent";
                  }}
                >
                  <MiniGrid grid={grid} />
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span
                      style={{
                        display: "block",
                        fontSize: 11,
                        color: isActive ? "var(--accent)" : "var(--fg-strong)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {grid.name}
                      {isActive ? " · active" : ""}
                    </span>
                    <span style={{ display: "block", fontSize: 9, color: "var(--fg-subtle)" }}>
                      {grid.areas.length} block{grid.areas.length === 1 ? "" : "s"}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          <div
            style={{
              marginTop: 10,
              fontSize: 10,
              color: "var(--fg-subtle)",
              fontFamily: "var(--font-ui)",
            }}
          >
            {gridLayouts.length === 0 ? (
              <>No grids yet — </>
            ) : null}
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onOpenGrid();
              }}
              style={{
                fontSize: 10,
                color: "var(--accent)",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                padding: 0,
              }}
            >
              {gridLayouts.length === 0 ? "build one in Settings" : "Edit grids…"}
            </button>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}


function MiniGrid({ grid }: { grid: GridLayout }) {
  return (
    <span
      aria-hidden
      style={{
        width: 34,
        height: 24,
        flex: "0 0 auto",
        display: "grid",
        gridTemplateColumns: `repeat(${grid.cols}, 1fr)`,
        gridTemplateRows: `repeat(${grid.rows}, 1fr)`,
        gap: 1,
      }}
    >
      {grid.areas.map((area) => (
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
