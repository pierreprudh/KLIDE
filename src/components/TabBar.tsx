import { Fragment } from "react";
import { AgentMark, FileTypeIcon, isAgentFile } from "./fileMarks";

type Tab = { path: string; dirty: boolean; externalChanged?: boolean };
type Props = {
  tabs: Tab[];
  activeIdx: number;
  onSelect: (i: number) => void;
  onClose: (i: number) => void;
  workspaceRoot: string | null;
  /** True (default) when the strip is the top-most chrome beside the rail,
   *  so its empty run drags the window. A strip inside a pane (free mode's
   *  editor dock) passes false: grabbing it must not move the window. */
  dragsWindow?: boolean;
};

// One desktop-style strip for every editor: its own shade (--tab-strip-bg),
// full-height tabs split by short hairlines, and the active tab cut out of it
// in the editor's colour (--editor-bg), flared into the strip at its bottom
// corners (.klide-tab-raised), so tab and code read as one surface.

function displayPath(path: string, workspaceRoot: string | null): string {
  if (workspaceRoot && path.startsWith(`${workspaceRoot}/`)) {
    return path.slice(workspaceRoot.length + 1);
  }
  return path;
}

export function TabBar({ tabs, activeIdx, onSelect, onClose, workspaceRoot, dragsWindow = true }: Props) {
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
      // Like a Mac toolbar, the strip's empty run drags the window; tabs are
      // their own event targets and keep their clicks.
      data-tauri-drag-region={dragsWindow ? true : undefined}
      style={{
        position: "relative",
        height: "var(--size-tab-strip)",
        background: "var(--tab-strip-bg)",
        display: "flex",
        alignItems: "flex-end",
        overflowX: "auto",
        flexShrink: 0,
        padding: "0 8px",
      }}
    >
      {tabs.map((t, i) => {
        const isActive = i === activeIdx;
        const relative = displayPath(t.path, workspaceRoot);
        const filename = relative.split("/").pop() ?? relative;
        const isAgent = isAgentFile(t.path);
        const folder = relative.includes("/")
          ? relative.split("/").slice(0, -1).join("/")
          : "";
        // A short hairline between two resting tabs; none beside the active
        // tab, whose own shape already separates it.
        const separated = i > 0 && !isActive && i - 1 !== activeIdx;
        return (
          <Fragment key={t.path}>
          {separated && (
            <span
              aria-hidden="true"
              style={{ width: 1, height: 16, marginBottom: 8, flexShrink: 0, background: "var(--border)" }}
            />
          )}
          <div
            onClick={() => onSelect(i)}
            title={relative}
            data-active={isActive}
            className="klide-tab klide-tab-raised"
            style={{
              display: "flex",
              alignItems: "center",
              height: 32,
              padding: crowded ? "0 10px 0 12px" : "0 10px 0 14px",
              zIndex: isActive ? 1 : undefined,
              gap: 8,
              position: "relative",
              // The active tab is the editor's own surface with no outline —
              // the strip's shade around it draws the shape.
              background: isActive ? "var(--editor-bg)" : "transparent",
              border: "1px solid transparent",
              borderRadius: "8px 8px 0 0",
              color: isActive ? "var(--fg-strong)" : "var(--fg-subtle)",
              fontSize: 13,
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
          </Fragment>
        );
      })}
    </div>
  );
}
