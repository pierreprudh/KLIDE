import { useState } from "react";

type Props = {
  recentFolders: string[];
  onOpenFolder: () => void;
  onOpenRecent: (path: string) => void;
  onRemoveRecent: (path: string) => void;
  onOpenSettings: () => void;
};

// Display helpers — split an absolute path into its folder name (bold) and the
// parent directory (muted), abbreviating the home dir to "~" when present.
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
      className="welcome-screen"
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        overflow: "auto",
        padding: "48px 32px",
        background: "var(--bg)",
      }}
    >
      <div style={{ width: "min(540px, 88vw)" }}>
        {/* Brand */}
        <div
          style={{
            fontSize: 44,
            lineHeight: 1.05,
            color: "var(--fg-strong)",
            fontWeight: 600,
            letterSpacing: "-0.03em",
          }}
        >
          Klide
        </div>
        <div
          style={{
            fontSize: 15,
            color: "var(--fg-subtle)",
            lineHeight: 1.6,
            marginTop: 12,
          }}
        >
          A small, fast, AI-first editor.
          <br />
          Open a folder to begin.
        </div>

        {/* Actions */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginTop: 40,
          }}
        >
          <button
            type="button"
            onClick={onOpenFolder}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 10,
              height: 44,
              padding: "0 22px",
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--border-strong)",
              background: "var(--bg-elevated)",
              color: "var(--fg-strong)",
              font: "inherit",
              fontSize: 14.5,
              fontWeight: 500,
              cursor: "pointer",
              transition: "background var(--motion-fast) var(--ease-out)",
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = "var(--bg-hover)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "var(--bg-elevated)")
            }
          >
            <FolderIcon />
            Open Folder
            <Kbd>⌘O</Kbd>
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            style={{
              height: 44,
              padding: "0 16px",
              borderRadius: "var(--radius-md)",
              border: "none",
              background: "transparent",
              color: "var(--fg)",
              font: "inherit",
              fontSize: 14.5,
              cursor: "pointer",
              transition: "color var(--motion-fast) var(--ease-out)",
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.color = "var(--fg-strong)")
            }
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--fg)")}
          >
            Settings
          </button>
        </div>

        {/* Recent */}
        {recentFolders.length > 0 && (
          <div style={{ marginTop: 52 }}>
            <div
              style={{
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                color: "var(--fg-dim)",
                marginBottom: 6,
              }}
            >
              Recent
            </div>
            <div style={{ display: "flex", flexDirection: "column" }}>
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
                      gap: 8,
                      padding: "10px 12px",
                      marginLeft: -12,
                      marginRight: -12,
                      borderRadius: "var(--radius-sm)",
                      background: isHovered ? "var(--bg-hover)" : "transparent",
                      transition: "background var(--motion-fast) var(--ease-out)",
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
                        alignItems: "baseline",
                        gap: 12,
                        background: "transparent",
                        border: "none",
                        padding: 0,
                        font: "inherit",
                        cursor: "pointer",
                        textAlign: "left",
                      }}
                    >
                      <span
                        style={{
                          fontSize: 14,
                          color: "var(--fg-strong)",
                          flex: "0 0 auto",
                        }}
                      >
                        {folderName(path)}
                      </span>
                      <span
                        style={{
                          fontSize: 12.5,
                          color: "var(--fg-subtle)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          minWidth: 0,
                        }}
                      >
                        {parentPath(path)}
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove ${folderName(path)} from recent`}
                      title="Remove from recent"
                      onClick={() => onRemoveRecent(path)}
                      style={{
                        flex: "0 0 auto",
                        width: 22,
                        height: 22,
                        display: "grid",
                        placeItems: "center",
                        borderRadius: "var(--radius-xs)",
                        border: "none",
                        background: "transparent",
                        color: "var(--fg-dim)",
                        cursor: "pointer",
                        opacity: isHovered ? 1 : 0,
                        transition: "opacity var(--motion-fast) var(--ease-out)",
                      }}
                    >
                      <CloseIcon />
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

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        marginLeft: 4,
        fontSize: 11.5,
        lineHeight: 1,
        padding: "3px 6px",
        borderRadius: "var(--radius-xs)",
        border: "1px solid var(--border)",
        color: "var(--fg-subtle)",
        background: "var(--bg)",
        fontFamily: "var(--font-mono)",
      }}
    >
      {children}
    </span>
  );
}

function FolderIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h7A1.5 1.5 0 0 1 19 9v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17V6.5Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
