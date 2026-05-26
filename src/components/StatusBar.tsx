type Props = {
  path: string | null;
  language: string | null;
  workspaceRoot: string | null;
  terminalVisible: boolean;
  onToggleTerminal: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
};

function TerminalIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 8l3 3-3 3" />
      <path d="M12 16h6" />
    </svg>
  );
}

function relativePath(path: string | null, workspaceRoot: string | null): string | null {
  if (!path) return null;
  if (workspaceRoot && path.startsWith(`${workspaceRoot}/`)) {
    return path.slice(workspaceRoot.length + 1);
  }
  return path;
}

export function StatusBar({
  path,
  language,
  workspaceRoot,
  terminalVisible,
  onToggleTerminal,
  theme,
  onToggleTheme,
}: Props) {
  const display = relativePath(path, workspaceRoot);
  const filename = path?.split("/").pop() ?? null;
  return (
    <footer
      style={{
        height: "var(--size-status-bar)",
        background: "var(--bg-elevated)",
        borderTop: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        padding: "0 12px",
        gap: 16,
        fontSize: 11,
        color: "var(--fg-subtle)",
        fontFamily: "var(--font-ui)",
      }}
    >
      <span
        title={display ?? undefined}
        style={{
          color: filename ? "var(--fg)" : "var(--fg-subtle)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          maxWidth: "42vw",
        }}
      >
        {display ?? "KIDE"}
      </span>
      {language && <span>{language}</span>}
      {workspaceRoot && <span>{workspaceRoot.split("/").pop()}</span>}
      <button
        onClick={onToggleTheme}
        title={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
        aria-label="Toggle theme"
        aria-pressed={theme === "dark"}
        style={{
          marginLeft: "auto",
          height: 18,
          padding: "0 7px",
          borderRadius: "var(--radius-sm)",
          display: "flex",
          alignItems: "center",
          fontSize: 11,
          color: "var(--fg-subtle)",
          background: "transparent",
          transition:
            "background var(--motion-med) var(--ease-out), color var(--motion-med) var(--ease-out)",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        Theme: {theme === "light" ? "Light" : "Dark"}
      </button>
      <button
        onClick={onToggleTerminal}
        title="Toggle terminal (⌃`)"
        aria-label="Toggle terminal"
        aria-pressed={terminalVisible}
        style={{
          height: 18,
          padding: "0 7px",
          borderRadius: "var(--radius-sm)",
          display: "flex",
          alignItems: "center",
          gap: 5,
          fontSize: 11,
          color: terminalVisible ? "var(--accent)" : "var(--fg-subtle)",
          background: terminalVisible ? "var(--accent-soft)" : "transparent",
          transition:
            "background var(--motion-med) var(--ease-out), color var(--motion-med) var(--ease-out)",
        }}
        onMouseEnter={(e) => {
          if (!terminalVisible) e.currentTarget.style.background = "var(--bg-hover)";
        }}
        onMouseLeave={(e) => {
          if (!terminalVisible) e.currentTarget.style.background = "transparent";
        }}
      >
        <TerminalIcon />
        Terminal
      </button>
      <span>UTF-8</span>
      <span>LF</span>
    </footer>
  );
}
