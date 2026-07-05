import { useEffect, useRef } from "react";
import { Z } from "../zLayers";
import { SHORTCUTS, SHORTCUT_GROUPS } from "../shortcuts";
import { Kbd } from "./Kbd";

// The keyboard-shortcuts cheatsheet — a centered, read-only reference so
// keyboard-only users can discover what's bound. Opened with ⌘/ or "?", closed
// with Escape. Content comes from the shortcut registry (src/shortcuts.ts);
// the handlers themselves live in App.tsx — keep registry and handlers in
// sync when a binding changes.

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
          {SHORTCUT_GROUPS.map((group) => (
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
              {group.ids.map((id) => (
                <div
                  key={id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    minHeight: 28,
                    fontSize: 12.5,
                    color: "var(--fg)",
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>{SHORTCUTS[id].label}</span>
                  <Kbd keys={SHORTCUTS[id].keys} />
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
