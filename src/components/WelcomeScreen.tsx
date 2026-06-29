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
const SPIN_RATE = 0.16; // longitude radians / second — slow, calm drift
const FRAME_MS = 120; // ~8fps; ASCII reads best chunky, and it's cheap

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

type Starfield = { stars: string; brightStars: string };
type Globe = { body: string; rim: string };

// The starfield is the static backdrop — positions never rotate with the
// planet, but each star twinkles on its own clock: a per-star sine drives a
// brightness pulse, and a brief dip below threshold blinks it off entirely.
// `t` is elapsed seconds; with t omitted (reduced-motion) every star sits at
// its steady mid-brightness.
function buildStarfield(cols: number, rows: number, t: number): Starfield {
  const stars: string[] = [];
  const bright: string[] = [];
  const cx = (cols - 1) / 2;
  const cy = (rows - 1) / 2;
  const radius = Math.min(cols * GLYPH_ASPECT, rows) * 0.4;

  for (let row = 0; row < rows; row++) {
    let sLine = "";
    let bLine = "";
    for (let col = 0; col < cols; col++) {
      const dx = (col - cx) * GLYPH_ASPECT;
      const dy = row - cy;
      const nd = Math.sqrt(dx * dx + dy * dy) / radius;
      // Inside the disc the planet covers the sky — no stars there.
      if (nd <= 1.0) {
        sLine += " ";
        bLine += " ";
        continue;
      }
      const pocket = fbm(col * 0.05 + 2, row * 0.08 + 5);
      const density = 0.013 + (pocket > 0.7 ? 0.012 : 0);
      if (hash2(col * 7 + 3, row * 11 + 5) >= density) {
        sLine += " ";
        bLine += " ";
        continue;
      }

      // Per-star twinkle: offset the phase by the star's hash so they blink
      // out of sync. tw ∈ [0,1]; a brief trough blinks the star off.
      const sp = hash2(col * 3 + 7, row * 5 + 11) * 6.2831853;
      const tw = Math.sin(t * 1.6 + sp) * 0.5 + 0.5;
      if (tw < 0.12) {
        sLine += " ";
        bLine += " ";
        continue;
      }

      const canBurn = hash2(col * 17 + 2, row * 19 + 9) < 0.22; // bright-capable
      if (canBurn && tw > 0.5) {
        const bi = Math.min(STAR_BRIGHT.length - 1, Math.floor(tw * STAR_BRIGHT.length));
        bLine += STAR_BRIGHT[bi];
        sLine += " ";
      } else {
        const di = Math.min(STAR_DIM.length - 1, Math.floor(hash2(col, row) * STAR_DIM.length));
        sLine += STAR_DIM[di];
        bLine += " ";
      }
    }
    stars.push(sLine);
    bright.push(bLine);
  }
  return { stars: stars.join("\n"), brightStars: bright.join("\n") };
}

// The globe is rebuilt every frame for a given longitude `phase`. The light
// stays bolted to the upper-left; only the surface texture advances in
// longitude, so the planet reads as spinning under fixed light rather than
// tumbling. Each on-sphere pixel maps to true sphere coords — longitude via
// atan2(nx,nz), latitude via asin(ny) — so continents compress toward the limb
// the way a real globe's do, and glyphs shift frame to frame.
function buildGlobe(cols: number, rows: number, phase: number): Globe {
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
    let bodyLine = "";
    let rimLine = "";
    for (let col = 0; col < cols; col++) {
      const dx = (col - cx) * GLYPH_ASPECT;
      const dy = row - cy;
      const nd = Math.sqrt(dx * dx + dy * dy) / radius;

      if (nd > 1) {
        bodyLine += " ";
        rimLine += " ";
        continue;
      }

      // Reconstruct the surface normal, then shade it.
      const nx = dx / radius;
      const ny = dy / radius;
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      const light = Math.max(0, nx * Lx + ny * Ly + nz * Lz);

      // Spherical surface coords — rotate the texture in longitude only.
      const lon = Math.atan2(nx, nz) + phase;
      const lat = Math.asin(Math.max(-1, Math.min(1, ny)));
      const tex = fbm(lon * 1.7 + 4, lat * 1.7 + 7); // continents
      const relief = fbm(lon * 4.3 + 1, lat * 4.3 + 9); // mid grain
      const fine = fbm(nx * 12.0 + 3, ny * 12.0 + 6); // screen-fixed speckle
      const v = Math.max(
        0,
        Math.min(1, light * 0.78 + tex * 0.26 + relief * 0.12 + fine * 0.06 - 0.05)
      );

      // Dither the dark hemisphere so the terminator dissolves into grains
      // instead of reading as a hard-edged blob. The threshold is cell-fixed,
      // so cells flip in/out as `v` crosses it — that's the rotation reveal.
      if (hash2(col * 5 + 1, row * 5 + 1) > 0.42 + v * 0.66) {
        bodyLine += " ";
        rimLine += " ";
        continue;
      }

      const idx = Math.max(0, Math.min(SURFACE_RAMP.length - 1, Math.round(v * (SURFACE_RAMP.length - 1))));
      bodyLine += SURFACE_RAMP[idx];
      rimLine +=
        nd > 0.86 && light > 0.08
          ? SURFACE_RAMP[Math.min(SURFACE_RAMP.length - 1, idx + 3)]
          : " ";
    }
    body.push(bodyLine);
    rim.push(rimLine);
  }
  return { body: body.join("\n"), rim: rim.join("\n") };
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
  // One clock (elapsed seconds) drives everything: the globe's longitude phase
  // (clock · SPIN_RATE) and the stars' twinkle. Both rebuild per animation tick.
  const [reduceMotion, setReduceMotion] = useState(false);
  const [clock, setClock] = useState(0);
  const starfield = useMemo(
    () => buildStarfield(geometry.cols, geometry.rows, clock),
    [geometry.cols, geometry.rows, clock]
  );
  const globe = useMemo(
    () => buildGlobe(geometry.cols, geometry.rows, clock * SPIN_RATE),
    [geometry.cols, geometry.rows, clock]
  );

  // Honour the OS "reduce motion" setting — fall back to the static globe.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduceMotion(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // Throttled rAF loop: advance longitude at SPIN_RATE, regenerate the globe
  // every FRAME_MS. Uses the rAF timestamp (not Date.now) so it stays cheap and
  // pauses with the tab. `phase` is monotonic, so noise never repeats a seam.
  useEffect(() => {
    if (reduceMotion) return;
    let raf = 0;
    let last = 0;
    let acc = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (last === 0) {
        last = t;
        return;
      }
      acc += t - last;
      last = t;
      if (acc < FRAME_MS) return;
      const dt = acc / 1000;
      acc = 0;
      setClock((c) => c + dt);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [reduceMotion]);

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
            <pre className="klide-cosmos-layer is-stars">{starfield.stars}</pre>
            <pre className="klide-cosmos-layer is-bright-stars">{starfield.brightStars}</pre>
            <pre className="klide-cosmos-layer is-planet">{globe.body}</pre>
            <pre className="klide-cosmos-layer is-planet-glow">{globe.rim}</pre>
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
