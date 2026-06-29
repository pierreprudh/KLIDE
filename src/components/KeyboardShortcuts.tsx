import { useEffect, useRef } from "react";
import { Z } from "../zLayers";

// The keyboard-shortcuts cheatsheet — a centered, read-only reference so
// keyboard-only users can discover what's bound. Opened with ⌘/ or "?", closed
// with Escape. Static content mirrors the bindings wired in App.tsx; keep the
// two in sync when a shortcut changes.

type Row = { keys: string[]; label: string };
type Group = { title: string; rows: Row[] };

const GROUPS: Group[] = [
  {
    title: "Move around",
    rows: [
      { keys: ["⌃", "Tab"], label: "Focus next region (Explorer → Editor → Terminal → AI) · or F6" },
      { keys: ["⌃", "⇧", "Tab"], label: "Focus previous region · or ⇧F6" },
      { keys: ["⌘", "P"], label: "Go to file" },
      { keys: ["⌘", "⇧", "P"], label: "Command palette" },
      { keys: ["⌘", "⇧", "F"], label: "Find in files" },
      { keys: ["⌘", "⇧", "G"], label: "Git review" },
      { keys: ["⌘", "N"], label: "Back to the editor" },
      { keys: ["⌘", "Tab"], label: "Next tab" },
      { keys: ["⌘", "⇧", "Tab"], label: "Previous tab" },
    ],
  },
  {
    title: "Files & editing",
    rows: [
      { keys: ["⌘", "S"], label: "Save file" },
      { keys: ["⌘", "O"], label: "Open folder" },
      { keys: ["⌘", "W"], label: "Close tab" },
      { keys: ["⌘", "F"], label: "Find in file (editor)" },
    ],
  },
  {
    title: "Panels & views",
    rows: [
      { keys: ["⌘", "`"], label: "Toggle terminal" },
      { keys: ["⌘", ","], label: "Settings" },
      { keys: ["⌘", "."], label: "Profile" },
      { keys: ["⌘", "/"], label: "This cheatsheet" },
    ],
  },
  {
    title: "AI panel",
    rows: [
      { keys: ["↵"], label: "Send message" },
      { keys: ["⇧", "↵"], label: "New line" },
      { keys: ["Tab"], label: "Toggle mode (Chat / Plan / Goal)" },
      { keys: ["Esc"], label: "Stop a running turn" },
    ],
  },
];

function Keycap({ children }: { children: string }) {
  return <kbd className="klide-kbd" style={{ marginLeft: 0 }}>{children}</kbd>;
}

export function KeyboardShortcuts({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      onClick={onClose}
      className="skills-tab-in"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: Z.modal,
        display: "grid",
        placeItems: "center",
        background: "var(--modal-scrim)",
        backdropFilter: "blur(3px)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(680px, 92vw)",
          maxHeight: "84vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg)",
          border: "1px solid var(--border-strong)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--panel-shadow)",
          overflow: "hidden",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 18px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--fg-strong)" }}>
            Keyboard shortcuts
          </span>
          <button
            ref={closeRef}
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 24,
              height: 24,
              display: "grid",
              placeItems: "center",
              borderRadius: "var(--radius-sm)",
              color: "var(--fg-subtle)",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--fg-strong)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--fg-subtle)"; }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div
          style={{
            overflowY: "auto",
            padding: "8px 18px 18px",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: "4px 32px",
            alignContent: "start",
          }}
        >
          {GROUPS.map((group) => (
            <section key={group.title} style={{ marginTop: 14, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 10.5,
                  fontWeight: 600,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "var(--fg-subtle)",
                  marginBottom: 6,
                }}
              >
                {group.title}
              </div>
              {group.rows.map((row) => (
                <div
                  key={row.label}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    minHeight: 28,
                    fontSize: 12.5,
                    color: "var(--fg)",
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>{row.label}</span>
                  <span style={{ flexShrink: 0, display: "flex", gap: 3 }}>
                    {row.keys.map((k, i) => (
                      <Keycap key={i}>{k}</Keycap>
                    ))}
                  </span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
