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
          padding: "0 12px",
          color: "var(--fg-dim)",
          fontSize: 12,
        }}
      >
        (no files open)
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
              padding: "0 10px",
              gap: 8,
              borderRight: "1px solid var(--border)",
              background: isActive ? "var(--bg)" : "transparent",
              color: isActive ? "var(--fg)" : "var(--fg-muted)",
              fontSize: 12,
              cursor: "pointer",
              minWidth: 0,
              flexShrink: 0,
            }}
          >
            <span style={{ whiteSpace: "nowrap" }}>
              {t.path.split("/").pop()}
              {t.dirty && " •"}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose(i);
              }}
              title="Close"
              aria-label="Close tab"
              style={{
                color: "var(--fg-dim)",
                padding: 2,
                fontSize: 14,
                lineHeight: 1,
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
