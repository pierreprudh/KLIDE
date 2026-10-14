import type { CSSProperties, ReactNode } from "react";

export const MODEL_FILTER_STYLE: CSSProperties = {
  width: "100%", height: 26, padding: "0 8px", border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)", background: "var(--bg)", color: "var(--fg-strong)",
  font: "inherit", fontSize: 11.5, outline: "none",
  transition: "border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)",
};
export const MODEL_ROW_STYLE: CSSProperties = {
  display: "block", width: "100%", padding: "7px 9px", border: "none",
  borderRadius: "var(--radius-sm)", background: "transparent", color: "var(--fg-strong)",
  textAlign: "left", cursor: "pointer", font: "inherit", fontSize: 12, fontWeight: 500,
  transition: "background var(--motion-fast) var(--ease-out)",
};
export function ModelPickerHeader({ icon, title, caption }: { icon?: ReactNode; title: string; caption: string }) {
  return <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 9, padding: "10px 12px 9px",
    borderBottom: "1px solid var(--panel-border)", background: "color-mix(in srgb, var(--panel-highlight) 30%, transparent)" }}>
    {icon != null && <span style={{ display: "grid", placeItems: "center", width: 26, height: 26, borderRadius: 8,
      background: "var(--bg-elevated)", border: "1px solid var(--border)", flexShrink: 0 }}>{icon}</span>}
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--fg-strong)", letterSpacing: "-0.005em" }}>{title}</div>
      <div style={{ fontSize: 10, color: "var(--fg-dim)", marginTop: 1 }}>{caption}</div>
    </div>
  </div>;
}

export function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2.6l2.9 5.9 6.5.95-4.7 4.6 1.1 6.45L12 18.9 6.2 21.05l1.1-6.45-4.7-4.6 6.5-.95z" />
    </svg>
  );
}
