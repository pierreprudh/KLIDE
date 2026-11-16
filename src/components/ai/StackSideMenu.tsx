// The provider picker's body, shared by the AI panel and Focus: each stack
// (Routed, Local, Subscription, API, Self-hosted) is one eyebrow line, and its
// rows open in a card beside the menu instead of folding open under it — so
// twenty-odd API providers never push the other stacks out of reach.
//
// The look is the picker's own: uppercase eyebrows with the stack chevron,
// roomy logo rows, the active row carried by its fill and weight, a quiet row
// for one that can't run yet, ↗ on a row that leads to Settings.
//
// Both cards live inside one transparent wrapper, which is the caller's menu
// element (its outside-click target). The wrapper has no overflow of its own,
// so the side card, absolutely placed against it, is never clipped; each card
// is its own `menu-glass`.
//
// Moving between them:
// - The pointer may cut across other eyebrows on its way to the card: while it
//   heads for the card, an eyebrow it crosses waits (menu-aim) instead of
//   swapping the card out from under it.
// - The card glides to its new eyebrow and its height eases to the new list;
//   the rows cross-fade in. Reduced motion turns all of it off (tokens.css).
// - Keys: ↑/↓ walk the eyebrows (or the rows), → / Enter step into the card,
//   ← steps back, Home/End jump. Esc is the caller's.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";

export type StackRow = {
  id: string;
  label: string;
  icon: ReactNode;
  active?: boolean;
  /** Exists but can't run yet (no key, CLI missing): quieted. */
  dimmed?: boolean;
  /** Leads out of the menu (to Settings) rather than choosing: grows a ↗. */
  leadout?: boolean;
  title?: string;
  onPick: () => void;
};

export type Stack = { label: string; rows: StackRow[] };

const GAP = 6;
const MARGIN = 8;
const SIDE_WIDTH = 236;
const SIDE_MAX_HEIGHT = 360;
const PAD = 5;
/** How long a crossed eyebrow waits while the pointer heads for the card. */
const AIM_DELAY = 220;

type Point = { x: number; y: number };

/** Is `p` inside the triangle from `a` to the card's near edge (`b`–`c`)? */
export function inTriangle(p: Point, a: Point, b: Point, c: Point): boolean {
  const sign = (p1: Point, p2: Point, p3: Point) => (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
  const d1 = sign(p, a, b);
  const d2 = sign(p, b, c);
  const d3 = sign(p, c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

export function StackSideMenu({
  stacks,
  width = 196,
  leaving = false,
  origin = "top left",
}: {
  stacks: Stack[];
  width?: number;
  /** The caller's presence flag, so both cards play the leave animation. */
  leaving?: boolean;
  origin?: "top left" | "bottom left";
}) {
  // Opens on the stack holding the current choice — the same rule the folding
  // menu used ("only the active stack unfolded"), now as the side card.
  const [openStack, setOpenStack] = useState<string | null>(
    () => stacks.find((s) => s.rows.some((r) => r.active))?.label ?? stacks[0]?.label ?? null,
  );
  const primaryRef = useRef<HTMLDivElement>(null);
  const headingRefs = useRef(new Map<string, HTMLButtonElement>());
  const sideRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const [sidePos, setSidePos] = useState<{ top: number; side: "right" | "left"; height: number } | null>(null);
  // The first placement lands where it belongs; only later moves glide.
  const [placed, setPlaced] = useState(false);
  const stack = stacks.find((s) => s.label === openStack) ?? null;
  // What can run leads; quieted rows (no key, CLI missing) follow, each group
  // in its registry order.
  const rows = stack ? [...stack.rows].sort((a, b) => Number(!!a.dimmed) - Number(!!b.dimmed)) : [];

  // Beside the primary card, its top level with the open eyebrow; flipped to
  // the left when the window has no room on the right, and lifted when it
  // would run past the bottom edge. Its height is the list's, so a change of
  // stack can ease from one to the other.
  useLayoutEffect(() => {
    const primary = primaryRef.current;
    const heading = openStack ? headingRefs.current.get(openStack) : null;
    if (!primary || !heading) {
      setSidePos(null);
      return;
    }
    const p = primary.getBoundingClientRect();
    const h = heading.getBoundingClientRect();
    const side = p.right + GAP + SIDE_WIDTH > window.innerWidth - MARGIN && p.left - GAP - SIDE_WIDTH > MARGIN ? "left" : "right";
    const content = (rowsRef.current?.scrollHeight ?? 0) + PAD * 2;
    const height = Math.min(SIDE_MAX_HEIGHT, content, window.innerHeight - MARGIN * 2);
    let top = h.top - p.top - PAD;
    const overflow = p.top + top + height - (window.innerHeight - MARGIN);
    if (overflow > 0) top -= overflow;
    if (p.top + top < MARGIN) top = MARGIN - p.top;
    setSidePos({ top, side, height });
  }, [openStack, rows.length]);

  useEffect(() => {
    if (!sidePos || placed) return;
    const frame = requestAnimationFrame(() => setPlaced(true));
    return () => cancelAnimationFrame(frame);
  }, [sidePos, placed]);

  // ── Menu-aim ──────────────────────────────────────────────────────────
  const lastPoint = useRef<Point | null>(null);
  const prevPoint = useRef<Point | null>(null);
  const pending = useRef<{ label: string; timer: number } | null>(null);
  const clearPending = () => {
    if (pending.current) window.clearTimeout(pending.current.timer);
    pending.current = null;
  };
  useEffect(() => clearPending, []);

  /** Heading for the card: the pointer's last step stays inside the triangle
   *  from where it was to the card's near corners. */
  function aimingAtCard(): boolean {
    const card = sideRef.current?.getBoundingClientRect();
    const from = prevPoint.current;
    const to = lastPoint.current;
    if (!card || !from || !to || !sidePos) return false;
    const edgeX = sidePos.side === "right" ? card.left : card.right;
    const towards = sidePos.side === "right" ? to.x >= from.x : to.x <= from.x;
    if (!towards) return false;
    return inTriangle(to, from, { x: edgeX, y: card.top - 8 }, { x: edgeX, y: card.bottom + 8 });
  }

  function hoverHeading(label: string) {
    if (label === openStack) {
      clearPending();
      return;
    }
    if (aimingAtCard()) {
      // Wait; if the pointer settles here instead of reaching the card, open it.
      clearPending();
      pending.current = {
        label,
        timer: window.setTimeout(() => {
          pending.current = null;
          setOpenStack(label);
        }, AIM_DELAY),
      };
      return;
    }
    clearPending();
    setOpenStack(label);
  }

  // ── Keys ──────────────────────────────────────────────────────────────
  function focusHeading(index: number) {
    const label = stacks[(index + stacks.length) % stacks.length]?.label;
    if (!label) return;
    setOpenStack(label);
    headingRefs.current.get(label)?.focus();
  }
  function rowButtons(): HTMLButtonElement[] {
    return Array.from(rowsRef.current?.querySelectorAll<HTMLButtonElement>("button[role=menuitem]") ?? []);
  }
  function enterCard() {
    const buttons = rowButtons();
    const activeIndex = rows.findIndex((r) => r.active);
    (buttons[activeIndex >= 0 ? activeIndex : 0] ?? buttons[0])?.focus();
  }
  function onHeadingKey(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    const keys: Record<string, () => void> = {
      ArrowDown: () => focusHeading(index + 1),
      ArrowUp: () => focusHeading(index - 1),
      Home: () => focusHeading(0),
      End: () => focusHeading(stacks.length - 1),
      ArrowRight: enterCard,
      Enter: enterCard,
      " ": enterCard,
    };
    const run = keys[e.key];
    if (!run) return;
    e.preventDefault();
    run();
  }
  function onRowKey(e: KeyboardEvent<HTMLDivElement>) {
    const buttons = rowButtons();
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => buttons[(i + buttons.length) % buttons.length]?.focus();
    const keys: Record<string, () => void> = {
      ArrowDown: () => go(at + 1),
      ArrowUp: () => go(at - 1),
      Home: () => go(0),
      End: () => go(buttons.length - 1),
      ArrowLeft: () => openStack && headingRefs.current.get(openStack)?.focus(),
    };
    const run = keys[e.key];
    if (!run) return;
    e.preventDefault();
    run();
  }

  // The open eyebrow takes focus when the menu opens, so the keys work at
  // once; a pointer user never sees it (no focus ring without a key press).
  useEffect(() => {
    if (openStack) headingRefs.current.get(openStack)?.focus({ preventScroll: true });
    // Only on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sideStyle: CSSProperties = {
    position: "absolute",
    top: 0,
    ...(sidePos?.side === "left" ? { right: `calc(100% + ${GAP}px)` } : { left: `calc(100% + ${GAP}px)` }),
    width: SIDE_WIDTH,
    height: sidePos?.height,
    overflowY: "auto",
    overscrollBehavior: "contain",
    padding: PAD,
    // The card's own entrance (`picker-menu`) scales from the corner nearest
    // the menu; the glide between stacks is the wrapper's translate.
    transformOrigin: sidePos?.side === "left" ? "top right" : "top left",
    transition: placed ? "height 220ms var(--ease-soft)" : "none",
  };

  return (
    <div
      style={{ position: "relative", width }}
      onMouseMove={(e) => {
        prevPoint.current = lastPoint.current;
        lastPoint.current = { x: e.clientX, y: e.clientY };
      }}
    >
      <div
        ref={primaryRef}
        role="menu"
        className="picker-menu menu-glass"
        data-leaving={leaving}
        style={{ padding: PAD, transformOrigin: origin }}
      >
        {stacks.map((s, index) => {
          const open = s.label === openStack;
          const holdsSelected = s.rows.some((r) => r.active);
          const allQuiet = s.rows.every((r) => r.dimmed);
          return (
            <button
              key={s.label}
              ref={(el) => {
                if (el) headingRefs.current.set(s.label, el);
                else headingRefs.current.delete(s.label);
              }}
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={open}
              className="stack-side-heading"
              onMouseEnter={() => hoverHeading(s.label)}
              onMouseLeave={() => {
                if (pending.current?.label === s.label) clearPending();
              }}
              onFocus={() => setOpenStack(s.label)}
              onClick={() => {
                clearPending();
                setOpenStack(s.label);
              }}
              onKeyDown={(e) => onHeadingKey(e, index)}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 5,
                padding: "7px 9px",
                border: "none",
                borderRadius: "var(--radius-sm)",
                background: open ? "var(--menu-row-hover)" : "transparent",
                cursor: "pointer",
                textAlign: "left",
                fontSize: 9.5,
                fontWeight: 600,
                letterSpacing: "0.07em",
                textTransform: "uppercase",
                color: open || holdsSelected ? "var(--fg-strong)" : "var(--fg-dim)",
                opacity: allQuiet ? 0.5 : 1,
                transition: "color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)",
              }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>{s.label}</span>
              <span
                className="stack-side-chevron"
                data-open={open}
                style={{ display: "grid", placeItems: "center" }}
              >
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </span>
            </button>
          );
        })}
      </div>
      {stack && (
        // The glide: the wrapper moves to the open eyebrow; the card inside
        // keeps its own entrance animation untouched.
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            transform: `translateY(${sidePos?.top ?? 0}px)`,
            transition: placed ? "transform 220ms var(--ease-soft)" : "none",
            visibility: sidePos ? "visible" : "hidden",
          }}
        >
          <div
            ref={sideRef}
            role="menu"
            aria-label={stack.label}
            className="picker-menu menu-scroll menu-glass"
            data-leaving={leaving}
            style={{ ...sideStyle, pointerEvents: "auto" }}
            onMouseEnter={clearPending}
            onKeyDown={onRowKey}
          >
            <div ref={rowsRef} key={stack.label} className="stack-side-rows">
              {rows.map((row) => (
                <StackRowButton key={row.id} row={row} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StackRowButton({ row }: { row: StackRow }) {
  return (
    <button
      type="button"
      role="menuitem"
      title={row.title}
      onClick={row.onPick}
      className="stack-side-row"
      data-active={row.active ? "true" : undefined}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "7px 9px",
        border: "none",
        borderRadius: "var(--radius-sm)",
        color: "var(--fg-strong)",
        cursor: "pointer",
        fontSize: 12,
        fontWeight: row.active ? 550 : 500,
        textAlign: "left",
      }}
    >
      <span style={{ width: 20, height: 20, display: "grid", placeItems: "center", flexShrink: 0, color: "var(--fg-subtle)", opacity: row.dimmed ? 0.4 : 1 }}>
        {row.icon}
      </span>
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: row.dimmed ? 0.45 : 1 }}>
        {row.label}
      </span>
      {row.leadout && (
        <svg className="menu-leadout" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
          <path d="M7 17 17 7" />
          <path d="M8 7h9v9" />
        </svg>
      )}
    </button>
  );
}
