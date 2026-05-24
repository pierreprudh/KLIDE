type View = "explorer" | "ai";
type Props = { active: View; onChange: (v: View) => void };

function FolderIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 7.5C3 6.4 3.9 5.5 5 5.5h3.5l2 2H19c1.1 0 2 .9 2 2v7c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2v-9z" />
    </svg>
  );
}

function SparkIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3.5l1.6 4.4L18 9.5l-4.4 1.6L12 15.5l-1.6-4.4L6 9.5l4.4-1.6L12 3.5z" />
      <path d="M18 16l.7 1.8L20.5 18.5l-1.8.7L18 21l-.7-1.8L15.5 18.5l1.8-.7L18 16z" />
    </svg>
  );
}

export function ActivityBar({ active, onChange }: Props) {
  const items = [
    { id: "explorer" as const, label: "Files", Icon: FolderIcon },
    { id: "ai" as const, label: "AI", Icon: SparkIcon },
  ];

  return (
    <nav
      style={{
        width: "var(--size-activity-bar)",
        background: "var(--bg-elevated)",
        borderRight: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        paddingTop: 6,
        gap: 2,
      }}
    >
      {items.map(({ id, label, Icon }) => {
        const isActive = active === id;
        return (
          <button
            key={id}
            onClick={() => onChange(id)}
            title={label}
            aria-label={label}
            aria-pressed={isActive}
            style={{
              width: 32,
              height: 32,
              borderRadius: 6,
              display: "grid",
              placeItems: "center",
              color: isActive ? "var(--fg-strong)" : "var(--fg-subtle)",
              background: isActive ? "var(--bg-selected)" : "transparent",
              transition: "background 120ms ease, color 120ms ease",
            }}
            onMouseEnter={(e) => {
              if (!isActive) e.currentTarget.style.color = "var(--fg-strong)";
            }}
            onMouseLeave={(e) => {
              if (!isActive) e.currentTarget.style.color = "var(--fg-subtle)";
            }}
          >
            <Icon />
          </button>
        );
      })}
    </nav>
  );
}
