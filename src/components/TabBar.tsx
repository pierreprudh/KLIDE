type Tab = { path: string; dirty: boolean };
type Props = {
  tabs: Tab[];
  activeIdx: number;
  onSelect: (i: number) => void;
  onClose: (i: number) => void;
};

export function TabBar({ tabs, activeIdx, onSelect, onClose }: Props) {
  if (tabs.length === 0) {
    return (
      <div
        style={{
          height: "var(--size-tab-strip)",
          background: "var(--bg-elevated)",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          padding: "0 14px",
          color: "var(--fg-subtle)",
          fontSize: 12,
        }}
      >
        No files open
      </div>
    );
  }

  return (
    <div
      style={{
        height: "var(--size-tab-strip)",
        background: "var(--bg-elevated)",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        alignItems: "stretch",
        overflowX: "auto",
      }}
    >
      {tabs.map((t, i) => {
        const isActive = i === activeIdx;
        return (
          <div
            key={t.path}
            onClick={() => onSelect(i)}
            style={{
              display: "flex",
              alignItems: "center",
              padding: "0 12px",
              gap: 8,
              position: "relative",
              background: isActive ? "var(--bg)" : "transparent",
              color: isActive ? "var(--fg-strong)" : "var(--fg-subtle)",
              fontSize: 13,
              fontWeight: isActive ? 500 : 400,
              cursor: "pointer",
              minWidth: 0,
              flexShrink: 0,
              transition: "color 120ms ease",
              borderRight: "1px solid var(--border)",
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
                  left: 0,
                  right: 0,
                  height: 1,
                  background: "var(--accent)",
                }}
              />
            )}
            <span style={{ whiteSpace: "nowrap" }}>
              {t.path.split("/").pop()}
              {t.dirty && (
                <span style={{ color: "var(--accent)", marginLeft: 6 }}>•</span>
              )}
            </span>
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
                borderRadius: 3,
                fontSize: 14,
                lineHeight: 1,
                transition: "background 120ms ease, color 120ms ease",
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
