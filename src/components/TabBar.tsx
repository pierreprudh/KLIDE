import { useLayoutEffect, useRef, useState } from "react";
import { useFlipIndicator } from "../hooks/useFlipIndicator";
import { AgentMark, FileTypeIcon, isAgentFile } from "./fileMarks";

type Tab = { path: string; dirty: boolean; externalChanged?: boolean };
type Props = {
  tabs: Tab[];
  activeIdx: number;
  onSelect: (i: number) => void;
  onClose: (i: number) => void;
  workspaceRoot: string | null;
  /** "raised" (default) — the desktop-style tab card that merges into the
   *  editor surface below; drawn for the full-bleed editor. "flat" — the
   *  docked pane's soft-segment strip: inset row, the active tab carries a
   *  quiet rounded neutral fill (the hover token, not a saturated pill), no
   *  underline. */
  variant?: "raised" | "flat";
};

function displayPath(path: string, workspaceRoot: string | null): string {
  if (workspaceRoot && path.startsWith(`${workspaceRoot}/`)) {
    return path.slice(workspaceRoot.length + 1);
  }
  return path;
}

export function TabBar({ tabs, activeIdx, onSelect, onClose, workspaceRoot, variant = "raised" }: Props) {
  const flat = variant === "flat";
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

  // Past a handful of tabs, full-width tabs with folder hints stop scanning
  // well and shove the strip into a long horizontal scroll. Crowded tabs
  // compress instead: tighter padding, no folder hint, and they may shrink
  // down to a floor before the strip finally scrolls.
  const crowded = tabs.length >= 5;

  return (
    <div
      className="chrome-enter"
      style={{
        position: "relative",
        height: "var(--size-tab-strip)",
        background: flat
          ? "transparent"
          : "color-mix(in srgb, var(--bg-elevated) 72%, transparent)",
        display: "flex",
        alignItems: flat ? "center" : "flex-end",
        overflowX: "auto",
        backdropFilter: flat ? undefined : "blur(12px)",
        borderBottom: flat ? "1px solid var(--border)" : undefined,
        flexShrink: 0,
        padding: flat ? "0 8px" : "0 10px",
        gap: flat ? 4 : 2,
      }}
    >
      {!flat && (
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
      )}

      {/* No underline indicator in the flat variant — the active fill is the
          only marker (two systems was what felt strange). */}
      {tabs.map((t, i) => {
        const isActive = i === activeIdx;
        const relative = displayPath(t.path, workspaceRoot);
        const filename = relative.split("/").pop() ?? relative;
        const isAgent = isAgentFile(t.path);
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
              height: flat ? 24 : isActive ? 32 : 26,
              marginBottom: flat ? 0 : isActive ? 0 : 4,
              padding: flat ? (crowded ? "0 8px" : "0 10px") : crowded ? "0 10px" : "0 14px",
              gap: 8,
              position: "relative",
              // Flat: the active tab carries a quiet neutral fill — the hover
              // token, not a saturated pill — and that fill is the only
              // marker. Raised keeps the card that merges into the editor.
              background: isActive ? (flat ? "var(--bg-hover)" : "var(--bg)") : "transparent",
              borderTop: !flat && isActive
                ? "1px solid color-mix(in srgb, var(--border) 65%, transparent)"
                : "1px solid transparent",
              borderLeft: !flat && isActive
                ? "1px solid color-mix(in srgb, var(--border) 65%, transparent)"
                : "1px solid transparent",
              borderRight: !flat && isActive
                ? "1px solid color-mix(in srgb, var(--border) 65%, transparent)"
                : "1px solid transparent",
              borderRadius: flat ? "var(--radius-sm)" : isActive ? "8px 8px 0 0" : "8px",
              color: isActive ? "var(--fg-strong)" : "var(--fg-subtle)",
              fontSize: flat ? 12.5 : 13,
              fontWeight: isActive ? 500 : 400,
              cursor: "pointer",
              minWidth: crowded ? 72 : 0,
              maxWidth: crowded ? 170 : 240,
              flexShrink: crowded ? 1 : 0,
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
            {/* Real file-type icon — the Explorer's set, at tab scale. Agent
                context files keep their accent star instead: spotting the
                file that steers the agent beats knowing it's markdown. */}
            <span
              aria-hidden="true"
              style={{
                flexShrink: 0,
                display: "inline-flex",
                marginRight: -2,
                color: isAgent ? "var(--accent)" : undefined,
              }}
            >
              {isAgent ? <AgentMark size={11} /> : <FileTypeIcon name={filename} size={13} />}
            </span>
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
              // on disk while open. Same glyph as the dirty indicator, but in
              // warning color — review before saving over it.
              <span
                title="Changed on disk — review before saving"
                aria-label="Changed on disk"
                style={{ color: "var(--warning)", flexShrink: 0, marginLeft: -2 }}
              >
                •
              </span>
            ) : t.dirty ? (
              <span
                style={{ color: "var(--accent)", flexShrink: 0, marginLeft: -2 }}
              >
                •
              </span>
            ) : null}
            {folder && !crowded && (
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
              className="klide-tab-close"
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
                  "background var(--motion-med) var(--ease-out), color var(--motion-med) var(--ease-out), transform var(--motion-fast) var(--ease-out), opacity var(--motion-fast) var(--ease-out)",
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
