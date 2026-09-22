import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Z } from "../zLayers";

export type MenuItem =
  | { type: "separator" }
  | {
      type: "item";
      label: string;
      /** Red text, red-tinted highlight — the one destructive row. */
      danger?: boolean;
      onSelect: () => void;
    };

type Props = {
  x: number;
  y: number;
  /** Which edge of the menu `x` is. A pointer opens at its own point (`start`);
   *  a ⋯ button hangs the menu from its trailing edge (`end`), so the sheet
   *  grows toward the room it has, not into the panel's border. */
  align?: "start" | "end";
  items: MenuItem[];
  onClose: () => void;
};

const MENU_MIN_WIDTH = 200;
const VIEWPORT_MARGIN = 8;

/** The one right-click / ⋯ menu — Explorer rows and conversation rows both
 *  open it. It wears the same sheet as every other popover in the app
 *  (`popover-enter menu-glass`), so a menu opened from the rail and one
 *  dropped from the composer read as the same object, and it behaves like a
 *  native menu: arrows walk it, Home/End jump, a letter finds the row that
 *  starts with it, Enter takes it, Escape leaves it. Hover and the keyboard
 *  move one shared highlight, never two. */
export function ContextMenu({ x, y, align = "start", items, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Anchor edge before the clamp; where the sheet unfolds from after it.
  const [placed, setPlaced] = useState<{ left: number; top: number; origin: string } | null>(null);
  // The highlighted row — the pointer's or the keyboard's, one at a time.
  const [active, setActive] = useState<number | null>(null);
  const selectable = items
    .map((item, i) => (item.type === "item" ? i : -1))
    .filter((i) => i >= 0);

  // Place once the sheet's real size is known, before it paints: hang it from
  // the requested edge, keep it inside the viewport, and let the entrance
  // grow from whichever corner ended up on the anchor.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const wantedLeft = align === "end" ? x - rect.width : x;
    const maxLeft = window.innerWidth - rect.width - VIEWPORT_MARGIN;
    const maxTop = window.innerHeight - rect.height - VIEWPORT_MARGIN;
    const left = Math.max(VIEWPORT_MARGIN, Math.min(wantedLeft, maxLeft));
    const top = Math.max(VIEWPORT_MARGIN, Math.min(y, maxTop));
    const fromRight = align === "end" ? left + rect.width <= x + 1 : left < wantedLeft;
    const fromBottom = top < y;
    setPlaced({
      left,
      top,
      origin: `${fromBottom ? "bottom" : "top"} ${fromRight ? "right" : "left"}`,
    });
  }, [x, y, align]);

  // A menu that follows the anchor cannot: close when the page under it moves.
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [onClose]);

  function focusItem(index: number | null) {
    setActive(index);
    if (index !== null) itemRefs.current[index]?.focus({ preventScroll: true });
  }

  function step(delta: 1 | -1) {
    if (selectable.length === 0) return;
    const at = active === null ? -1 : selectable.indexOf(active);
    const next =
      at === -1
        ? delta === 1
          ? selectable[0]
          : selectable[selectable.length - 1]
        : selectable[(at + delta + selectable.length) % selectable.length];
    focusItem(next);
  }

  // Keys are read at the window: a right-click menu takes no focus of its
  // own, so a mouse-only visit leaves the page's focus where it was, and the
  // first arrow press is what moves it in.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          onClose();
          return;
        case "ArrowDown":
          e.preventDefault();
          step(1);
          return;
        case "ArrowUp":
          e.preventDefault();
          step(-1);
          return;
        case "Home":
          e.preventDefault();
          focusItem(selectable[0] ?? null);
          return;
        case "End":
          e.preventDefault();
          focusItem(selectable[selectable.length - 1] ?? null);
          return;
        case "Tab":
          // Focus must not walk out from under an open menu.
          e.preventDefault();
          onClose();
          return;
      }
      // Type-ahead: the next row, after the highlight, whose label starts
      // with the letter typed — the way a native menu answers a keystroke.
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const letter = e.key.toLowerCase();
        const from = active === null ? -1 : selectable.indexOf(active);
        for (let k = 1; k <= selectable.length; k++) {
          const index = selectable[(from + k) % selectable.length];
          const item = items[index];
          if (item.type === "item" && item.label.toLowerCase().startsWith(letter)) {
            e.preventDefault();
            focusItem(index);
            return;
          }
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, active, items]);

  // Portal to <body>: the sidebar's .floating-panel has transform +
  // backdrop-filter, which would trap position:fixed inside it.
  return createPortal(
    <div
      onMouseDown={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
      style={{ position: "fixed", inset: 0, zIndex: Z.contextMenu }}
    >
      <div
        ref={menuRef}
        role="menu"
        className="popover-enter menu-glass"
        onMouseDown={(e) => e.stopPropagation()}
        onMouseLeave={() => setActive(null)}
        style={{
          position: "fixed",
          left: placed?.left ?? x,
          top: placed?.top ?? y,
          // Unseen until placed — the clamp runs before paint, but a sheet
          // that unfolds from the wrong corner for one frame still shows.
          visibility: placed ? "visible" : "hidden",
          transformOrigin: placed?.origin ?? "top left",
          minWidth: MENU_MIN_WIDTH,
          padding: 5,
          color: "var(--fg-strong)",
          fontSize: 13,
          lineHeight: 1,
          letterSpacing: "0.002em",
          userSelect: "none",
        }}
      >
        {items.map((item, i) =>
          item.type === "separator" ? (
            <div
              key={i}
              role="separator"
              style={{ height: 1, background: "var(--border)", margin: "5px 8px" }}
            />
          ) : (
            <button
              key={i}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              data-active={active === i || undefined}
              onMouseEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              onClick={() => {
                onClose();
                item.onSelect();
              }}
              style={{
                display: "flex",
                alignItems: "center",
                width: "100%",
                height: 28,
                padding: "0 10px",
                border: 0,
                borderRadius: "var(--radius-sm)",
                font: "inherit",
                letterSpacing: "inherit",
                textAlign: "left",
                color: item.danger ? "var(--danger)" : "inherit",
                // The highlight is the focus ring: one row lit, however it
                // was reached. No second outline on top of it.
                outline: "none",
                background:
                  active === i
                    ? item.danger
                      ? "color-mix(in srgb, var(--danger) 9%, transparent)"
                      : "var(--menu-row-hover)"
                    : "transparent",
                cursor: "default",
                transition: "background var(--motion-fast) var(--ease-out)",
              }}
            >
              {item.label}
            </button>
          ),
        )}
      </div>
    </div>,
    document.body,
  );
}
