import { useState } from "react";

type Props = {
  recentFolders: string[];
  onOpenFolder: () => void;
  onOpenRecent: (path: string) => void;
  onRemoveRecent: (path: string) => void;
  onOpenSettings: () => void;
};

function folderName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  const parent = cut > 0 ? trimmed.slice(0, cut) : "/";
  return parent.replace(/^\/Users\/[^/]+/, "~");
}

export function WelcomeScreen({
  recentFolders,
  onOpenFolder,
  onOpenRecent,
  onRemoveRecent,
  onOpenSettings,
}: Props) {
  const [hovered, setHovered] = useState<string | null>(null);

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        padding: "64px 48px",
        background: "var(--bg)",
        position: "relative",
      }}
    >
      <pre
        aria-hidden
        style={{
          position: "absolute",
          right: -20,
          bottom: -10,
          margin: 0,
          fontSize: 9,
          lineHeight: 1.15,
          letterSpacing: "0.08em",
          fontFamily: "var(--font-mono)",
          color: "var(--fg-dim)",
          textAlign: "right",
          userSelect: "none",
          pointerEvents: "none",
          maskImage: "linear-gradient(to left, black 10%, transparent 70%)",
          WebkitMaskImage: "linear-gradient(to left, black 10%, transparent 70%)",
          opacity: 0.35,
        }}
      >
        {ASCII_LANDSCAPE}
      </pre>

      <div
        style={{
          width: "min(480px, 88vw)",
          position: "relative",
          zIndex: 1,
        }}
      >
        <div
          style={{
            fontSize: 32,
            lineHeight: 1.1,
            color: "var(--fg-strong)",
            fontWeight: 600,
            letterSpacing: "-0.02em",
          }}
        >
          Klide
        </div>
        <div
          style={{
            fontSize: 13,
            color: "var(--fg-subtle)",
            lineHeight: 1.55,
            marginTop: 10,
            maxWidth: 300,
          }}
        >
          Small, fast, AI-first editor.
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 32,
          }}
        >
          <button
            type="button"
            onClick={onOpenFolder}
            style={{
              height: 36,
              padding: "0 14px",
              fontSize: 12.5,
              fontWeight: 500,
              border: "none",
              borderRadius: "var(--radius-sm)",
              background: "var(--fg-strong)",
              color: "var(--bg)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h7A1.5 1.5 0 0 1 19 9v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17V6.5Z" />
            </svg>
            Open Folder
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            style={{
              height: 36,
              padding: "0 12px",
              fontSize: 12.5,
              fontWeight: 500,
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              background: "transparent",
              color: "var(--fg-subtle)",
              cursor: "pointer",
            }}
          >
            Settings
          </button>
        </div>

        {recentFolders.length > 0 && (
          <div style={{ marginTop: 40 }}>
            <div
              style={{
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "var(--fg-dim)",
                marginBottom: 8,
              }}
            >
              Recent
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {recentFolders.map((path) => {
                const isHovered = hovered === path;
                return (
                  <div
                    key={path}
                    onMouseEnter={() => setHovered(path)}
                    onMouseLeave={() => setHovered(null)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      height: 34,
                      padding: "0 8px",
                      borderRadius: "var(--radius-sm)",
                      background: isHovered ? "var(--bg-hover)" : "transparent",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => onOpenRecent(path)}
                      title={path}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        background: "transparent",
                        border: "none",
                        padding: 0,
                        font: "inherit",
                        cursor: "pointer",
                        textAlign: "left",
                      }}
                    >
                      <span style={{ fontSize: 13, fontWeight: 500, color: "var(--fg-strong)", flexShrink: 0 }}>
                        {folderName(path)}
                      </span>
                      <span style={{ fontSize: 11.5, color: "var(--fg-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {parentPath(path)}
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove ${folderName(path)}`}
                      title="Remove"
                      onClick={() => onRemoveRecent(path)}
                      style={{
                        flexShrink: 0,
                        width: 22,
                        height: 22,
                        display: "grid",
                        placeItems: "center",
                        background: "transparent",
                        border: "none",
                        padding: 0,
                        cursor: "pointer",
                        color: "var(--fg-dim)",
                        opacity: isHovered ? 1 : 0,
                        fontSize: 12,
                      }}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const ASCII_LANDSCAPE = [
  "                                                                       *",
  "                                                     *                 ",
  "                                                                       ",
  "                               *                *        *             ",
  "                                                                    *  ",
  "                        *                 *                           ",
  "                                                     *               ",
  "                                          _                           ",
  "                                      .-'` `'-.                       ",
  "                          *          /          \\          *         ",
  "                  _                 /    /\\       \\                    ",
  "                 / \\              /    /  \\       \\                   ",
  "          *     /   \\      _     /    /    \\       \\                  ",
  "               /     \\    / \\   /    /      \\       \\           *    ",
  "              /       \\  /   \\ /    /        \\       \\                ",
  "            _/         \\/     \\/   /          \\       \\               ",
  "          _/\\_________/             \\         \\       \\              ",
  "    _/\\_/\\/                            \\         \\       \\           ",
  "   /                                     \\         \\       \\         ",
  "  /                                       \\         \\       \\       ",
  " /                                         \\         \\       \\     ",
  "/  _   _   _   _   _   _   _   _   _   _   _\\_   _   _\\_   _  _\\",
  "| / \\ / \\ / \\ / \\ / \\ / \\ / \\ / \\ / \\ / \\ / \\ / \\ / \\ / \\ / \\ / \\",
  "|/\\_/\\_/\\_/\\_/\\_/\\_/\\_/\\_/\\_/\\_/\\_/\\_/\\_/\\_/\\_/\\_/\\_/\\_/\\_/\\_/\\_/\\",
  "~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~",
].join("\n");
