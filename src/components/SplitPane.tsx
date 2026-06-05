import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

type Props = {
  top: ReactNode;
  bottom: ReactNode;
  /** Initial split position in pixels from the top (default 50%). */
  defaultSplit?: number;
  /** Minimum height for each pane in pixels. */
  minPane?: number;
  onResizing?: (topHeight: number) => void;
};

export function SplitPane({ top, bottom, defaultSplit, minPane = 80 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dividerRef = useRef<HTMLDivElement>(null);
  const [topHeight, setTopHeight] = useState<number>(defaultSplit ?? 0);
  const [measured, setMeasured] = useState(false);
  const dragging = useRef(false);

  // Measure container and init split to 50% on first render
  useEffect(() => {
    const el = containerRef.current;
    if (!el || measured) return;
    const h = el.getBoundingClientRect().height;
    if (h > 0) {
      setTopHeight(defaultSplit ?? h / 2);
      setMeasured(true);
    }
  }, [defaultSplit, measured]);

  // Re-clamp topHeight when the container is resized. Without this, a parent
  // FloatingPanel shrinking below topHeight + minPane leaves the divider
  // rendered off-screen and the user has no way to drag it back into view.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const clamp = () => {
      const h = el.getBoundingClientRect().height;
      if (h <= 0) return;
      setTopHeight((cur) => {
        // If the container is too small to give both panes their minimum,
        // pin the top to whatever fits so the divider stays reachable.
        if (h < minPane * 2) return Math.max(0, h - minPane);
        return Math.min(cur, h - minPane);
      });
    };
    clamp();
    const ro = new ResizeObserver(clamp);
    ro.observe(el);
    return () => ro.disconnect();
  }, [minPane]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    if (!dragging.current) return;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const maxH = Math.max(0, rect.height - minPane);

    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      let y = e.clientY - rect.top;
      y = Math.max(minPane, Math.min(y, maxH));
      setTopHeight(y);
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [minPane]);

  return (
    <div
      ref={containerRef}
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, position: "relative" }}
    >
      <div style={{ flex: "0 0 auto", height: topHeight || 100, minHeight: 0, overflow: "hidden", transition: "height var(--motion-med) var(--ease-soft)" }}>
        {top}
      </div>
      <div
        ref={dividerRef}
        onMouseDown={onMouseDown}
        style={{
          flexShrink: 0,
          height: 5,
          cursor: "row-resize",
          position: "relative",
          zIndex: 1,
          background: "transparent",
          margin: "-2px 0",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 6,
            right: 6,
            top: 2,
            height: 1,
            borderRadius: 1,
            background: "var(--border)",
            transition: "background var(--motion-fast) var(--ease-out)",
          }}
        />
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        {bottom}
      </div>
    </div>
  );
}
