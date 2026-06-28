import { useLayoutEffect, useRef, useState } from "react";
import { useFlipIndicator } from "../hooks/useFlipIndicator";

type Tab = { path: string; dirty: boolean; externalChanged?: boolean };
type Props = {
  tabs: Tab[];
  activeIdx: number;
  onSelect: (i: number) => void;
  onClose: (i: number) => void;
  workspaceRoot: string | null;
};

function displayPath(path: string, workspaceRoot: string | null): string {
  if (workspaceRoot && path.startsWith(`${workspaceRoot}/`)) {
    return path.slice(workspaceRoot.length + 1);
  }
  return path;
}

export function TabBar({ tabs, activeIdx, onSelect, onClose, workspaceRoot }: Props) {
  // The FLIP bar rides along the bottom of the active tab. The bar's
  // width follows the active tab's measured width.
  const activeTab = activeIdx >= 0 ? tabs[activeIdx]?.path : null;
  const flip = useFlipIndicator(activeTab ?? null, { size: 2, active: activeTab !== null, axis: "x" });
  const [barWidth, setBarWidth] = useState(0);

  // The bar's width tracks the active tab's measured width so it
  // spans the tab like a Linear-style underline indicator.
  const activeItemRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!activeItemRef.current) return;
    setBarWidth(activeItemRef.current.getBoundingClientRect().width);
  }, [activeIdx, tabs.length]);

  if (tabs.length === 0) {
    return null;
  }

  return (
    <div
      className="chrome-enter"
      style={{
        position: "relative",
        height: "var(--size-tab-strip)",
        background: "color-mix(in srgb, var(--bg-elevated) 72%, transparent)",
        display: "flex",
        alignItems: "flex-end",
        overflowX: "auto",
        backdropFilter: "blur(12px)",
        flexShrink: 0,
        padding: "0 10px",
        gap: 2,
      }}
    >
      <div
        ref={flip.trackRef}
        data-flip={flip.flip}
        aria-hidden="true"
        style={{
          position: "absolute",
          left: 10,
          right: 10,
          bottom: 0,
          height: 2,
          pointerEvents: "none",
        }}
      >
        <span
          className="klide-flip-indicator klide-tab-bar-indicator"
          style={{
            ...flip.style,
            height: 2,
            width: barWidth,
            background: "var(--accent)",
            borderRadius: "2px 2px 0 0",
          }}
        />
      </div>

      {tabs.map((t, i) => {
        const isActive = i === activeIdx;
        const relative = displayPath(t.path, workspaceRoot);
        const filename = relative.split("/").pop() ?? relative;
        const folder = relative.includes("/")
          ? relative.split("/").slice(0, -1).join("/")
          : "";
        return (
          <div
            key={t.path}
            ref={isActive ? activeItemRef : null}
            onClick={() => onSelect(i)}
            title={relative}
            data-active={isActive}
            className="klide-tab"
            style={{
              display: "flex",
              alignItems: "center",
              height: isActive ? 32 : 26,
              marginBottom: isActive ? 0 : 4,
              padding: "0 14px",
              gap: 8,
              position: "relative",
              background: isActive ? "var(--bg)" : "transparent",
              borderTop: isActive
                ? "1px solid color-mix(in srgb, var(--border) 65%, transparent)"
                : "1px solid transparent",
              borderLeft: isActive
                ? "1px solid color-mix(in srgb, var(--border) 65%, transparent)"
                : "1px solid transparent",
              borderRight: isActive
                ? "1px solid color-mix(in srgb, var(--border) 65%, transparent)"
                : "1px solid transparent",
              borderRadius: isActive ? "10px 10px 0 0" : "8px",
              color: isActive ? "var(--fg-strong)" : "var(--fg-subtle)",
              fontSize: 13,
              fontWeight: isActive ? 500 : 400,
              cursor: "pointer",
              minWidth: 0,
              maxWidth: 240,
              flexShrink: 0,
              transition:
                "background var(--motion-slow) var(--ease-soft), color var(--motion-slow) var(--ease-soft)",
            }}
            onMouseEnter={(e) => {
              if (!isActive) {
                e.currentTarget.style.color = "var(--fg-strong)";
                e.currentTarget.style.background =
                  "color-mix(in srgb, var(--bg-hover) 45%, transparent)";
              }
            }}
            onMouseLeave={(e) => {
              if (!isActive) {
                e.currentTarget.style.color = "var(--fg-subtle)";
                e.currentTarget.style.background = "transparent";
              }
            }}
          >
            <span
              style={{
                flex: "0 1 auto",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                minWidth: 0,
              }}
            >
              {filename}
            </span>
            {t.externalChanged ? (
              // Conflict takes precedence over the dirty dot: the file changed
              // on disk while open. A hollow warning ring distinguishes it from
              // the filled sage dirty dot — review before saving over it.
              <span
                title="Changed on disk — review before saving"
                aria-label="Changed on disk"
                style={{
                  flexShrink: 0,
                  marginLeft: -1,
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  border: "1.5px solid var(--warning)",
                  boxSizing: "border-box",
                }}
              />
            ) : t.dirty ? (
              <span
                style={{ color: "var(--accent)", flexShrink: 0, marginLeft: -2 }}
              >
                •
              </span>
            ) : null}
            {folder && (
              <span
                style={{
                  flex: "0 1 auto",
                  color: "var(--fg-dim)",
                  fontSize: 11,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  minWidth: 0,
                  maxWidth: 86,
                }}
              >
                {folder}
              </span>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose(i);
              }}
              title="Close"
              aria-label="Close tab"
              style={{
                color: "var(--fg-subtle)",
                width: 18,
                height: 18,
                flexShrink: 0,
                display: "grid",
                placeItems: "center",
                borderRadius: "var(--radius-xs)",
                fontSize: 14,
                lineHeight: 1,
                transition:
                  "background var(--motion-med) var(--ease-out), color var(--motion-med) var(--ease-out), transform var(--motion-fast) var(--ease-out)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = "var(--fg-strong)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
                e.currentTarget.style.color = "var(--fg-subtle)";
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
