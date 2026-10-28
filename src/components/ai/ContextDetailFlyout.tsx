import { useLayoutEffect, useRef, type ReactNode } from "react";

/** Return a parent-relative top that keeps the measured flyout in the viewport. */
export function contextFlyoutTop(parentTop: number, rowTop: number, height: number, viewportHeight: number): number {
  const top = Math.max(8, Math.min(parentTop + rowTop - 9, viewportHeight - 8 - height));
  return top - parentTop;
}

export function ContextDetailFlyout({ top, onRight, children }: {
  top: number;
  onRight: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    const parent = node?.offsetParent;
    if (!node || !(parent instanceof HTMLElement)) return;
    const place = () => {
      node.style.top = `${contextFlyoutTop(parent.getBoundingClientRect().top, top, node.offsetHeight, window.innerHeight)}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(node);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [top]);

  return (
    <div ref={ref} className="popover-enter" aria-hidden="true"
      style={{ position: "absolute", top: top - 9, ...(onRight ? { left: "calc(100% + 8px)" } : { right: "calc(100% + 8px)" }), width: 216, maxHeight: "calc(100vh - 16px)", overflowY: "auto", padding: "8px 11px 9px", borderRadius: "var(--radius-lg)", border: "1px solid var(--border-strong)", background: "var(--bg-elevated)", boxShadow: "0 14px 38px rgba(38, 38, 32, 0.18)", pointerEvents: "none", display: "grid", gap: 6, fontSize: 12, lineHeight: 1.25 }}>
      {children}
    </div>
  );
}
