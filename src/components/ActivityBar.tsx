import { useFlipIndicator } from "../hooks/useFlipIndicator";

type View = "explorer" | "git" | "memory" | "skills" | "ai" | "runs" | "settings" | "profile";
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

function MemoryIcon() {
  // Small notebook with a bookmark ribbon — the "Memory" activity bar
  // item, which opens the centered MemoryModal (session handoff notes
  // in .klide/memory/).
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
      <path d="M5 3.5h11.5a1 1 0 0 1 1 1V20l-3-1.5L11.5 20l-3-1.5L5 20V3.5z" />
      <path d="M8 8h6" />
      <path d="M8 12h6" />
      <path d="M8 16h4" />
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

function ProfileIcon() {
  // Person silhouette with a small status dot bottom-right — the
  // "you, on this machine" entry in the bottom zone.
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="9" r="3.6" />
      <path d="M5 20a7 7 0 0 1 14 0" />
      <circle cx="18.5" cy="17.5" r="1.6" fill="var(--success)" stroke="none" />
    </svg>
  );
}

export function ActivityBar({ active, onToggle }: Props) {
  // Top zone — in-workbench / full-window tools. The FLIP bar rides
  // between them when one is active.
  const toolItems: { id: View; label: string; Icon: () => React.JSX.Element }[] = [
    { id: "explorer", label: "Explorer", Icon: FolderIcon },
    { id: "git", label: "Git", Icon: GitIcon },
    { id: "memory", label: "Memory", Icon: MemoryIcon },
    { id: "skills", label: "Skills", Icon: SkillsIcon },
    { id: "ai", label: "AI", Icon: SparkIcon },
    { id: "runs", label: "Mission Control", Icon: MissionIcon },
  ];

  // Bottom zone — app-level destinations. The active state here is a
  // simple background tint (no FLIP bar), so it reads as "open this
  // thing" rather than "switch to this tool".
  const destinationItems: { id: View; label: string; Icon: () => React.JSX.Element }[] = [
    { id: "settings", label: "Settings", Icon: SettingsIcon },
    { id: "profile", label: "Profile", Icon: ProfileIcon },
  ];

  // The FLIP bar follows the most-recently-activated tool. The
  // destination zone's active state is a plain `bg-selected` tint.
  const activeTool = toolItems.reduce<View | null>(
    (acc, n) => (active[n.id] ? n.id : acc),
    null,
  );
  const flip = useFlipIndicator(activeTool, { size: 32, active: activeTool !== null });

  return (
    <nav
      aria-label="Activity"
      style={{
        width: "var(--size-activity-bar)",
        background: "var(--bg-elevated)",
        borderRight: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        position: "relative",
      }}
    >
      {/* Top zone */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          padding: "6px 0",
          display: "flex",
          flexDirection: "column",
          alignItems: "stretch",
        }}
      >
        <div
          ref={flip.trackRef}
          data-flip={flip.flip}
          style={{
            position: "relative",
            display: "flex",
            flexDirection: "column",
            alignItems: "stretch",
            gap: 2,
          }}
        >
          <span
            className="klide-flip-indicator klide-activity-bar-indicator"
            style={flip.style}
            aria-hidden="true"
          />
          {toolItems.map(({ id, label, Icon }) => {
            const isActive = active[id];
            return (
              <button
                key={id}
                ref={flip.setItemRef(id)}
                onClick={(e) => onToggle(id, e.metaKey || e.ctrlKey)}
                title={id === "ai" ? label : `${label}  (⌘+click to stack)`}
                aria-label={label}
                aria-pressed={isActive}
                data-active={isActive}
                className="klide-activity-bar-item"
                style={{
                  position: "relative",
                  zIndex: 1,
                  width: 32,
                  height: 32,
                  margin: "0 auto",
                  borderRadius: "var(--radius-md)",
                  display: "grid",
                  placeItems: "center",
                  color: isActive ? "var(--fg-strong)" : "var(--fg-subtle)",
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
        </div>
      </div>

      {/* Hairline divider — a 12px-wide notch that sits centred at the
          bottom of the top zone, with the same 1px border colour as
          the rail's right edge. Quiet, but it reads as a zone break. */}
      <div
        aria-hidden
        style={{
          height: 1,
          margin: "0 auto",
          width: 18,
          background: "var(--border)",
        }}
      />

      {/* Bottom zone — destinations. The active state is a small accent
          dot underneath the icon (macOS-dock style), so it can never be
          confused with the top zone's FLIP bar. The button is 40px
          tall to leave room for the dot. */}
      <div
        style={{
          padding: "8px 0 10px",
          display: "flex",
          flexDirection: "column",
          alignItems: "stretch",
          gap: 2,
        }}
      >
        {destinationItems.map(({ id, label, Icon }) => {
          const isActive = active[id];
          return (
            <button
              key={id}
              onClick={() => onToggle(id)}
              title={label}
              aria-label={label}
              aria-pressed={isActive}
              data-active={isActive}
              className="klide-activity-bar-item klide-activity-bar-destination"
              style={{
                position: "relative",
                width: 32,
                height: 40,
                margin: "0 auto",
                borderRadius: "var(--radius-md)",
                display: "grid",
                placeItems: "center",
                color: isActive ? "var(--fg-strong)" : "var(--fg-subtle)",
                background: "transparent",
              }}
              onMouseEnter={(e) => {
                if (!isActive) e.currentTarget.style.color = "var(--fg-strong)";
              }}
              onMouseLeave={(e) => {
                if (!isActive) e.currentTarget.style.color = "var(--fg-subtle)";
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 18,
                  height: 18,
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <Icon />
              </span>
              <span
                aria-hidden
                data-visible={isActive}
                className="klide-activity-bar-dock-dot"
              />
            </button>
          );
        })}
      </div>
    </nav>
  );
}
