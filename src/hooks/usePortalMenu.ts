import { useCallback, useEffect, useRef, useState } from "react";

/** A dropdown / tooltip portalled to <body> with viewport-fixed coordinates,
 *  so it escapes the composer's `overflow: hidden` and the floating panel's
 *  `transform` (which would clip an absolutely-positioned popover).
 *
 *  Owns the open state, the trigger + menu refs, the position computed from the
 *  trigger's rect on open, and auto-close on scroll/resize (a portalled menu
 *  can't follow its trigger). Click menus opt into outside-click close; hover
 *  tooltips leave it off. The AI panel's three composer popovers — mode,
 *  reflection, context — were the same ~40 lines of state + effects three
 *  times; this is the one copy behind a small interface.
 *
 *  Generic over the position payload `P` so a caller can carry extra fields
 *  (e.g. the context tooltip's `width` / `compact`) alongside `bottom`/`left`.
 */
export function usePortalMenu<P extends { left: number }>(opts: {
  /** Compute the portal position from the trigger's bounding rect. Return
   *  null to abort opening. */
  computePos: (triggerRect: DOMRect) => P | null;
  /** Close when a mousedown lands outside both the trigger and the menu.
   *  Click menus want this; hover tooltips don't. Default false. */
  closeOnOutsideClick?: boolean;
}) {
  const { computePos, closeOnOutsideClick = false } = opts;
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<P | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setPos(null);
  }, []);

  // Read computePos through a ref so an inline closure caller doesn't make
  // openMenu change identity every render.
  const computeRef = useRef(computePos);
  computeRef.current = computePos;
  const openMenu = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const next = computeRef.current(trigger.getBoundingClientRect());
    if (!next) return;
    setPos(next);
    setOpen(true);
  }, []);

  // The portal can't follow the trigger across scroll/resize — close rather
  // than let it drift. Scrolls that originate inside the menu itself are the
  // menu's own list scrolling, not the trigger moving — leave it open.
  useEffect(() => {
    if (!open) return;
    const onMove = (e?: Event) => {
      if (
        e?.type === "scroll" &&
        e.target instanceof Node &&
        menuRef.current?.contains(e.target)
      )
        return;
      close();
    };
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, close]);

  // Trigger and portalled menu live in different subtrees, so test both.
  useEffect(() => {
    if (!open || !closeOnOutsideClick) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, closeOnOutsideClick, close]);

  return { open, pos, triggerRef, menuRef, openMenu, close };
}
