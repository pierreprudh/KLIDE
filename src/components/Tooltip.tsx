import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactElement, ReactNode } from "react";
import { createPortal } from "react-dom";
import { Z } from "../zLayers";
import { Kbd } from "./Kbd";

// A themed tooltip that replaces the native `title=` popup. Native tooltips
// wait ~500ms, can't be styled, and float wherever the OS wants — they ignore
// the design system and overlap content. This one is bound to hover: it shows
// (almost) instantly while the pointer is over the trigger and hides the
// moment it leaves. Portaled to <body> so it's never clipped by an
// `overflow: hidden` ancestor (e.g. a Mission Control card).
//
// Usage: wrap a single element. We clone it to attach hover/focus handlers and
// a ref (merging any ref the child already had), so there's no extra wrapper
// box to disturb layout.
//
//   <Tooltip label="Expand sub-agents">
//     <button>…</button>
//   </Tooltip>

type Placement = "top" | "bottom";
type Pos = { left: number; top: number };

const GAP = 8; // distance between trigger and tooltip
const MARGIN = 8; // keep-away from the viewport edges

export function Tooltip({
  label,
  keys,
  description,
  placement = "top",
  delay = 0,
  children,
}: {
  /** Tooltip content. When empty/null the child renders untouched. */
  label: ReactNode;
  /** Optional shortcut keycaps shown after the label (from src/shortcuts.ts
   *  via `keysFor(id)`) — the registry keeps chord displays from drifting. */
  keys?: string[];
  /** Optional muted second line — what the action does, not just its name. */
  description?: ReactNode;
  /** Preferred side; auto-flips to the other if there's no room. */
  placement?: Placement;
  /** Hover delay (ms). 0 = appear immediately on hover. */
  delay?: number;
  children: ReactElement;
}) {
  const triggerRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);

  const clearTimer = () => {
    if (timer.current != null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const openSoon = useCallback(
    (immediate?: boolean) => {
      clearTimer();
      if (immediate || delay <= 0) setOpen(true);
      else timer.current = window.setTimeout(() => setOpen(true), delay);
    },
    [delay]
  );

  const closeNow = useCallback(() => {
    clearTimer();
    setOpen(false);
    setPos(null);
  }, []);

  useEffect(() => () => clearTimer(), []);

  // Measure the trigger + the tooltip once it's mounted, then place it with a
  // vertical flip (if the preferred side doesn't fit) and a horizontal clamp
  // (so it never leaves the viewport). Runs before paint, so the tooltip never
  // flashes at the wrong spot — it starts at opacity 0 until `pos` is set.
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const tip = tipRef.current;
    if (!trigger || !tip) return;
    const tr = trigger.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const fitsTop = tr.top - th - GAP >= MARGIN;
    const fitsBottom = tr.bottom + th + GAP <= vh - MARGIN;
    const onTop = placement === "top" ? fitsTop || !fitsBottom : !(fitsBottom || !fitsTop);
    const top = onTop ? tr.top - th - GAP : tr.bottom + GAP;
    const left = Math.max(
      MARGIN,
      Math.min(tr.left + tr.width / 2 - tw / 2, vw - tw - MARGIN)
    );
    setPos({ left: Math.round(left), top: Math.round(top) });
  }, [open, placement, label]);

  // Keep the tooltip bound to the hover state. The pointermove guard is what
  // makes that reliable: in lists that re-render while hovered (Mission Control
  // polls runs), the trigger node can be swapped out from under the cursor and
  // never fire `mouseleave` — so we also watch the pointer globally and close
  // the instant it's no longer over the trigger. Scroll/resize close too, since
  // the measured position would otherwise go stale.
  useEffect(() => {
    if (!open) return;
    const dismiss = () => closeNow();
    const onMove = (e: PointerEvent) => {
      const trigger = triggerRef.current;
      if (!trigger || !(e.target instanceof Node) || !trigger.contains(e.target)) closeNow();
    };
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    document.addEventListener("pointermove", onMove, true);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      document.removeEventListener("pointermove", onMove, true);
    };
  }, [open, closeNow]);

  if (label == null || label === "" || !isValidElement(children)) return children ?? null;

  const childProps = children.props as Record<string, unknown> & {
    ref?: ((n: HTMLElement | null) => void) | { current: HTMLElement | null };
  };

  const trigger = cloneElement(children, {
    // In React 19 `ref` is a regular prop, so the child's own ref (if any)
    // arrives on props — merge it rather than clobber it.
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node;
      const existing = childProps.ref;
      if (typeof existing === "function") existing(node);
      else if (existing && typeof existing === "object") existing.current = node;
    },
    onMouseEnter: (e: React.MouseEvent) => {
      openSoon();
      (childProps.onMouseEnter as ((e: React.MouseEvent) => void) | undefined)?.(e);
    },
    onMouseLeave: (e: React.MouseEvent) => {
      closeNow();
      (childProps.onMouseLeave as ((e: React.MouseEvent) => void) | undefined)?.(e);
    },
    // Show on *keyboard* focus only (`:focus-visible`) for accessibility — a
    // mouse click won't pop it (and so it can't get stuck after a click).
    onFocus: (e: React.FocusEvent) => {
      let keyboard = true;
      try {
        keyboard = (e.currentTarget as HTMLElement).matches(":focus-visible");
      } catch {
        /* :focus-visible unsupported — fall back to showing */
      }
      if (keyboard) openSoon(true);
      (childProps.onFocus as ((e: React.FocusEvent) => void) | undefined)?.(e);
    },
    onBlur: (e: React.FocusEvent) => {
      closeNow();
      (childProps.onBlur as ((e: React.FocusEvent) => void) | undefined)?.(e);
    },
  } as Record<string, unknown>);

  return (
    <>
      {trigger}
      {open &&
        createPortal(
          <div
            ref={tipRef}
            role="tooltip"
            className="klide-tooltip"
            style={{
              zIndex: Z.tooltip,
              left: pos?.left ?? -9999,
              top: pos?.top ?? -9999,
              opacity: pos ? 1 : 0,
            }}
          >
            {keys && keys.length > 0 ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                <span>{label}</span>
                <Kbd keys={keys} />
              </span>
            ) : (
              label
            )}
            {description != null && description !== "" && (
              <div style={{ marginTop: 2, color: "var(--fg-subtle)", fontSize: 11 }}>
                {description}
              </div>
            )}
          </div>,
          document.body
        )}
    </>
  );
}
