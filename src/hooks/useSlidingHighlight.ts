import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** The command menu's one highlight, for a list whose selection is a page
 *  rather than a cursor. It follows the pointer and settles back on the
 *  selected row when the pointer leaves, so hovering never swaps the page.
 *  It animates only once it has been placed, so it never sweeps in on open.
 *
 *  The list element must be `position: relative` — rows are measured by
 *  `offsetTop` against it. `layoutKey` changes whenever rows move. */
export function useSlidingHighlight(activeKey: string | null, layoutKey: string) {
  const rows = useRef(new Map<string, HTMLElement>());
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [rect, setRect] = useState<{ top: number; height: number } | null>(null);
  const [ready, setReady] = useState(false);
  const key = hoverKey ?? activeKey;

  useLayoutEffect(() => {
    const el = key ? rows.current.get(key) : undefined;
    setRect(el ? { top: el.offsetTop, height: el.offsetHeight } : null);
  }, [key, layoutKey]);

  // Keyboard moves the selection; keep it in view. Hover never scrolls.
  useLayoutEffect(() => {
    if (activeKey) rows.current.get(activeKey)?.scrollIntoView({ block: "nearest" });
  }, [activeKey]);

  useEffect(() => {
    if (!rect || ready) return;
    const frame = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(frame);
  }, [rect, ready]);

  return {
    indicator: rect
      ? { style: { transform: `translateY(${rect.top}px)`, height: rect.height }, ready }
      : null,
    row: (k: string) => ({
      ref: (el: HTMLElement | null) => {
        if (el) rows.current.set(k, el);
        else rows.current.delete(k);
      },
      onMouseEnter: () => setHoverKey(k),
    }),
    list: { onMouseLeave: () => setHoverKey(null) },
  };
}
