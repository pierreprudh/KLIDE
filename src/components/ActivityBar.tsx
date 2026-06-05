type View = "explorer" | "git" | "graph" | "skills" | "ai" | "runs" | "settings";
type Props = { active: Record<View, boolean>; onToggle: (v: View, meta?: boolean) => void };

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

function GitIcon() {
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
      <circle cx="6" cy="5" r="2.4" />
      <circle cx="6" cy="19" r="2.4" />
      <circle cx="18" cy="12" r="2.4" />
      <path d="M6 7.4v9.2" />
      <path d="M8.1 6.2A8.2 8.2 0 0 1 15.7 10" />
    </svg>
  );
}

function GraphIcon() {
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
      <circle cx="6" cy="7" r="2.3" />
      <circle cx="18" cy="6" r="2.3" />
      <circle cx="8" cy="18" r="2.3" />
      <circle cx="18" cy="17" r="2.3" />
      <path d="M8.2 7h7.6" />
      <path d="M7 9.1l1 6.6" />
      <path d="M10.2 17.8h5.6" />
      <path d="M17.8 8.3v6.4" />
    </svg>
  );
}

function SkillsIcon() {
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
      <path d="M15 4l1.1 3L19 8l-2.9 1L15 12l-1.1-3L11 8l2.9-1L15 4z" />
      <path d="M6.5 12l.8 2.2L9.5 15l-2.2.8L6.5 18l-.8-2.2L3.5 15l2.2-.8L6.5 12z" />
    </svg>
  );
}

function MissionIcon() {
  // Central agent + satellites on an orbit — "many runs, one control panel".
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
      <circle cx="12" cy="12" r="7.5" opacity="0.5" />
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
      <circle cx="19.5" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="7" cy="5" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

function SettingsIcon() {
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
      <path d="M4 6h10" />
      <path d="M18 6h2" />
      <path d="M16 4v4" />
      <path d="M4 12h3" />
      <path d="M11 12h9" />
      <path d="M9 10v4" />
      <path d="M4 18h11" />
      <path d="M19 18h1" />
      <path d="M17 16v4" />
    </svg>
  );
}

export function ActivityBar({ active, onToggle }: Props) {
  const items = [
    { id: "explorer" as const, label: "Files", Icon: FolderIcon },
    { id: "git" as const, label: "Git", Icon: GitIcon },
    { id: "graph" as const, label: "Project Graph", Icon: GraphIcon },
    { id: "skills" as const, label: "Skills", Icon: SkillsIcon },
    { id: "ai" as const, label: "AI", Icon: SparkIcon },
    { id: "runs" as const, label: "Mission Control", Icon: MissionIcon },
    { id: "settings" as const, label: "Settings", Icon: SettingsIcon },
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
        const isActive = active[id];
        return (
          <button
            key={id}
            onClick={(e) => onToggle(id, e.metaKey || e.ctrlKey)}
            title={id === "ai" ? label : `${label}  (⌘+click to stack)`}
            aria-label={label}
            aria-pressed={isActive}
            style={{
              width: 32,
              height: 32,
              borderRadius: "var(--radius-md)",
              display: "grid",
              placeItems: "center",
              color: isActive ? "var(--fg-strong)" : "var(--fg-subtle)",
              background: isActive ? "var(--bg-selected)" : "transparent",
              transition:
                "background var(--motion-med) var(--ease-out), color var(--motion-med) var(--ease-out), transform var(--motion-fast) var(--ease-out)",
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
