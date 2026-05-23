type Props = { path: string | null; language: string | null };

export function StatusBar({ path, language }: Props) {
  const filename = path?.split("/").pop() ?? null;
  return (
    <footer
      style={{
        height: "var(--size-status-bar)",
        background: "var(--bg-elevated)",
        borderTop: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        padding: "0 10px",
        gap: 14,
        fontSize: 11,
        color: "var(--fg-muted)",
      }}
    >
      <span>{filename ?? "KIDE"}</span>
      {language && <span>{language}</span>}
      <span style={{ marginLeft: "auto" }}>UTF-8</span>
    </footer>
  );
}
