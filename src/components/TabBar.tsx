import { Fragment } from "react";
import { AgentMark, FileTypeIcon, isAgentFile } from "./fileMarks";

type Tab = { path: string; dirty: boolean; externalChanged?: boolean };
type Props = {
  tabs: Tab[];
  activeIdx: number;
  onSelect: (i: number) => void;
  onClose: (i: number) => void;
  workspaceRoot: string | null;
  /** "raised" (default) — the desktop-style strip: its own shade, full-height
   *  tabs split by short hairlines, and the active tab cut out of it in the
   *  editor's colour (--editor-bg) so tab and code are one surface; drawn for
   *  the full-bleed editor.
   *  "flat" — the
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
      // The raised strip is the top-most chrome beside the rail, so its empty
      // run is the window's drag handle — like a Mac toolbar. Tabs are their
      // own event targets and keep their clicks. The flat strip belongs to a
      // pane, not the window: grabbing it must not move the window.
      data-tauri-drag-region={flat ? undefined : true}
      style={{
        position: "relative",
        height: "var(--size-tab-strip)",
        // Raised: the strip is its own shade, one step off the editor's
        // surface (darker on light themes, lighter on dark).
        background: flat
          ? "transparent"
          : "color-mix(in srgb, var(--fg-strong) 5%, var(--editor-bg))",
        display: "flex",
        alignItems: flat ? "center" : "flex-end",
        overflowX: "auto",
        flexShrink: 0,
        padding: flat ? "0 8px" : "0 8px",
        gap: flat ? 4 : 0,
      }}
    >
      {/* One marker per variant: the active card (raised) or the active fill
          (flat) — never an underline on top of either. */}
      {tabs.map((t, i) => {
        const isActive = i === activeIdx;
        const relative = displayPath(t.path, workspaceRoot);
        const filename = relative.split("/").pop() ?? relative;
        const isAgent = isAgentFile(t.path);
        const folder = relative.includes("/")
          ? relative.split("/").slice(0, -1).join("/")
          : "";
        // Raised: a short hairline between two resting tabs; none beside the
        // active card, whose own edges already separate it.
        const separated = !flat && i > 0 && !isActive && i - 1 !== activeIdx;
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
            className={flat ? "klide-tab" : "klide-tab klide-tab-raised"}
            style={{
              display: "flex",
              alignItems: "center",
              height: flat ? 24 : 32,
              padding: flat ? (crowded ? "0 8px" : "0 10px") : crowded ? "0 10px 0 12px" : "0 10px 0 14px",
              zIndex: isActive ? 1 : undefined,
              gap: 8,
              position: "relative",
              // Flat: the active tab carries a quiet neutral fill — the hover
              // token, not a saturated pill — and that fill is the only
              // marker. Raised: the active tab is the editor's own surface,
              // no outline — the strip's shade around it draws the shape, and
              // .klide-tab-raised's flares curve the strip into it.
              background: isActive ? (flat ? "var(--bg-hover)" : "var(--editor-bg)") : "transparent",
              border: "1px solid transparent",
              borderRadius: flat ? "var(--radius-sm)" : "8px 8px 0 0",
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
          </Fragment>
        );
      })}
    </div>
  );
}
