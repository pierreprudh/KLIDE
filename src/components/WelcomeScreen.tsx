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
        padding: "56px 40px",
        background: "var(--bg)",
        position: "relative",
      }}
    >
      <div className="klide-welcome-ascii-city" aria-hidden="true">
        <pre className="klide-ascii-city-layer is-base">{ASCII_CITY}</pre>
        <pre className="klide-ascii-city-layer is-cyan">{ASCII_CITY_CYAN}</pre>
        <pre className="klide-ascii-city-layer is-magenta">{ASCII_CITY_MAGENTA}</pre>
      </div>
      <div
        style={{
          width: "min(540px, 88vw)",
          position: "relative",
          zIndex: 1,
        }}
      >
        <div
          aria-hidden
          style={{
            width: 34,
            height: 34,
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--border-strong)",
            background: "var(--bg-elevated)",
            color: "var(--fg-strong)",
            display: "grid",
            placeItems: "center",
            fontSize: 17,
            fontWeight: 700,
            boxShadow: "inset 0 1px 0 var(--panel-highlight)",
            marginBottom: 18,
          }}
        >
          K
        </div>
        <div
          style={{
            fontSize: 44,
            lineHeight: 1.05,
            color: "var(--fg-strong)",
            fontWeight: 700,
            letterSpacing: 0,
          }}
        >
          Klide
        </div>
        <div
          style={{
            fontSize: 15,
            color: "var(--fg-subtle)",
            lineHeight: 1.58,
            marginTop: 12,
            maxWidth: 340,
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
            marginTop: 38,
          }}
        >
          <button
            type="button"
            onClick={onOpenFolder}
            className="klide-button klide-button-primary"
            style={{ height: 44, padding: "0 20px", fontSize: 14 }}
          >
            <FolderIcon />
            Open Folder
            <Kbd>⌘O</Kbd>
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            className="klide-button klide-button-subtle"
            style={{ height: 44, padding: "0 14px", fontSize: 14 }}
          >
            Settings
          </button>
        </div>

        {/* Recent */}
        {recentFolders.length > 0 && (
          <div className="klide-surface" style={{ marginTop: 46 }}>
            <div
              style={{
                padding: "10px 12px 6px",
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 0,
                color: "var(--fg-dim)",
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
                    className="klide-settings-row"
                    style={{
                      minHeight: 44,
                      padding: "8px 12px",
                      gap: 8,
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
                          fontSize: 13.5,
                          fontWeight: 600,
                          color: "var(--fg-strong)",
                          flex: "0 0 auto",
                        }}
                      >
                        {folderName(path)}
                      </span>
                      <span
                        style={{
                          fontSize: 12,
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
                      className="klide-button klide-button-subtle"
                      style={{
                        flex: "0 0 auto",
                        width: 24,
                        minHeight: 24,
                        padding: 0,
                        opacity: isHovered ? 1 : 0,
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
  return <span className="klide-kbd">{children}</span>;
}

const ASCII_CITY = [
  "          .        .        .          .",
  "      .      _  _        _      .       ",
  "            | || |      | |             ",
  "     _______|_||_|______|_|_____        ",
  "    /  _  _  _  _  _  _  _  _  \\       ",
  "   /__/|[]|[]|[]|[]|[]|[]|[]|\\__\\      ",
  "   |##||::|::|::|::|::|::|::||##|      ",
  "   |##||[]|[]|[]|[]|[]|[]|[]||##|      ",
  " __|##||::|::|::|::|::|::|::||##|___   ",
  "|[]|##||[]|[]|[]|[]|[]|[]|[]||##|[]|   ",
  "|::|##||::|::|::|::|::|::|::||##|::|   ",
  "|[]|##||[]|[]|[]|[]|[]|[]|[]||##|[]|   ",
  "|::|##||::|::|::|::|::|::|::||##|::|   ",
  "|[]|##||[]|[]|[]|[]|[]|[]|[]||##|[]|   ",
  "|__|##||__|__|__|__|__|__|__||##|__|   ",
  "     |  K-LIDE  |====|  AI/RUN  |      ",
  "  ___|__________|____|__________|___    ",
  " /:::::/:::::/:::::/:::::/:::::/:::/|   ",
  "/_____/_____/_____/_____/_____/___/ |   ",
  "|  _   _   _   _   _   _   _   _  | |  ",
  "| |_| |_| |_| |_| |_| |_| |_| |_| | |   ",
  "|  _   _   _   _   _   _   _   _  |/   ",
  "|_| |_| |_| |_| |_| |_| |_| |_| |_|     ",
  "      ----==== neon rail ====----       ",
  "   .--.        .----.        .--.       ",
  "  /    \\______/  __  \\______/    \\      ",
  " /  /\\  \\    /  /  \\  \\    /  /\\  \\     ",
  "/__/  \\__\\__/__/    \\__\\__/__/  \\__\\    ",
].join("\n");

const ASCII_CITY_CYAN = [
  "                                           ",
  "                                           ",
  "                         __                ",
  "                        /  \\               ",
  "             .---------'    '--------.     ",
  "            /  o  o  o  o  o  o  o   \\    ",
  "           /____________________________\\   ",
  "             ||  ||  ||  ||  ||  ||        ",
  "             ||  ||  ||  ||  ||  ||        ",
  "             ||  ||  ||  ||  ||  ||        ",
  "                                           ",
  "       +===============================+   ",
  "       |  DATA  DATA  DATA  DATA  DATA |   ",
  "       +===============================+   ",
  "                                           ",
  "                 .---.                     ",
  "                /  K  \\                    ",
  "               /_______\\                   ",
  "                                           ",
  "        /\\                         /\\      ",
  "       /  \\       ________        /  \\     ",
  "      /____\\_____/________\\______/____\\    ",
  "                                           ",
  "      ----==== neon rail ====----          ",
  "                                           ",
  "                                           ",
  "                                           ",
  "                                           ",
].join("\n");

const ASCII_CITY_MAGENTA = [
  "        *                       *          ",
  "                                           ",
  "             __                            ",
  "            /  \\          __              ",
  "           /    \\        /  \\             ",
  "          /______\\      /____\\            ",
  "                                           ",
  "       |>|       |>|        |>|           ",
  "       |>|       |>|        |>|           ",
  "                                           ",
  "  +-----------+                 +------+   ",
  "  |  NEON-9   |                 |  RUN |   ",
  "  +-----------+                 +------+   ",
  "                                           ",
  "                         .---.             ",
  "                        / .-. \\            ",
  "                       /  \\_/  \\           ",
  "                      /_________\\          ",
  "                                           ",
  "                                           ",
  "             .-.                           ",
  "          .-(   )-.                        ",
  "         (___.-.___)                       ",
  "                                           ",
  "    .--.                          .--.     ",
  "   /____\\                        /____\\    ",
  "                                           ",
  "                                           ",
].join("\n");

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
