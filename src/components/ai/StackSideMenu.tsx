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

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

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
    () => stacks.find((s) => s.rows.some((r) => r.active))?.label ?? null,
  );
  const primaryRef = useRef<HTMLDivElement>(null);
  const headingRefs = useRef(new Map<string, HTMLButtonElement>());
  const sideRef = useRef<HTMLDivElement>(null);
  const [sidePos, setSidePos] = useState<{ top: number; side: "right" | "left" } | null>(null);
  const stack = stacks.find((s) => s.label === openStack) ?? null;

  // Beside the primary card, its top level with the open eyebrow; flipped to
  // the left when the window has no room on the right, and lifted when it
  // would run past the bottom edge.
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
    const height = Math.min(SIDE_MAX_HEIGHT, sideRef.current?.scrollHeight ?? SIDE_MAX_HEIGHT);
    let top = h.top - p.top - 5;
    const overflow = p.top + top + height - (window.innerHeight - MARGIN);
    if (overflow > 0) top -= overflow;
    if (p.top + top < MARGIN) top = MARGIN - p.top;
    setSidePos({ top, side });
  }, [openStack, stack?.rows.length]);

  const sideStyle: CSSProperties = {
    position: "absolute",
    top: sidePos?.top ?? 0,
    ...(sidePos?.side === "left" ? { right: `calc(100% + ${GAP}px)` } : { left: `calc(100% + ${GAP}px)` }),
    width: SIDE_WIDTH,
    maxHeight: SIDE_MAX_HEIGHT,
    overflowY: "auto",
    overscrollBehavior: "contain",
    padding: 5,
    transformOrigin: sidePos?.side === "left" ? "top right" : "top left",
    visibility: sidePos ? "visible" : "hidden",
  };

  return (
    <div style={{ position: "relative", width }}>
      <div
        ref={primaryRef}
        role="menu"
        className="picker-menu menu-glass"
        data-leaving={leaving}
        style={{ padding: 5, transformOrigin: origin }}
      >
        {stacks.map((s) => {
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
              aria-haspopup="menu"
              aria-expanded={open}
              onMouseEnter={() => setOpenStack(s.label)}
              onFocus={() => setOpenStack(s.label)}
              onClick={() => setOpenStack(s.label)}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "Enter") {
                  e.preventDefault();
                  setOpenStack(s.label);
                  sideRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
                }
              }}
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
              <span className="picker-stack-chevron" style={{ color: "var(--fg-dim)" }}>
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </span>
            </button>
          );
        })}
      </div>
      {stack && (
        <div
          ref={sideRef}
          role="menu"
          aria-label={stack.label}
          className="picker-menu menu-scroll menu-glass"
          data-leaving={leaving}
          style={sideStyle}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              headingRefs.current.get(stack.label)?.focus();
            }
          }}
        >
          {/* What can run leads; quieted rows (no key, CLI missing) follow,
              each group in its registry order. */}
          {[...stack.rows].sort((a, b) => Number(!!a.dimmed) - Number(!!b.dimmed)).map((row) => (
            <StackRowButton key={row.id} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

function StackRowButton({ row }: { row: StackRow }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      role="menuitem"
      title={row.title}
      onClick={row.onPick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "7px 9px",
        border: "none",
        borderRadius: "var(--radius-sm)",
        background: row.active ? "var(--menu-row-active)" : hover ? "var(--menu-row-hover)" : "transparent",
        color: "var(--fg-strong)",
        cursor: "pointer",
        fontSize: 12,
        fontWeight: row.active ? 550 : 500,
        textAlign: "left",
        transition: "background var(--motion-fast) var(--ease-out)",
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
