import { getThemeMeta, type ThemeId } from "../theme";
import { LayoutBento } from "./LayoutBento";
import { Tooltip } from "./Tooltip";
import type { GridLayout } from "../gridLayouts";
import type { GitStatus } from "../gitTypes";

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
  anchoredLayout: boolean;
  onApplyGrid: (id: string) => void;
  onExitGrid: () => void;
  onSetAnchored: (anchored: boolean) => void;
  onOpenGrid: () => void;
  theme: ThemeId;
  autoTheme: boolean;
  onToggleTheme: () => void;
  onResetLayout: () => void;
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
  anchoredLayout,
  onApplyGrid,
  onExitGrid,
  onSetAnchored,
  onOpenGrid,
  theme,
  autoTheme,
  onToggleTheme,
  onResetLayout,
}: Props) {
  const display = relativePath(path, workspaceRoot);
  const filename = path?.split("/").pop() ?? null;
  const themeMeta = getThemeMeta(theme);
  return (
    <footer
      style={{
        height: "var(--size-status-bar)",
        background: "color-mix(in srgb, var(--bg-elevated) 88%, transparent)",
        borderTop: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        padding: "0 10px",
        gap: 10,
        fontSize: 11,
        color: "var(--fg-subtle)",
        fontFamily: "var(--font-ui)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
      }}
    >
      {display && (
        <span
          title={display}
          style={{
            color: filename ? "var(--fg)" : "var(--fg-subtle)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: "42vw",
            fontWeight: filename ? 500 : 400,
            letterSpacing: "-0.005em",
          }}
        >
          {display}
        </span>
      )}
      {language && (
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--fg-subtle)" }}>{language}</span>
      )}
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
            fontFamily: "var(--font-mono)",
            fontSize: 10.5,
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
          <span style={{ color: "var(--fg-dim)" }}>·</span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{gitStatus.files.length}</span>
        </span>
      )}
      {fileNotice && (
        <span
          title={fileNotice}
          style={{
            color: fileNotice.includes("changed") || fileNotice.includes("unavailable")
              ? "var(--warning)"
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
      <div style={{ flex: 1 }} />
      <Tooltip label={autoTheme ? "Cycle theme preference (auto theme is on)" : "Cycle theme"}>
      <button
        onClick={onToggleTheme}
        aria-label="Toggle theme"
        aria-pressed={themeMeta.isDark}
        className="klide-status-chip-btn"
      >
        <span
          aria-hidden
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: themeMeta.swatches[2],
            boxShadow: "0 0 0 2px color-mix(in srgb, var(--bg) 70%, transparent)",
          }}
        />
        {autoTheme ? "Auto" : "Theme"} · {themeMeta.name}
      </button>
      </Tooltip>
      <Tooltip label="Toggle terminal (⌃`)">
      <button
        onClick={onToggleTerminal}
        aria-label="Toggle terminal"
        aria-pressed={terminalVisible}
        className="klide-status-chip-btn"
        data-active={terminalVisible}
      >
        <TerminalIcon />
        Terminal
      </button>
      </Tooltip>
      <LayoutBento
        gridLayouts={gridLayouts}
        activeGridId={activeGridId}
        anchored={anchoredLayout}
        onApplyGrid={onApplyGrid}
        onExitGrid={onExitGrid}
        onSetAnchored={onSetAnchored}
        onOpenGrid={onOpenGrid}
      />
      <Tooltip label="Reset panel layout to default">
      <button
        onClick={onResetLayout}
        aria-label="Reset panel layout"
        className="klide-status-chip-btn"
      >
        Reset
      </button>
      </Tooltip>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--fg-subtle)" }}>UTF-8</span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--fg-subtle)" }}>LF</span>
    </footer>
  );
}
