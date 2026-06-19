import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type MenuItem =
  | { type: "separator" }
  | {
      type: "item";
      label: string;
      danger?: boolean;
      onSelect: () => void;
    };

type Props = {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
};

export function ContextMenu({ x, y, items, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // Clamp to the viewport once the menu's real size is known.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - rect.width - 8)),
      y: Math.max(4, Math.min(y, window.innerHeight - rect.height - 8)),
    });
  }, [x, y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Portal to <body>: the sidebar's .floating-panel has transform +
  // backdrop-filter, which would trap position:fixed inside it.
  return createPortal(
    <div
      onMouseDown={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
      style={{ position: "fixed", inset: 0, zIndex: 9999 }}
    >
      <div
        ref={menuRef}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          position: "fixed",
          left: pos.x,
          top: pos.y,
          minWidth: 190,
          padding: 4,
          background: "var(--bg-elevated)",
          border: "1px solid var(--panel-border)",
          borderRadius: "var(--radius-md)",
          boxShadow: "var(--panel-shadow)",
          fontSize: 13,
          userSelect: "none",
        }}
      >
        {items.map((item, i) =>
          item.type === "separator" ? (
            <div
              key={i}
              style={{ height: 1, background: "var(--border)", margin: "4px 6px" }}
            />
          ) : (
            <div
              key={i}
              onClick={() => {
                onClose();
                item.onSelect();
              }}
              style={{
                padding: "5px 10px",
                borderRadius: "var(--radius-xs)",
                color: item.danger ? "#D64545" : "var(--fg-strong)",
                cursor: "pointer",
                transition: "background var(--motion-fast) var(--ease-out)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
            >
              {item.label}
            </div>
          )
        )}
      </div>
    </div>,
    document.body
  );
}
