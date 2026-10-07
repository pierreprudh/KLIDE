import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { FolderIcon, GitIcon, NewTaskIcon, SettingsIcon } from "../icons";
import { PixelNature } from "./PixelNature";

type Props = {
  recentFolders: string[];
  onOpenFolder: () => void;
  onNewProject: (name: string) => Promise<void> | void;
  onCloneRepo: (url: string) => Promise<void> | void;
  onOpenRecent: (path: string) => void;
  onRemoveRecent: (path: string) => void;
  onOpenSettings: () => void;
};

const MAX_RECENTS = 5;

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

function rise(delayMs: number): CSSProperties {
  return { "--welcome-delay": `${delayMs}ms` } as CSSProperties;
}

export function WelcomeScreen({
  recentFolders,
  onOpenFolder,
  onNewProject,
  onCloneRepo,
  onOpenRecent,
  onRemoveRecent,
  onOpenSettings,
}: Props) {
  // Inline composer for the New-project / Clone flows (name or URL).
  const [composer, setComposer] = useState<null | "new" | "clone">(null);
  const [composerValue, setComposerValue] = useState("");
  const [composerBusy, setComposerBusy] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const composerInputRef = useRef<HTMLInputElement | null>(null);
  const recents = recentFolders.slice(0, MAX_RECENTS);

  function openComposer(mode: "new" | "clone") {
    setComposer(mode);
    setComposerValue("");
    setComposerError(null);
  }

  async function submitComposer() {
    const value = composerValue.trim();
    if (!value || composerBusy) return;
    setComposerBusy(true);
    setComposerError(null);
    try {
      if (composer === "new") await onNewProject(value);
      else await onCloneRepo(value);
      setComposer(null);
      setComposerValue("");
    } catch (err) {
      setComposerError(err instanceof Error ? err.message : String(err));
    } finally {
      setComposerBusy(false);
    }
  }

  // Welcome-only shortcuts: ⌘1–⌘5 open a recent, ⌘N new project, ⌘⇧N clone.
  // (⌘O is handled globally in App.) This effect only lives while the welcome
  // screen is mounted, so it never clashes with editor shortcuts.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      // Match N by physical key (e.code) so it's layout-independent.
      if (e.code === "KeyN" || e.key === "n" || e.key === "N") {
        e.preventDefault();
        openComposer(e.shiftKey ? "clone" : "new");
        return;
      }
      if (e.shiftKey) return;
      // ⌘1–⌘5 → recent. With a modifier held, `e.key` can be a non-digit on
      // some layouts, so match the physical digit key via `e.code`.
      const digit = /^Digit([1-9])$/.exec(e.code);
      const n = digit ? Number(digit[1]) : Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= Math.min(recentFolders.length, MAX_RECENTS)) {
        e.preventDefault();
        onOpenRecent(recentFolders[n - 1]);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recentFolders, onOpenRecent]);

  // Focus the composer input whenever it opens.
  useEffect(() => {
    if (composer) composerInputRef.current?.focus();
  }, [composer]);

  return (
    <div className="klide-welcome klide-welcome--split">
      {/* ── Left pane: content ─────────────────────────────────────────── */}
      <div className="klide-welcome-pane">
        <div className="klide-welcome-content">
          {/* Wordmark */}
          <div className="klide-welcome-rise klide-welcome-wordmark" style={rise(0)}>
            Klide
          </div>

          {/* Heading */}
          <div className="klide-welcome-rise" style={{ ...rise(60), marginTop: 30 }}>
            <h1 className="klide-welcome-title">Welcome back</h1>
          </div>

          {/* Actions — one clear primary, then quieter options; even 2×2 grid */}
          <div
            className="klide-welcome-rise"
            style={{
              ...rise(120),
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 10,
              marginTop: 28,
            }}
          >
            <button
              type="button"
              onClick={onOpenFolder}
              className="klide-welcome-glass-btn"
              data-primary="true"
              style={{ width: "100%", justifyContent: "flex-start" }}
            >
              <FolderIcon size={15} />
              Open folder
              <kbd className="klide-welcome-kbd" style={{ marginLeft: "auto" }}>⌘O</kbd>
            </button>
            <button
              type="button"
              onClick={() => openComposer("new")}
              className="klide-welcome-glass-btn"
              data-active={composer === "new" ? "true" : undefined}
              style={{ width: "100%", justifyContent: "flex-start" }}
            >
              <NewTaskIcon size={15} />
              New project
              <kbd className="klide-welcome-kbd" style={{ marginLeft: "auto" }}>⌘N</kbd>
            </button>
            <button
              type="button"
              onClick={() => openComposer("clone")}
              className="klide-welcome-glass-btn"
              data-active={composer === "clone" ? "true" : undefined}
              style={{ width: "100%", justifyContent: "flex-start" }}
            >
              <GitIcon size={15} />
              Clone
              <kbd className="klide-welcome-kbd" style={{ marginLeft: "auto" }}>⌘⇧N</kbd>
            </button>
            <button
              type="button"
              onClick={onOpenSettings}
              className="klide-welcome-glass-btn"
              data-quiet="true"
              style={{ width: "100%", justifyContent: "flex-start" }}
            >
              <SettingsIcon size={14} />
              Settings
            </button>
          </div>

          {/* Inline composer for New project / Clone */}
          {composer && (
            <div className="klide-welcome-composer" style={{ marginTop: 14 }}>
              <div className="klide-welcome-composer-row">
                <input
                  ref={composerInputRef}
                  className="klide-welcome-input"
                  type="text"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  disabled={composerBusy}
                  value={composerValue}
                  placeholder={
                    composer === "new"
                      ? "project-name"
                      : "https://github.com/user/repo"
                  }
                  onChange={(e) => setComposerValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      submitComposer();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setComposer(null);
                    }
                  }}
                />
                <button
                  type="button"
                  className="klide-welcome-glass-btn"
                  data-primary="true"
                  disabled={composerBusy || !composerValue.trim()}
                  onClick={submitComposer}
                >
                  {composerBusy
                    ? composer === "new"
                      ? "Creating…"
                      : "Cloning…"
                    : composer === "new"
                      ? "Create"
                      : "Clone"}
                </button>
                <button
                  type="button"
                  className="klide-welcome-glass-btn"
                  data-quiet="true"
                  disabled={composerBusy}
                  onClick={() => setComposer(null)}
                >
                  Cancel
                </button>
              </div>
              <div className="klide-welcome-composer-hint">
                {composerError ? (
                  <span className="klide-welcome-composer-error">{composerError}</span>
                ) : composer === "new" ? (
                  "Creates the folder, runs git init, then opens it."
                ) : (
                  "You'll choose where to clone it."
                )}
              </div>
            </div>
          )}

          {/* Recent */}
          <section className="klide-welcome-rise" style={{ ...rise(180), marginTop: 44 }}>
            <div className="klide-welcome-rlabel">
              Recent
              <span className="line" />
            </div>

            {recents.length === 0 ? (
              <div aria-hidden style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {Array.from({ length: 3 }, (_, i) => (
                  <div key={i} className="klide-welcome-rrow is-placeholder" />
                ))}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {recents.map((path, i) => (
                  <div key={path} className="klide-welcome-rrow">
                    <button
                      type="button"
                      onClick={() => onOpenRecent(path)}
                      title={path}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        display: "flex",
                        alignItems: "center",
                        gap: 13,
                        background: "transparent",
                        border: "none",
                        padding: 0,
                        cursor: "pointer",
                        textAlign: "left",
                        color: "inherit",
                      }}
                    >
                      <span className="klide-welcome-rrow-index">{String(i + 1).padStart(2, "0")}</span>
                      <span className="klide-welcome-rrow-name">{folderName(path)}</span>
                      <span className="klide-welcome-rrow-path">{parentPath(path)}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove ${folderName(path)}`}
                      title="Remove"
                      onClick={() => onRemoveRecent(path)}
                      className="klide-welcome-rrow-remove"
                    >
                      <CloseIcon />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {recents.length > 0 && (
            <div
              className="klide-welcome-rise klide-welcome-keys"
              style={{ ...rise(240), marginTop: 26 }}
            >
              <span>
                <b>⌘1</b>–<b>⌘{Math.min(recents.length, MAX_RECENTS)}</b> open a recent folder
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ── Right pane: big-pixel nature film ──────────────────────────── */}
      <div className="klide-welcome-stage">
        <div className="klide-welcome-card is-nature klide-welcome-rise" style={rise(90)}>
          <PixelNature className="klide-nature-canvas" />
        </div>
      </div>
    </div>
  );
}





function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
