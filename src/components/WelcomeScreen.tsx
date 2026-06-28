import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

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

type WelcomeVars = CSSProperties & {
  "--cosmos-font": string;
};

// ── ASCII planet ───────────────────────────────────────────────────────────
// A single lit sphere floating in a sparse starfield, centred in the frame.
// (The old bottom-anchored horizon looked stuck once it moved into a portrait
// card.) Surface brightness = Lambertian light · fBm continents; a brighter
// limb fakes an atmosphere. Layers are separate so stars stay crisp behind it.

const GLYPH_ASPECT = 0.6; // rendered monospace cell width / height
const SURFACE_RAMP = " .,:;~-=+ox*X#%8@"; // dark → bright
const STAR_DIM = ".:'";
const STAR_BRIGHT = "+x*";

function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function vnoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  const u = smooth(xf);
  const v = smooth(yf);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

function fbm(x: number, y: number): number {
  return vnoise(x, y) * 0.6 + vnoise(x * 2.3 + 5, y * 2.3 + 9) * 0.27 + vnoise(x * 4.7 + 11, y * 4.7 + 3) * 0.13;
}

type Planet = {
  cols: number;
  rows: number;
  stars: string;
  brightStars: string;
  body: string;
  rim: string;
};

function buildPlanet(cols: number, rows: number): Planet {
  const stars: string[] = [];
  const bright: string[] = [];
  const body: string[] = [];
  const rim: string[] = [];
  const cx = (cols - 1) / 2;
  const cy = (rows - 1) / 2;
  const radius = Math.min(cols * GLYPH_ASPECT, rows) * 0.4;

  // Light from the upper-left, tilted slightly toward the viewer.
  const lx = -0.52;
  const ly = -0.46;
  const lz = 0.72;
  const llen = Math.sqrt(lx * lx + ly * ly + lz * lz);
  const Lx = lx / llen;
  const Ly = ly / llen;
  const Lz = lz / llen;

  for (let row = 0; row < rows; row++) {
    let sLine = "";
    let bLine = "";
    let bodyLine = "";
    let rimLine = "";
    for (let col = 0; col < cols; col++) {
      const dx = (col - cx) * GLYPH_ASPECT;
      const dy = row - cy;
      const nd = Math.sqrt(dx * dx + dy * dy) / radius;

      if (nd <= 1) {
        // On the sphere: reconstruct the surface normal and shade it.
        const nx = dx / radius;
        const ny = dy / radius;
        const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
        const light = Math.max(0, nx * Lx + ny * Ly + nz * Lz);
        const tex = fbm(nx * 1.8 + 4, ny * 1.8 + 7); // continents
        const relief = fbm(nx * 5.0 + 1, ny * 5.0 + 9); // mid grain
        const fine = fbm(nx * 12.0 + 3, ny * 12.0 + 6); // fine speckle
        const v = Math.max(
          0,
          Math.min(1, light * 0.78 + tex * 0.26 + relief * 0.12 + fine * 0.06 - 0.05)
        );

        // Dither the dark hemisphere so the terminator dissolves into grains
        // instead of reading as a hard-edged blob.
        if (hash2(col * 5 + 1, row * 5 + 1) > 0.42 + v * 0.66) {
          bodyLine += " ";
          rimLine += " ";
          sLine += " ";
          bLine += " ";
          continue;
        }

        const idx = Math.max(0, Math.min(SURFACE_RAMP.length - 1, Math.round(v * (SURFACE_RAMP.length - 1))));
        bodyLine += SURFACE_RAMP[idx];
        rimLine +=
          nd > 0.86 && light > 0.08
            ? SURFACE_RAMP[Math.min(SURFACE_RAMP.length - 1, idx + 3)]
            : " ";
        sLine += " ";
        bLine += " ";
        continue;
      }

      // Off the sphere: sparse starfield, clustered into faint pockets.
      bodyLine += " ";
      rimLine += " ";
      const pocket = fbm(col * 0.05 + 2, row * 0.08 + 5);
      const density = 0.013 + (pocket > 0.7 ? 0.012 : 0);
      if (hash2(col * 7 + 3, row * 11 + 5) < density) {
        if (hash2(col * 17 + 2, row * 19 + 9) < 0.22) {
          bLine += STAR_BRIGHT[Math.floor(hash2(col + 5, row + 3) * STAR_BRIGHT.length)];
          sLine += " ";
        } else {
          sLine += STAR_DIM[Math.floor(hash2(col, row) * STAR_DIM.length)];
          bLine += " ";
        }
      } else {
        sLine += " ";
        bLine += " ";
      }
    }
    stars.push(sLine);
    bright.push(bLine);
    body.push(bodyLine);
    rim.push(rimLine);
  }

  return {
    cols,
    rows,
    stars: stars.join("\n"),
    brightStars: bright.join("\n"),
    body: body.join("\n"),
    rim: rim.join("\n"),
  };
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
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Inline composer for the New-project / Clone flows (name or URL).
  const [composer, setComposer] = useState<null | "new" | "clone">(null);
  const [composerValue, setComposerValue] = useState("");
  const [composerBusy, setComposerBusy] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const composerInputRef = useRef<HTMLInputElement | null>(null);
  const [keyProbe, setKeyProbe] = useState<string | null>(null); // TEMP probe
  // rootRef is the framed cosmos card on the right; the ASCII art is sized to
  // fit that card rather than the whole welcome surface.
  const [surface, setSurface] = useState({ width: 620, height: 720 });
  const recents = recentFolders.slice(0, MAX_RECENTS);

  // Size a character grid to fill the card so the sphere centres in it. font
  // scales with card width; cols/rows derive from the cell metrics.
  const geometry = useMemo(() => {
    const width = Math.max(240, surface.width);
    const height = Math.max(240, surface.height);
    const font = Math.max(6, Math.min(11, width / 84));
    const cols = Math.max(64, Math.round(width / (font * GLYPH_ASPECT)));
    const rows = Math.max(52, Math.round(height / font));
    return { font, cols, rows };
  }, [surface]);
  const planet = useMemo(() => buildPlanet(geometry.cols, geometry.rows), [geometry.cols, geometry.rows]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setSurface((prev) => {
        const width = Math.round(rect.width);
        const height = Math.round(rect.height);
        return prev.width === width && prev.height === height ? prev : { width, height };
      });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cosmosVars = useMemo(
    () => ({ "--cosmos-font": `${geometry.font}px` }) as WelcomeVars,
    [geometry.font]
  );

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
      // TEMP PROBE — remove once shortcuts are confirmed.
      if (e.metaKey || e.ctrlKey) {
        setKeyProbe(
          `key=${JSON.stringify(e.key)} code=${e.code} meta=${e.metaKey} ctrl=${e.ctrlKey} shift=${e.shiftKey}`
        );
      }
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
              <FolderIcon />
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
              <PlusIcon />
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
              <GitIcon />
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
              <SettingsIcon />
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

          {/* TEMP PROBE — shows what the last ⌘/Ctrl keypress reported. */}
          {keyProbe && (
            <div
              style={{
                marginTop: 14,
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--w-dim)",
                wordBreak: "break-all",
              }}
            >
              {keyProbe}
            </div>
          )}
        </div>
      </div>

      {/* ── Right pane: framed ASCII cosmos card ───────────────────────── */}
      <div className="klide-welcome-stage">
        <div
          ref={rootRef}
          className="klide-welcome-card klide-welcome-rise"
          style={{ ...cosmosVars, ...rise(90) }}
        >
          <div className="klide-welcome-cosmos" aria-hidden>
            <div className="klide-cosmos-glow" />
            <pre className="klide-cosmos-layer is-stars">{planet.stars}</pre>
            <pre className="klide-cosmos-layer is-bright-stars">{planet.brightStars}</pre>
            <pre className="klide-cosmos-layer is-planet">{planet.body}</pre>
            <pre className="klide-cosmos-layer is-planet-glow">{planet.rim}</pre>
          </div>
        </div>
      </div>
    </div>
  );
}

function FolderIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h7A1.5 1.5 0 0 1 19 9v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17V6.5Z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function GitIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="6" r="2.4" />
      <circle cx="6" cy="18" r="2.4" />
      <circle cx="17" cy="9" r="2.4" />
      <path d="M6 8.4v7.2M17 11.4c0 3.2-2.4 4-5 4.2-2 .2-3.5.6-3.5 2.2" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 6h10" />
      <path d="M18 6h2" />
      <path d="M16 4v4" />
      <path d="M4 12h3" />
      <path d="M11 12h9" />
      <path d="M9 10v4" />
      <path d="M4 18h11" />
      <path d="M19 18h1" />
      <path d="M17 16v4" />
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
