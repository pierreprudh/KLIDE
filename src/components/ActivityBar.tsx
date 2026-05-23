type View = "explorer" | "ai";
type Props = { active: View; onChange: (v: View) => void };

export function ActivityBar({ active, onChange }: Props) {
  const items: { id: View; label: string }[] = [
    { id: "explorer", label: "Files" },
    { id: "ai", label: "AI" },
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
        paddingTop: 8,
        gap: 4,
      }}
    >
      {items.map((it) => (
        <button
          key={it.id}
          onClick={() => onChange(it.id)}
          title={it.label}
          style={{
            width: 36,
            height: 36,
            borderRadius: 6,
            fontSize: 10,
            color: active === it.id ? "var(--fg)" : "var(--fg-muted)",
            background: active === it.id ? "var(--bg-hover)" : "transparent",
          }}
        >
          {it.label[0]}
        </button>
      ))}
    </nav>
  );
}
