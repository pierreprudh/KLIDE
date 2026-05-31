import { getThemeMeta, type ThemeId } from "../theme";
import { LayoutBento } from "./LayoutBento";
import type { GridLayout } from "../gridLayouts";
import type { GitStatus } from "./GitPanel";

type Props = {
  path: string | null;
  language: string | null;
  workspaceRoot: string | null;
  fileNotice: string | null;
  gitStatus: GitStatus | null;
  terminalVisible: boolean;
  onToggleTerminal: () => void;
  gridLayouts: GridLayout[];
  activeGridId: string | null;
  onApplyGrid: (id: string) => void;
  onExitGrid: () => void;
  onOpenGrid: () => void;
  theme: ThemeId;
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

function BranchIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="6" cy="5" r="2.3" />
      <circle cx="6" cy="19" r="2.3" />
      <circle cx="18" cy="12" r="2.3" />
      <path d="M6 7.3v9.4" />
      <path d="M8.1 6.2A8.3 8.3 0 0 1 15.8 10" />
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
  fileNotice,
  gitStatus,
  terminalVisible,
  onToggleTerminal,
  gridLayouts,
  activeGridId,
  onApplyGrid,
  onExitGrid,
  onOpenGrid,
  theme,
  onToggleTheme,
}: Props) {
  const display = relativePath(path, workspaceRoot);
  const filename = path?.split("/").pop() ?? null;
  const themeMeta = getThemeMeta(theme);
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
        {display ?? "Klide"}
      </span>
      {language && <span>{language}</span>}
      {workspaceRoot && <span>{workspaceRoot.split("/").pop()}</span>}
      {gitStatus && (
        <span
          title={`${gitStatus.branch} · ${gitStatus.files.length} ${
            gitStatus.files.length === 1 ? "change" : "changes"
          }`}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            color: gitStatus.files.length > 0 ? "var(--accent)" : "var(--fg-subtle)",
            minWidth: 0,
            whiteSpace: "nowrap",
          }}
        >
          <BranchIcon />
          <span
            style={{
              maxWidth: 140,
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {gitStatus.branch}
          </span>
          <span>
            {gitStatus.files.length}
          </span>
        </span>
      )}
      {fileNotice && (
        <span
          title={fileNotice}
          style={{
            color: fileNotice.includes("changed") || fileNotice.includes("unavailable")
              ? "var(--code-number)"
              : "var(--fg-subtle)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: "22vw",
          }}
        >
          {fileNotice}
        </span>
      )}
      <button
        onClick={onToggleTheme}
        title="Cycle theme"
        aria-label="Toggle theme"
        aria-pressed={themeMeta.isDark}
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
        Theme: {themeMeta.name}
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
      <LayoutBento
        gridLayouts={gridLayouts}
        activeGridId={activeGridId}
        onApplyGrid={onApplyGrid}
        onExitGrid={onExitGrid}
        onOpenGrid={onOpenGrid}
      />
      <span>UTF-8</span>
      <span>LF</span>
    </footer>
  );
}
