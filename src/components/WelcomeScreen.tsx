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
      className="shell-enter"
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
          width: "min(520px, 88vw)",
          position: "relative",
          zIndex: 1,
        }}
      >
        {/* Hero */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
          <div
            style={{
              fontSize: 40,
              lineHeight: 1,
              color: "var(--fg-strong)",
              fontWeight: 600,
              letterSpacing: "-0.028em",
            }}
          >
            Klide
          </div>
          <div
            style={{
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              letterSpacing: "0.04em",
              color: "var(--fg-dim)",
              paddingTop: 4,
            }}
          >
            v0.2
          </div>
        </div>
        <div
          style={{
            fontSize: 14,
            color: "var(--fg-subtle)",
            lineHeight: 1.55,
            marginTop: 12,
            maxWidth: 360,
            letterSpacing: "-0.005em",
          }}
        >
          A quiet, AI-first editor — small, fast, and built for the agent loop.
        </div>

        {/* CTAs */}
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
            className="klide-button klide-button-primary"
            style={{ minHeight: 36, padding: "0 16px", fontSize: 13, fontWeight: 500 }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h7A1.5 1.5 0 0 1 19 9v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17V6.5Z" />
            </svg>
            Open Folder
            <span className="klide-kbd" style={{ marginLeft: 4 }}>⌘ O</span>
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            className="klide-button klide-button-ghost"
            style={{ minHeight: 36, padding: "0 14px", fontSize: 13, fontWeight: 500, color: "var(--fg-subtle)" }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--fg-strong)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-subtle)"; }}
          >
            <SettingsIcon />
            Settings
          </button>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 10.5, fontFamily: "var(--font-mono)", letterSpacing: "0.04em", color: "var(--fg-dim)" }}>
            {recentFolders.length} recent
          </span>
        </div>

        {recentFolders.length > 0 && (
          <section style={{ marginTop: 44 }}>
            <div
              style={{
                fontSize: 10.5,
                fontWeight: 600,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--fg-subtle)",
                marginBottom: 10,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              Recent
              <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {recentFolders.map((path) => {
                const isHovered = hovered === path;
                return (
                  <div
                    key={path}
                    onMouseEnter={() => setHovered(path)}
                    onMouseLeave={() => setHovered(null)}
                    className="klide-recent-row"
                    data-hovered={isHovered}
                  >
                    <button
                      type="button"
                      onClick={() => onOpenRecent(path)}
                      title={path}
                      className="klide-recent-open"
                    >
                      <FolderIcon />
                      <span style={{ fontSize: 13, fontWeight: 500, color: "var(--fg-strong)", flexShrink: 0, letterSpacing: "-0.005em" }}>
                        {folderName(path)}
                      </span>
                      <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
                      <span className="klide-recent-path">
                        {parentPath(path)}
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove ${folderName(path)}`}
                      title="Remove"
                      onClick={() => onRemoveRecent(path)}
                      className="klide-recent-remove"
                      data-visible={isHovered}
                    >
                      <CloseIcon />
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h7A1.5 1.5 0 0 1 19 9v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17V6.5Z" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="2.6" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
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
