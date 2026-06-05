import { useState, type ReactNode } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import {
  PANEL_CONSTRAINTS,
  type PanelConstraints,
  type PanelId,
  type PanelRect,
} from "../panelLayout";

type Props = {
  panelId: PanelId;
  rect: PanelRect;
  workbenchW: number;
  workbenchH: number;
  zIndex: number;
  onFocus: () => void;
  onResize: (next: PanelRect) => void;
  onMove: (next: PanelRect) => void;
  children: ReactNode;
};

// A free-floating, resizable, draggable panel. Three resize handles
// (right / bottom / corner) and a drag grip at the top. All handles
// sit *inside* the panel's box so they're never clipped by the root's
// `overflow: hidden` — the workbench itself is at the root edge for
// the AI panel, so negative-offset handles would disappear off-screen.
export function FloatingPanel({
  panelId,
  rect,
  workbenchW,
  workbenchH,
  zIndex,
  onFocus,
  onResize,
  onMove,
  children,
}: Props) {
  const constraints: PanelConstraints = PANEL_CONSTRAINTS[panelId];
  // Disable the size/position transition while the user is actively dragging
  // or resizing — otherwise the panel would visibly lag behind the cursor.
  // The transition is on for *passive* rect changes (window resize, layout
  // re-clamp) so the panel glides to its new bounds the way macOS does.
  const [isInteracting, setIsInteracting] = useState(false);
  const panelTransition = isInteracting
    ? "none"
    : "left var(--motion-med) var(--ease-soft), " +
      "top var(--motion-med) var(--ease-soft), " +
      "width var(--motion-med) var(--ease-soft), " +
      "height var(--motion-med) var(--ease-soft)";

  function beginResize(
    e: ReactMouseEvent<HTMLDivElement>,
    axis: "x" | "y" | "xy"
  ) {
    e.preventDefault();
    e.stopPropagation();
    onFocus();
    setIsInteracting(true);
    const startX = e.clientX;
    const startY = e.clientY;
    const startRect = { ...rect };
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor =
      axis === "x" ? "col-resize" : axis === "y" ? "row-resize" : "nwse-resize";
    document.body.style.userSelect = "none";

    function onMoveResize(ev: MouseEvent) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const next: PanelRect = { x: startRect.x, y: startRect.y, w: startRect.w, h: startRect.h };
      if (axis === "x" || axis === "xy") {
        next.w = Math.min(constraints.maxW, Math.max(constraints.minW, startRect.w + dx));
        next.w = Math.min(next.w, Math.max(constraints.minW, workbenchW - startRect.x));
      }
      if (axis === "y" || axis === "xy") {
        next.h = Math.min(constraints.maxH, Math.max(constraints.minH, startRect.h + dy));
        next.h = Math.min(next.h, Math.max(constraints.minH, workbenchH - startRect.y));
      }
      onResize(next);
    }

    function onUp() {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
      setIsInteracting(false);
      window.removeEventListener("mousemove", onMoveResize);
      window.removeEventListener("mouseup", onUp);
    }

    window.addEventListener("mousemove", onMoveResize);
    window.addEventListener("mouseup", onUp);
  }

  function beginDrag(e: ReactMouseEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onFocus();
    setIsInteracting(true);
    const startX = e.clientX;
    const startY = e.clientY;
    const startRect = { ...rect };
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";

    function onMoveDrag(ev: MouseEvent) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const next: PanelRect = {
        x: startRect.x + dx,
        y: startRect.y + dy,
        w: startRect.w,
        h: startRect.h,
      };
      next.x = Math.max(0, Math.min(workbenchW - next.w, next.x));
      next.y = Math.max(0, Math.min(workbenchH - next.h, next.y));
      onMove(next);
    }

    function onUp() {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
      setIsInteracting(false);
      window.removeEventListener("mousemove", onMoveDrag);
      window.removeEventListener("mouseup", onUp);
    }

    window.addEventListener("mousemove", onMoveDrag);
    window.addEventListener("mouseup", onUp);
  }

  return (
    <div
      onMouseDown={onFocus}
      style={{
        position: "absolute",
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        zIndex,
        display: "flex",
        flexDirection: "column",
        background: "transparent",
        pointerEvents: "auto",
        transition: panelTransition,
      }}
    >
      {/* Drag grip — a small pill at the very top of the panel. It
          starts tiny and subtle so it doesn't compete with the panel
          chrome; on hover it expands to a clear "drag handle" shape
          with a sage background and three visible dots. */}
      <div
        role="toolbar"
        aria-label={`Move ${panelId}`}
        onMouseDown={beginDrag}
        title="Drag to move"
        className="klide-panel-grip"
        style={{
          position: "absolute",
          top: 3,
          left: "50%",
          transform: "translateX(-50%)",
          width: 18,
          height: 6,
          borderRadius: 999,
          background: "var(--border-strong)",
          opacity: 0.35,
          cursor: "grab",
          // Above any panel-internal chrome — AiPanel's header is
          // position:relative + zIndex:40, which would otherwise sit on
          // top of the grip and swallow the drag mousedown.
          zIndex: 50,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 2,
          transition:
            "width var(--motion-med) var(--ease-soft), " +
            "height var(--motion-med) var(--ease-soft), " +
            "opacity var(--motion-fast) var(--ease-out), " +
            "background var(--motion-fast) var(--ease-out), " +
            "gap var(--motion-med) var(--ease-soft)",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.width = "44px";
          e.currentTarget.style.height = "12px";
          e.currentTarget.style.gap = "3px";
          e.currentTarget.style.opacity = "0.95";
          e.currentTarget.style.background = "var(--accent)";
          // Bump the inner dots from 2px to 3px via a class swap. The
          // dots are children, so we toggle their size directly.
          const dots = e.currentTarget.querySelectorAll<HTMLSpanElement>(".klide-grip-dot");
          dots.forEach((d) => { d.style.width = "3px"; d.style.height = "3px"; });
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.width = "18px";
          e.currentTarget.style.height = "6px";
          e.currentTarget.style.gap = "2px";
          e.currentTarget.style.opacity = "0.35";
          e.currentTarget.style.background = "var(--border-strong)";
          const dots = e.currentTarget.querySelectorAll<HTMLSpanElement>(".klide-grip-dot");
          dots.forEach((d) => { d.style.width = "2px"; d.style.height = "2px"; });
        }}
      >
        <span className="klide-grip-dot" style={{ width: 2, height: 2, borderRadius: "50%", background: "var(--bg-elevated)", transition: "width var(--motion-med) var(--ease-soft), height var(--motion-med) var(--ease-soft)" }} />
        <span className="klide-grip-dot" style={{ width: 2, height: 2, borderRadius: "50%", background: "var(--bg-elevated)", transition: "width var(--motion-med) var(--ease-soft), height var(--motion-med) var(--ease-soft)" }} />
        <span className="klide-grip-dot" style={{ width: 2, height: 2, borderRadius: "50%", background: "var(--bg-elevated)", transition: "width var(--motion-med) var(--ease-soft), height var(--motion-med) var(--ease-soft)" }} />
      </div>
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {children}
      </div>
      {/* Right edge — resize width. Sits inside the panel so it never
          gets clipped by the workbench / root overflow. */}
      <div
        role="separator"
        aria-label={`Resize ${panelId} width`}
        onMouseDown={(e) => beginResize(e, "x")}
        style={{
          position: "absolute",
          right: 0,
          top: 0,
          bottom: 0,
          width: 8,
          cursor: "col-resize",
          zIndex: 41,
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: "0 3px",
            background: "transparent",
            transition: "background var(--motion-fast) var(--ease-out)",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--accent-soft)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        />
      </div>
      {/* Bottom edge — resize height. Inside the panel. */}
      <div
        role="separator"
        aria-label={`Resize ${panelId} height`}
        onMouseDown={(e) => beginResize(e, "y")}
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 8,
          cursor: "row-resize",
          zIndex: 41,
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: "3px 0",
            background: "transparent",
            transition: "background var(--motion-fast) var(--ease-out)",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--accent-soft)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        />
      </div>
      {/* Corner — resize both. Inside the panel. */}
      <div
        role="separator"
        aria-label={`Resize ${panelId}`}
        onMouseDown={(e) => beginResize(e, "xy")}
        style={{
          position: "absolute",
          right: 0,
          bottom: 0,
          width: 16,
          height: 16,
          cursor: "nwse-resize",
          zIndex: 42,
        }}
      />
    </div>
  );
}
