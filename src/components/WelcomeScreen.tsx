import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

type Props = {
  recentFolders: string[];
  onOpenFolder: () => void;
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
  "--cosmos-top": string;
  "--earth-sink": string;
  "--earth-glow-top": string;
  "--earth-glow-width": string;
  "--earth-glow-height": string;
};

// ── ASCII earth / sky ────────────────────────────────────────────────────
// A procedural starfield, a faint diagonal Milky Way band, and a low curved
// earth horizon. The layers are separate so the sky can stay dense while the
// planet remains a clean bottom band instead of scattered punctuation.

const ROWS = 64;
const MIN_COLS = 176;
const MAX_COLS = 284;
const GALAXY_RAMP = ".,:;-=+xX8"; // soft dust, no heavy land glyphs
const EARTH_WATER = "--==++xx";
const EARTH_LAND = "xX80S#@";
const EARTH_CLOUD = "+xX80S#@@";
const SKY_GLYPHS = "--==++xxX80S#@";
const BRIGHT_SKY_GLYPHS = "xX80S#@";

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

type Cosmos = {
  cols: number;
  rows: number;
  horizonRow: number;
  earth: string;
  earthGlow: string;
  galaxy: string;
  stars: string;
  brightStars: string;
};

function buildCosmos(cols: number, rows = ROWS): Cosmos {
  const earth: string[] = [];
  const earthGlow: string[] = [];
  const galaxy: string[] = [];
  const stars: string[] = [];
  const brightStars: string[] = [];
  const cx = cols / 2;
  const horizonRow = rows * 0.7;

  for (let row = 0; row < rows; row++) {
    let eLine = "";
    let egLine = "";
    let gLine = "";
    let sLine = "";
    let bLine = "";
    for (let col = 0; col < cols; col++) {
      const x = col / (cols - 1);
      const y = row / (rows - 1);
      const curveX = (col - cx) / (cols * 0.58);
      const horizon = horizonRow + curveX * curveX * rows * 0.42;

      if (row < horizon) {
        // Sparse ASCII starfield: isolated characters, not a mist of dots.
        const starNoise = hash2(col * 7 + 3, row * 11 + 5);
        const bluePocket = fbm(x * 8 + 20, y * 8 + 4);
        const starDensity = 0.016 + (bluePocket > 0.76 ? 0.018 : 0);
        if (starNoise < starDensity) {
          const bright = hash2(col * 17 + 2, row * 19 + 9);
          const glyph = SKY_GLYPHS[Math.floor(hash2(col, row) * SKY_GLYPHS.length)];
          if (bright < 0.2) {
            bLine += BRIGHT_SKY_GLYPHS[Math.floor(hash2(col + 5, row + 3) * BRIGHT_SKY_GLYPHS.length)];
            sLine += " ";
          } else {
            sLine += glyph;
            bLine += " ";
          }
        } else {
          sLine += " ";
          bLine += " ";
        }

        // Milky Way: broad diagonal cloud on the right side, matching the
        // reference while keeping the Klide wordmark area quiet.
        // broken up with noise so it reads as dust rather than a stripe.
        const band = Math.abs(y - (0.02 + (1 - x) * 0.78));
        const rightWeight = Math.max(0, Math.min(1, (x - 0.48) / 0.46));
        const width = 0.07 + 0.07 * rightWeight;
        const cloud = Math.max(0, 1 - band / width) * rightWeight;
        const dust = fbm(x * 18 + 9, y * 18 + 12);
        if (cloud > 0.08 && dust + cloud * 0.76 > 0.78) {
          const val = Math.max(0, Math.min(1, cloud * 0.8 + dust * 0.35));
          gLine += GALAXY_RAMP[Math.min(GALAXY_RAMP.length - 1, Math.floor(val * GALAXY_RAMP.length))];
        } else {
          gLine += " ";
        }

        eLine += " ";
        egLine += " ";
        continue;
      }

      sLine += " ";
      bLine += " ";
      gLine += " ";

      // Earth surface: low curved band with ocean/land/cloud texture. Denser
      // than the sky so it reads as a surface, not loose stars.
      const depth = Math.max(0, Math.min(1, (row - horizon) / Math.max(1, rows - horizon)));
      const land = fbm(x * 6.6 + 8, depth * 5.0 + 8);
      const relief = fbm(x * 19 + 2, depth * 14 + 11);
      const clouds = fbm(x * 18 + 1, depth * 9 + 30);
      const isCloud = clouds > 0.73 && depth < 0.82;
      const isLand = land > 0.52;
      const rimBoost = Math.max(0, 1 - depth * 4);
      const density =
        0.42 +
        depth * 0.5 +
        rimBoost * 0.18 +
        (isLand ? 0.12 : 0) +
        (isCloud ? 0.22 : 0);
      if (hash2(col * 5 + 1, row * 5 + 1) > density) {
        eLine += " ";
        egLine += " ";
        continue;
      }

      const palette = isCloud ? EARTH_CLOUD : isLand ? EARTH_LAND : EARTH_WATER;
      const val = Math.max(
        0,
        Math.min(
          1,
          depth * 0.42 +
            relief * 0.24 +
            (isLand ? land * 0.28 : land * 0.12) +
            (isCloud ? clouds * 0.36 : 0)
        )
      );
      const idx = Math.max(0, Math.min(palette.length - 1, Math.floor(val * palette.length)));
      const ch = palette[idx];
      eLine += ch;
      egLine += depth < 0.38 || isCloud ? ch : " ";
    }
    earth.push(eLine);
    earthGlow.push(egLine);
    galaxy.push(gLine);
    stars.push(sLine);
    brightStars.push(bLine);
  }

  return {
    cols,
    rows,
    horizonRow,
    earth: earth.join("\n"),
    earthGlow: earthGlow.join("\n"),
    galaxy: galaxy.join("\n"),
    stars: stars.join("\n"),
    brightStars: brightStars.join("\n"),
  };
}

export function WelcomeScreen({
  recentFolders,
  onOpenFolder,
  onOpenRecent,
  onRemoveRecent,
  onOpenSettings,
}: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [surface, setSurface] = useState({ width: 1280, height: 720 });
  const recents = recentFolders.slice(0, MAX_RECENTS);
  const cols = useMemo(() => {
    const aspect = Math.max(1.25, Math.min(3.2, surface.width / Math.max(1, surface.height)));
    const fitCols = Math.round((ROWS * aspect) / 0.62);
    return Math.max(MIN_COLS, Math.min(MAX_COLS, fitCols));
  }, [surface]);
  const cosmos = useMemo(() => buildCosmos(cols), [cols]);

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

  const cosmosGeometry = useMemo(() => {
    const width = Math.max(320, surface.width);
    const height = Math.max(320, surface.height);
    // Monaspace's rendered glyph width is roughly 0.62em. Fit the whole
    // generated text canvas inside the actual welcome surface, then anchor the
    // bottom of the ASCII planet to the bottom of the available surface.
    const font = Math.max(
      5.2,
      Math.min(36, (width * 0.995) / (cosmos.cols * 0.62), (height * 0.995) / cosmos.rows)
    );
    const stageHeight = cosmos.rows * font;
    const stageWidth = cosmos.cols * font * 0.62;
    const top = Math.max(0, height - stageHeight);
    const earthSink = Math.min(font * 3.1, height * 0.065);
    const horizonTop = top + earthSink + font * cosmos.horizonRow;
    return {
      vars: {
        "--cosmos-font": `${font}px`,
        "--cosmos-top": `${top}px`,
        "--earth-sink": `${earthSink}px`,
        "--earth-glow-top": `${Math.max(0, horizonTop - height * 0.085)}px`,
        "--earth-glow-width": `${Math.min(stageWidth * 1.2, width * 1.32)}px`,
        "--earth-glow-height": `${Math.max(170, Math.min(height * 0.38, stageHeight * 0.56))}px`,
      } satisfies WelcomeVars,
    };
  }, [surface, cosmos]);

  // ⌘1–⌘5 open a recent folder directly.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= Math.min(recentFolders.length, MAX_RECENTS)) {
        e.preventDefault();
        onOpenRecent(recentFolders[n - 1]);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recentFolders, onOpenRecent]);

  return (
    <div
      ref={rootRef}
      className="klide-welcome"
      style={{
        ...cosmosGeometry.vars,
        flex: 1,
        minHeight: 0,
        position: "relative",
        overflow: "hidden",
        display: "flex",
      }}
    >
      {/* ASCII cosmos backdrop */}
      <div className="klide-welcome-cosmos" aria-hidden>
        <div className="klide-cosmos-glow" />
        <pre className="klide-cosmos-layer is-galaxy">{cosmos.galaxy}</pre>
        <pre className="klide-cosmos-layer is-stars">{cosmos.stars}</pre>
        <pre className="klide-cosmos-layer is-bright-stars">{cosmos.brightStars}</pre>
        <pre className="klide-cosmos-layer is-earth">{cosmos.earth}</pre>
        <pre className="klide-cosmos-layer is-earth-glow">{cosmos.earthGlow}</pre>
      </div>

      {/* Content — left-aligned, top-anchored */}
      <div
        style={{
          position: "relative",
          zIndex: 1,
          padding: "clamp(84px, 15cqh, 150px) clamp(28px, 7.4cqw, 128px)",
          width: "min(620px, 92cqw)",
        }}
      >
        {/* Wordmark */}
        <div
          className="klide-welcome-rise"
          style={{
            ...rise(0),
            fontSize: "clamp(40px, 4.2cqw, 64px)",
            lineHeight: 1,
            color: "var(--w-fg)",
            fontWeight: 600,
            letterSpacing: "-0.03em",
          }}
        >
          Klide
        </div>

        {/* Actions */}
        <div
          className="klide-welcome-rise"
          style={{ ...rise(80), display: "flex", flexWrap: "wrap", gap: 12, marginTop: 30 }}
        >
          <button
            type="button"
            onClick={onOpenFolder}
            className="klide-welcome-glass-btn"
            data-primary="true"
          >
            <FolderIcon />
            Open folder
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            className="klide-welcome-glass-btn"
          >
            <SettingsIcon />
            Settings
          </button>
        </div>

        {/* Recent */}
        <section className="klide-welcome-rise" style={{ ...rise(150), marginTop: 48 }}>
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

function SettingsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
