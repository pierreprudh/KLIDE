import type { ReactNode } from "react";

type Props = {
  visible: boolean;
  width: number;
  theme: "light" | "dark";
  onThemeChange: (theme: "light" | "dark") => void;
};

function Row({
  label,
  value,
  children,
}: {
  label: string;
  value?: string;
  children?: ReactNode;
}) {
  return (
    <div
      style={{
        padding: "10px 0",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <span style={{ color: "var(--fg-strong)" }}>{label}</span>
      {children ?? <span style={{ color: "var(--fg-subtle)" }}>{value}</span>}
    </div>
  );
}

export function SettingsPanel({ visible, width, theme, onThemeChange }: Props) {
  return (
    <aside
      className="floating-panel"
      style={{
        width,
        margin: "4px 0 4px 4px",
        display: visible ? "flex" : "none",
        flexDirection: "column",
        flexShrink: 0,
        overflow: "hidden",
      }}
    >
      <header
        style={{
          padding: "8px 12px",
          fontSize: 11,
          color: "var(--fg-subtle)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          fontWeight: 500,
          borderBottom: "1px solid var(--border)",
        }}
      >
        Settings
      </header>
      <div style={{ padding: "8px 12px", fontSize: 13, overflow: "auto" }}>
        <section style={{ marginBottom: 18 }}>
          <div
            style={{
              color: "var(--fg-subtle)",
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              marginBottom: 4,
            }}
          >
            Appearance
          </div>
          <Row label="Theme">
            <div
              style={{
                display: "flex",
                padding: 2,
                background: "var(--bg-hover)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
              }}
            >
              {(["light", "dark"] as const).map((mode) => {
                const active = theme === mode;
                return (
                  <button
                    key={mode}
                    onClick={() => onThemeChange(mode)}
                    style={{
                      height: 22,
                      padding: "0 9px",
                      color: active ? "var(--fg-strong)" : "var(--fg-subtle)",
                      background: active ? "var(--bg)" : "transparent",
                      border: "none",
                      textTransform: "capitalize",
                    }}
                  >
                    {mode}
                  </button>
                );
              })}
            </div>
          </Row>
          <Row label="App font" value="Atkinson Hyperlegible" />
          <Row label="Code font" value="Monaspace" />
        </section>

        <section style={{ marginBottom: 18 }}>
          <div
            style={{
              color: "var(--fg-subtle)",
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              marginBottom: 4,
            }}
          >
            AI Providers
          </div>
          <Row label="Local" value="Ollama" />
          <Row label="Coming later" value="Cloud + vLLM" />
        </section>

        <section>
          <div
            style={{
              color: "var(--fg-subtle)",
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              marginBottom: 4,
            }}
          >
            Editor
          </div>
          <Row label="Terminal" value="Built-in PTY" />
          <Row label="File edits" value="Diff approval" />
        </section>
      </div>
    </aside>
  );
}
