import { useEffect, useRef, useState } from "react";
import { panelLabel, type GridLayout } from "../gridLayouts";

type Props = {
  gridLayouts: GridLayout[];
  activeGridId: string | null;
  onApplyGrid: (id: string) => void;
  onExitGrid: () => void;
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

export function LayoutBento({
  gridLayouts,
  activeGridId,
  onApplyGrid,
  onExitGrid,
  onOpenGrid,
}: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
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
    <div ref={wrapRef} style={{ position: "relative", display: "flex" }}>
      <button
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
        Layout
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Layout"
          style={{
            position: "absolute",
            bottom: "calc(100% + 8px)",
            right: 0,
            width: 224,
            padding: 12,
            borderRadius: "var(--radius-md)",
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-strong)",
            boxShadow: "var(--shadow-popover, 0 8px 24px rgba(0,0,0,0.18))",
            zIndex: 50,
            animation: "chrome-enter var(--motion-med) var(--ease-out)",
          }}
        >
          {/* Normal (no grid) */}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onExitGrid();
            }}
            aria-pressed={!activeGridId}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "7px 8px",
              borderRadius: "var(--radius-sm)",
              border: `1px solid ${!activeGridId ? "var(--accent)" : "var(--border)"}`,
              background: !activeGridId ? "var(--accent-soft)" : "transparent",
              color: !activeGridId ? "var(--accent)" : "var(--fg-strong)",
              fontSize: 12,
              cursor: "pointer",
              textAlign: "left",
            }}
            onMouseEnter={(e) => {
              if (activeGridId) e.currentTarget.style.background = "var(--bg-hover)";
            }}
            onMouseLeave={(e) => {
              if (activeGridId) e.currentTarget.style.background = "transparent";
            }}
          >
            Normal layout
            {!activeGridId ? <span style={{ marginLeft: "auto", fontSize: 10 }}>active</span> : null}
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
        </div>
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
