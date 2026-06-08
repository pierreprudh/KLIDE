// HoverPopover — a generic hover-revealed popover. The consumer wraps
// a trigger element and provides the content. On mouseenter the
// popover shows after a short delay (so scrolling through a list
// doesn't fire it). It stays open while the cursor is over the
// popover, and hides when the cursor leaves both the trigger and the
// popover.

import { useEffect, useRef, useState, type ReactNode } from "react";

type Props = {
  /** The element that triggers the popover on hover. */
  children: ReactNode;
  /** The popover content. Rendered in a portal-less floating div
   *  positioned relative to the trigger. */
  content: (close: () => void) => ReactNode;
  /** Hover delay in ms before the popover shows. Default 320. */
  delay?: number;
  /** Whether to render the popover anchored to the right of the
   *  trigger (default) or to the left. "auto" picks whichever has
   *  more room. */
  placement?: "right" | "left" | "auto";
  /** Optional className for the popover surface. */
  className?: string;
};

const HOVER_AREA_GAP = 8;

export function HoverPopover({
  children,
  content,
  delay = 320,
  placement = "right",
  className,
}: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const insideRef = useRef(false);

  function clearTimer() {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  function show() {
    const t = triggerRef.current;
    if (!t) return;
    const r = t.getBoundingClientRect();
    const pw = popoverRef.current?.offsetWidth ?? 280;
    const ph = popoverRef.current?.offsetHeight ?? 100;
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Decide horizontal placement.
    const wantRight = placement === "right"
      || (placement === "auto" && vw - r.right - HOVER_AREA_GAP - pw >= margin);
    const left = wantRight
      ? r.right + HOVER_AREA_GAP
      : r.left - HOVER_AREA_GAP - pw;
    // Vertical: align the popover's top with the row, but never go off-screen.
    let top = r.top;
    if (top + ph > vh - margin) {
      top = Math.max(margin, vh - ph - margin);
    }
    setPos({ top, left });
    setOpen(true);
  }

  function scheduleShow() {
    insideRef.current = true;
    clearTimer();
    timerRef.current = window.setTimeout(show, delay);
  }

  function hide() {
    insideRef.current = false;
    clearTimer();
    // Defer the close to give the cursor a moment to travel from the
    // trigger onto the popover. mouseleave on the popover also calls
    // hide, and if the cursor is now over the popover we cancel this.
    window.setTimeout(() => {
      if (!insideRef.current) setOpen(false);
    }, 80);
  }

  // Cancel any pending close when the cursor moves onto the popover.
  useEffect(() => {
    const p = popoverRef.current;
    if (!p || !open) return;
    const enter = () => { insideRef.current = true; clearTimer(); };
    const leave = () => hide();
    p.addEventListener("mouseenter", enter);
    p.addEventListener("mouseleave", leave);
    return () => {
      p.removeEventListener("mouseenter", enter);
      p.removeEventListener("mouseleave", leave);
    };
  }, [open]);

  // Esc closes immediately.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <div
        ref={triggerRef}
        onMouseEnter={scheduleShow}
        onMouseLeave={hide}
        style={{ display: "contents" }}
      >
        {children}
      </div>
      {open && pos && (
        <div
          ref={popoverRef}
          className={`klide-popover ${className ?? ""}`.trim()}
          style={{ top: pos.top, left: pos.left }}
          role="tooltip"
        >
          {content(() => setOpen(false))}
        </div>
      )}
    </>
  );
}
