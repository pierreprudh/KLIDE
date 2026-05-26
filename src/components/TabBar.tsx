type Tab = { path: string; dirty: boolean };
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
  if (tabs.length === 0) {
    return null;
  }

  return (
    <div
      className="chrome-enter"
      style={{
        height: "var(--size-tab-strip)",
        background: "color-mix(in srgb, var(--bg-elevated) 72%, transparent)",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        overflowX: "auto",
        backdropFilter: "blur(12px)",
        flexShrink: 0,
        padding: "4px 6px",
        gap: 4,
      }}
    >
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
            onClick={() => onSelect(i)}
            title={relative}
            style={{
              display: "flex",
              alignItems: "center",
              height: 25,
              padding: "0 10px",
              gap: 8,
              position: "relative",
              background: isActive
                ? "color-mix(in srgb, var(--bg) 88%, transparent)"
                : "transparent",
              border: isActive
                ? "1px solid color-mix(in srgb, var(--border-strong) 70%, transparent)"
                : "1px solid transparent",
              borderRadius: "999px",
              color: isActive ? "var(--fg-strong)" : "var(--fg-subtle)",
              fontSize: 13,
              fontWeight: isActive ? 500 : 400,
              cursor: "pointer",
              minWidth: 0,
              maxWidth: 220,
              flexShrink: 0,
              transition:
                "background var(--motion-med) var(--ease-out), color var(--motion-med) var(--ease-out)",
            }}
            onMouseEnter={(e) => {
              if (!isActive) e.currentTarget.style.color = "var(--fg-strong)";
            }}
            onMouseLeave={(e) => {
              if (!isActive) e.currentTarget.style.color = "var(--fg-subtle)";
            }}
          >
            {isActive && (
              <span
                style={{
                  position: "absolute",
                  top: 0,
                  left: 12,
                  right: 12,
                  height: 2,
                  borderRadius: 99,
                  background: "var(--accent)",
                }}
              />
            )}
            <span
              style={{
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                minWidth: 0,
              }}
            >
              {filename}
              {t.dirty && (
                <span style={{ color: "var(--accent)", marginLeft: 6 }}>•</span>
              )}
            </span>
            {folder && (
              <span
                style={{
                  color: "var(--fg-dim)",
                  fontSize: 11,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
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
