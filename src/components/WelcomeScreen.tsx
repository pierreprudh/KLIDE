import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { FolderIcon } from "../icons";
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
    <div className="klide-welcome klide-welcome--editorial">
      {/* ── Page: a typeset column — one solid action, the rest quiet ───── */}
      <div className="klide-welcome-page">
        <div className="klide-welcome-rise klide-welcome-wordmark" style={rise(0)}>
          Klide
        </div>

        <div className="klide-welcome-body">
          <h1 className="klide-welcome-rise klide-welcome-title" style={rise(60)}>
            {recents.length > 0 ? "Welcome back." : "Welcome to Klide."}
          </h1>
          <p className="klide-welcome-rise klide-welcome-sub" style={rise(100)}>
            {recents.length > 0
              ? "Open a project to start a conversation with Kit, or pick up where you left off."
              : "Open a folder to start a conversation with Kit about your code."}
          </p>

          <div className="klide-welcome-rise klide-welcome-actions" style={rise(140)}>
            <button type="button" onClick={onOpenFolder} className="klide-welcome-primary">
              <FolderIcon size={15} />
              Open folder
              <kbd>⌘O</kbd>
            </button>
            <button
              type="button"
              onClick={() => openComposer("new")}
              className="klide-welcome-text"
              data-active={composer === "new" ? "true" : undefined}
            >
              New project
            </button>
            <button
              type="button"
              onClick={() => openComposer("clone")}
              className="klide-welcome-text"
              data-active={composer === "clone" ? "true" : undefined}
            >
              Clone
            </button>
          </div>

          {/* Inline composer for New project / Clone */}
          {composer && (
            <div className="klide-welcome-composer">
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
                  className="klide-welcome-primary"
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
                  className="klide-welcome-text"
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

          {/* Recent — hairline rows; shortcut and remove revealed on hover */}
          {recents.length > 0 && (
            <section className="klide-welcome-rise" style={rise(180)}>
              <div className="klide-welcome-rlabel">Recent</div>
              <div className="klide-welcome-list">
                {recents.map((path, i) => (
                  <div key={path} className="klide-welcome-rrow">
                    <button
                      type="button"
                      className="klide-welcome-rrow-open"
                      onClick={() => onOpenRecent(path)}
                      title={path}
                    >
                      <span className="klide-welcome-rrow-text">
                        <span className="klide-welcome-rrow-name">{folderName(path)}</span>
                        <span className="klide-welcome-rrow-path">{parentPath(path)}</span>
                      </span>
                      <kbd className="klide-welcome-rrow-key">⌘{i + 1}</kbd>
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
            </section>
          )}
        </div>

        <div className="klide-welcome-rise klide-welcome-foot" style={rise(240)}>
          <button type="button" onClick={onOpenSettings}>
            Settings
          </button>
          <span>
            <b>⌘N</b> new · <b>⌘⇧N</b> clone
          </span>
        </div>
      </div>

      {/* ── Film: a full-bleed picture plane, not a floating card ───────── */}
      <div className="klide-welcome-film">
        <PixelNature className="klide-nature-canvas" />
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
