// ── Pixel nature ───────────────────────────────────────────────────────────
// A looping big-pixel film for the Welcome card: dawn → forest → lake → meadow.
// Every scene is a pure function of (cell, time) drawn into a coarse grid of
// square cells with an ordered (Bayer) dither, so gradients band like print
// rather than blur. Between scenes the grid "compiles": cells flip to code
// glyphs on an ink ground, then resolve into the next landscape.
//
// No dependencies, one <canvas>, ~4k fillRects per frame at 30fps.

type Frame = {
  cols: number;
  rows: number;
  /** Width in height units (cols / rows). Shapes are drawn in square space. */
  W: number;
  /** Seconds since this scene began (keeps running through its exit). */
  t: number;
  /** Global seconds, for motion that should never reset (wind, drift). */
  T: number;
  /** Smoothed pointer parallax, −1…1. */
  px: number;
};

interface Scene {
  /** Darkest tone — the ground glyphs are drawn on when entering this scene. */
  ink: string;
  prepare(f: Frame): void;
  color(x: number, y: number): string;
}

// ── Utilities ──────────────────────────────────────────────────────────────

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const bayer = (x: number, y: number) => BAYER[((y & 3) << 2) | (x & 3)];

function hash(x: number, y: number, s = 0): number {
  let h = (x * 374761393 + y * 668265263 + s * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (t: number) => t * t * (3 - 2 * t);
const easeOut = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);

function noise1(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  return hash(i, 0, seed) + (hash(i + 1, 0, seed) - hash(i, 0, seed)) * smooth(f);
}

function fbm1(x: number, seed: number): number {
  return noise1(x, seed) * 0.57 + noise1(x * 2.1 + 3.7, seed + 1) * 0.29 + noise1(x * 4.3 + 9.1, seed + 2) * 0.14;
}

function noise2(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = smooth(x - xi);
  const v = smooth(y - yi);
  const a = hash(xi, yi, seed);
  const b = hash(xi + 1, yi, seed);
  const c = hash(xi, yi + 1, seed);
  const d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm2(x: number, y: number, seed: number): number {
  return noise2(x, y, seed) * 0.57 + noise2(x * 2.07 + 5.3, y * 2.07 + 1.9, seed + 1) * 0.29 + noise2(x * 4.1 + 2.2, y * 4.1 + 7.7, seed + 2) * 0.14;
}

/** Ordered-dither a 0…1 value onto a palette ramp. */
function pick(ramp: readonly string[], v: number, x: number, y: number): string {
  const i = clamp01(v) * (ramp.length - 1);
  const b = Math.floor(i);
  return ramp[Math.min(ramp.length - 1, b + (i - b > bayer(x, y) ? 1 : 0))];
}

/** Sprites (birds, flowers, fireflies) are stamped into a per-frame overlay. */
class Overlay {
  private map = new Map<number, string>();
  constructor(private cols = 0, private rows = 0) {}
  reset(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.map.clear();
  }
  set(x: number, y: number, c: string) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return;
    this.map.set(y * this.cols + x, c);
  }
  get(x: number, y: number) {
    return this.map.get(y * this.cols + x);
  }
}

// ── Scene 1 · Dawn over ridges ─────────────────────────────────────────────

class Dawn implements Scene {
  ink = "#1B140F";
  private sky = ["#4A2B36", "#6E3A3F", "#8C4A45", "#A8514A", "#C4703F", "#D9944A", "#E9B86A", "#F2D49A", "#F7EAD0", "#FCF7EC"];
  private ridges = [
    { base: 0.5, amp: 0.15, freq: 1.6, seed: 11, drift: 0.012, depth: 0.15, ramp: ["#D8C6A2", "#BDB592", "#A6A887", "#93A07F"] },
    { base: 0.6, amp: 0.13, freq: 2.3, seed: 23, drift: 0.022, depth: 0.35, ramp: ["#9DAE83", "#7E9670", "#6B8E5A", "#5A7B4C"] },
    { base: 0.72, amp: 0.1, freq: 3.2, seed: 37, drift: 0.04, depth: 0.65, ramp: ["#56774A", "#4A6A3E", "#3B5632", "#2F4628"] },
    { base: 0.86, amp: 0.07, freq: 4.6, seed: 51, drift: 0.07, depth: 1, ramp: ["#2C3F25", "#22311D", "#1C2818", "#151E12"] },
  ];
  private h: Float32Array[] = [];
  private f!: Frame;
  private sun = { x: 0, y: 0, r: 1 };
  private overlay = new Overlay();

  prepare(f: Frame) {
    this.f = f;
    const { cols, rows, T, px } = f;
    this.h = this.ridges.map((r) => {
      const a = new Float32Array(cols);
      for (let x = 0; x < cols; x++) {
        const X = x / rows;
        a[x] = r.base - r.amp * (fbm1(X * r.freq + T * r.drift + px * r.depth * 0.08, r.seed) - 0.45) * 2;
      }
      return a;
    });
    const rise = easeOut(f.t / 6.5);
    this.sun = { x: f.W * 0.64 - px * 0.01, y: 0.7 - 0.3 * rise, r: 0.075 };

    // Birds crossing in a loose V.
    this.overlay.reset(cols, rows);
    for (let i = 0; i < 4; i++) {
      const lead = ((T * 0.035 + i * 0.07) % 1.4) - 0.2;
      const bx = (lead + (i % 2) * 0.02) * f.W * rows;
      const by = (0.22 + i * 0.035 + 0.01 * Math.sin(T * 0.9 + i)) * rows;
      const up = Math.floor(T * 5 + i * 1.7) % 2 === 0;
      const c = "#3A2630";
      this.overlay.set(bx, by, c);
      if (up) {
        this.overlay.set(bx - 1, by - 1, c);
        this.overlay.set(bx + 1, by - 1, c);
      } else {
        this.overlay.set(bx - 1, by, c);
        this.overlay.set(bx + 1, by, c);
        this.overlay.set(bx - 2, by + 1, c);
        this.overlay.set(bx + 2, by + 1, c);
      }
    }
  }

  color(x: number, y: number): string {
    const { rows, T } = this.f;
    const X = x / rows;
    const Y = y / rows;

    for (let i = this.ridges.length - 1; i >= 0; i--) {
      const top = this.h[i][x];
      if (Y >= top) {
        const r = this.ridges[i];
        // Lit rim, darker body.
        let c = pick(r.ramp, (Y - top) / 0.22, x, y);
        // Mist pooling in the valleys above every ridge but the farthest.
        if (i > 0) {
          const fall = 1 - (Y - top) / 0.06;
          const mist = fall * (fbm1(X * 4.5 - T * 0.05 * (i + 1), 70 + i) - 0.42) * 3.2;
          if (mist > 0.72) c = "#F1E3C4";
          else if (mist > 0.45 + bayer(x, y) * 0.25) c = "#DCCFAE";
        }
        return c;
      }
    }

    const ov = this.overlay.get(x, y);
    if (ov) return ov;

    const { x: sx, y: sy, r } = this.sun;
    const d = Math.hypot(X - sx, Y - sy) / r;
    if (d < 1) return d < 0.7 ? "#FFFBF2" : pick(["#FCF1D6", "#FFFBF2"], 1 - (d - 0.7) / 0.3, x, y);
    const glow = Math.pow(Math.max(0, 1 - d / 7), 2);
    const lift = easeOut(this.f.t / 6.5) * 0.12;
    return pick(this.sky, 0.08 + Y * 0.95 + glow * 0.55 + lift, x, y);
  }
}

// ── Scene 2 · Pine forest at golden hour ───────────────────────────────────

type TreeLayer = {
  spacing: number; base: number; vary: number; scale: number;
  drift: number; depth: number; seed: number; ramp: string[];
};

class Forest implements Scene {
  ink = "#0B110A";
  private bg = ["#141D15", "#1C281C", "#283828", "#364B30", "#4F6637", "#7A8547", "#AEA35F", "#DCC985", "#F2E4AE"];
  private layers: TreeLayer[] = [
    { spacing: 0.085, base: 0.36, vary: 0.12, scale: 0.75, drift: 0.004, depth: 0.25, seed: 3, ramp: ["#5D7247", "#526840", "#475D39"] },
    { spacing: 0.12, base: 0.26, vary: 0.14, scale: 1.0, drift: 0.008, depth: 0.55, seed: 7, ramp: ["#2D3F25", "#273720", "#212F1B"] },
    { spacing: 0.2, base: 0.08, vary: 0.12, scale: 1.45, drift: 0.014, depth: 1, seed: 13, ramp: ["#141D11", "#10180E", "#0C120A"] },
  ];
  private f!: Frame;
  private overlay = new Overlay();

  prepare(f: Frame) {
    this.f = f;
    const { cols, rows, T, t, W } = f;
    this.overlay.reset(cols, rows);
    // Fireflies wake up as the light drops.
    const wake = clamp01((t - 1.2) / 2.5);
    for (let i = 0; i < 26; i++) {
      if (hash(i, 1, 41) > wake) continue;
      const X = hash(i, 2, 41) * W + 0.04 * Math.sin(T * (0.3 + hash(i, 3, 41) * 0.5) + i);
      const Y = 0.5 + hash(i, 4, 41) * 0.4 + 0.03 * Math.cos(T * (0.4 + hash(i, 5, 41) * 0.4) + i * 2);
      const b = Math.sin(T * (1.4 + hash(i, 6, 41) * 2.2) + i * 5);
      if (b < 0.1) continue;
      const cx = X * rows;
      const cy = Y * rows;
      this.overlay.set(cx, cy, b > 0.6 ? "#FBF3B8" : "#D8CF78");
      if (b > 0.75) {
        const halo = "#8C8A45";
        this.overlay.set(cx + 1, cy, halo);
        this.overlay.set(cx - 1, cy, halo);
        this.overlay.set(cx, cy + 1, halo);
        this.overlay.set(cx, cy - 1, halo);
      }
    }
  }

  private tree(L: TreeLayer, X: number, Y: number, x: number, y: number): string | null {
    const { T, px } = this.f;
    const shift = T * L.drift + px * L.depth * 0.02;
    const k0 = Math.floor((X + shift) / L.spacing);
    for (let k = k0 - 1; k <= k0 + 1; k++) {
      const cx = (k + 0.2 + hash(k, 0, L.seed) * 0.6) * L.spacing - shift;
      const top = L.base + hash(k, 1, L.seed) * L.vary;
      const dy = Y - top;
      if (dy < 0) continue;
      const s = L.scale * (0.85 + hash(k, 2, L.seed) * 0.3);
      // Sway grows toward the tip.
      const sway = Math.sin(T * 0.9 + k * 1.7) * 0.006 * Math.max(0, 1 - dy / 0.6) * s;
      const du = Math.abs(X - cx - sway);
      const tier = 0.055 * s;
      const n = Math.floor(dy / tier);
      const frac = (dy % tier) / tier;
      const half = (0.008 + n * 0.0065 + frac * 0.018) * s;
      if (du < half) return pick(L.ramp, du / half + (X > cx ? 0.35 : 0), x, y);
      if (du < 0.006 * s && dy > tier * 6) return L.ramp[2];
    }
    return null;
  }

  color(x: number, y: number): string {
    const { rows, T, t } = this.f;
    const X = x / rows;
    const Y = y / rows;

    const ov = this.overlay.get(x, y);
    if (ov) return ov;
    if (Y > 0.93) return pick(["#1A2416", "#0C120A"], (Y - 0.93) / 0.07 + hash(x, 9, 2) * 0.3, x, y);
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const c = this.tree(this.layers[i], X, Y, x, y);
      if (c) return c;
    }

    // Warm haze low in the trees, dimming over the scene; shafts of light.
    const dusk = clamp01(t / 7) * 0.14;
    const shaft = Math.max(0, Math.sin((X * 1.0 - Y * 0.5) * 12 + T * 0.25)) * 0.2 * (1.1 - Y);
    return pick(this.bg, 1.05 - Math.abs(Y - 0.7) * 1.25 + shaft - dusk, x, y);
  }
}

// ── Scene 3 · Lake at blue hour ────────────────────────────────────────────

class Lake implements Scene {
  ink = "#080B12";
  private sky = ["#0E131F", "#151C2B", "#1D2738", "#283549", "#384A61", "#506680", "#7489A0", "#A3B3BD", "#CBD3D2"];
  private dim = new Map<string, string>();
  private H = 0.58;
  private f!: Frame;
  private hills = new Float32Array(0);
  private overlay = new Overlay();
  private moon = { x: 0, y: 0, r: 0.055 };

  constructor() {
    // Reflections sit one step darker than what they mirror.
    const all = [...this.sky, "#F7F4ED", "#E2DED2", "#0B1018", "#121A26", "#E9B86A"];
    const lower = ["#0B0F19", "#0E131F", "#151C2B", "#1D2738", "#283549", "#384A61", "#506680", "#7489A0", "#A3B3BD", "#CBD3D2", "#B9B7AE", "#080B12", "#0B1018", "#B5832E"];
    all.forEach((c, i) => this.dim.set(c, lower[i] ?? c));
  }

  prepare(f: Frame) {
    this.f = f;
    const { cols, rows, T, t, W, px } = f;
    this.hills = new Float32Array(cols);
    for (let x = 0; x < cols; x++) {
      this.hills[x] = this.H - 0.03 - 0.08 * fbm1((x / rows) * 2.6 + 40 + px * 0.03, 91);
    }
    this.moon = { x: W * 0.28 - px * 0.01, y: 0.17 + 0.02 * (1 - easeOut(t / 6)), r: 0.055 };

    this.overlay.reset(cols, rows);
    // Reeds at both edges, bending with the wind.
    for (let i = 0; i < 18; i++) {
      const left = i < 10;
      const X = left ? hash(i, 0, 5) * 0.16 : W - hash(i, 0, 5) * 0.14;
      const len = (0.1 + hash(i, 1, 5) * 0.16) * rows;
      const bend = Math.sin(T * 1.1 + i * 0.8) * 2.2;
      const x0 = X * rows;
      for (let s = 0; s < len; s++) {
        const p = s / len;
        this.overlay.set(x0 + bend * p * p, rows - 1 - s, "#05080D");
      }
      if (hash(i, 2, 5) > 0.5) {
        const tx = x0 + bend;
        const ty = rows - 1 - len;
        this.overlay.set(tx, ty, "#2A1E18");
        this.overlay.set(tx, ty - 1, "#2A1E18");
      }
    }
    // One warm window across the water.
    const hx = Math.floor(W * 0.72 * rows);
    if (hx < cols) {
      const hy = Math.floor(this.hills[hx] * rows) + 1;
      const on = Math.sin(T * 0.5) > -0.85;
      if (on) this.overlay.set(hx, hy, "#E9B86A");
    }
  }

  private above(x: number, y: number): string {
    const { rows, T } = this.f;
    const X = x / rows;
    const Y = y / rows;
    const ov = this.overlay.get(x, y);
    if (ov && Y < this.H) return ov;
    const hx = Math.max(0, Math.min(this.hills.length - 1, x));
    if (Y >= this.hills[hx]) return pick(["#121A26", "#0B1018"], (Y - this.hills[hx]) / 0.05, x, y);

    const { x: mx, y: my, r } = this.moon;
    const d = Math.hypot(X - mx, Y - my) / r;
    if (d < 1) return hash(x, y, 77) > 0.86 ? "#E2DED2" : "#F7F4ED";
    let v = Math.pow(Y / this.H, 1.25) * 0.8 + Math.pow(Math.max(0, 1 - d / 4), 2) * 0.35;
    if (v < 0.45 && hash(x, y, 7) > 0.986) return Math.sin(T * 2.5 + hash(x, y, 8) * 30) > 0 ? "#F7F4ED" : "#7489A0";
    return pick(this.sky, v, x, y);
  }

  color(x: number, y: number): string {
    const { rows, T } = this.f;
    const Y = y / rows;
    const X = x / rows;
    if (Y < this.H) return this.above(x, y);

    const ov = this.overlay.get(x, y);
    if (ov) return ov;

    const depth = Y - this.H;
    const wob = Math.round(Math.sin(y * 0.9 - T * 2.0) * depth * 9 + Math.sin(y * 2.3 + T * 1.3) * depth * 4);
    // Moon path: a shimmering column under the moon.
    const { x: mx, r } = this.moon;
    if (Math.abs(X - mx) < r * (0.4 + depth * 3) && hash(x + wob, y, Math.floor(T * 7)) > 0.55 - depth) {
      return hash(x, y, 3) > 0.5 ? "#E2DED2" : "#A3B3BD";
    }
    // Expanding ring where a fish broke the surface.
    const ring = (T % 4.2) / 4.2;
    const rd = Math.hypot((X - this.f.W * 0.62) * 0.35, Y - (this.H + 0.22)) * 3;
    if (Math.abs(rd - ring * 0.5) < 0.012 && ring < 0.9) return "#7489A0";

    const my = Math.floor((2 * this.H - Y) * rows);
    const src = this.above(Math.max(0, x + wob), Math.max(0, my));
    if ((y + Math.floor(T * 3)) % 7 === 0 && Math.sin(x * 0.4 + T) > 0.6) return "#506680";
    return this.dim.get(src) ?? src;
  }
}

// ── Scene 4 · Meadow in bloom ──────────────────────────────────────────────

class Meadow implements Scene {
  ink = "#16200F";
  private sky = ["#93B3B6", "#A9C3C4", "#BCD1CC", "#CFDDD3", "#E1E8DC", "#EFEFE3", "#F7F4ED"];
  private grass = ["#8FAE68", "#7FA05F", "#6B8E5A", "#5A7B4C", "#3F5A34", "#2E4426"];
  private petals = ["#E9B86A", "#A8514A", "#F7F4ED", "#D9944A", "#C98FA0", "#F2D49A"];
  private f!: Frame;
  private ground = new Float32Array(0);
  private far = new Float32Array(0);
  private mid = new Float32Array(0);
  private overlay = new Overlay();

  prepare(f: Frame) {
    this.f = f;
    const { cols, rows, T, t, W, px } = f;
    this.ground = new Float32Array(cols);
    this.far = new Float32Array(cols);
    this.mid = new Float32Array(cols);
    for (let x = 0; x < cols; x++) {
      const X = x / rows;
      this.far[x] = 0.5 - 0.1 * fbm1(X * 1.8 + 20 + px * 0.02, 61);
      this.mid[x] = 0.62 - 0.09 * fbm1(X * 2.4 + 5 + px * 0.05, 62);
      // Blades: sample a neighbour column shifted by the gust so the edge waves.
      const gust = Math.round(Math.sin(T * 1.7 + X * 5) * 1.4 + Math.sin(T * 0.6 + X * 2) * 0.8);
      const bx = x + gust;
      this.ground[x] = 0.8 - 0.035 * fbm1(X * 3 + px * 0.08, 63) - hash(bx, 0, 64) * 0.045;
    }

    this.overlay.reset(cols, rows);
    const count = Math.max(10, Math.round(cols / 4.5));
    for (let i = 0; i < count; i++) {
      const fx = Math.floor(((i + 0.5 + (hash(i, 0, 9) - 0.5) * 0.8) / count) * cols);
      if (fx < 0 || fx >= cols) continue;
      const born = 0.3 + hash(i, 1, 9) * 3.6;
      const grow = clamp01((t - born) / 1.1);
      if (grow <= 0) continue;
      const base = Math.floor(this.ground[fx] * rows) + 2 + Math.floor(hash(i, 2, 9) * 5);
      const len = Math.round((4 + hash(i, 3, 9) * 7) * easeOut(grow));
      const lean = Math.sin(T * 1.7 + (fx / rows) * 5) * 1.3;
      let tx = fx;
      let ty = base;
      for (let s = 0; s < len; s++) {
        const p = s / Math.max(1, len);
        tx = fx + lean * p * p;
        ty = base - s;
        this.overlay.set(tx, ty, s === Math.floor(len / 2) && hash(i, 4, 9) > 0.5 ? "#7FA05F" : "#4C6B3E");
      }
      const bloom = clamp01((t - born - 1.0) / 0.5);
      if (bloom <= 0) continue;
      const petal = this.petals[Math.floor(hash(i, 5, 9) * this.petals.length)];
      const big = hash(i, 6, 9) > 0.55;
      const cy = ty - 1;
      this.overlay.set(tx, cy, bloom < 0.4 ? petal : "#B5832E");
      if (bloom >= 0.4) {
        this.overlay.set(tx - 1, cy, petal);
        this.overlay.set(tx + 1, cy, petal);
        this.overlay.set(tx, cy - 1, petal);
        this.overlay.set(tx, cy + 1, petal);
      }
      if (big && bloom >= 0.9) {
        this.overlay.set(tx - 1, cy - 1, petal);
        this.overlay.set(tx + 1, cy - 1, petal);
        this.overlay.set(tx - 1, cy + 1, petal);
        this.overlay.set(tx + 1, cy + 1, petal);
      }
    }

    // A butterfly working the flowers.
    const bxN = (0.5 + 0.38 * Math.sin(T * 0.23)) * W;
    const byN = 0.6 + 0.08 * Math.sin(T * 0.61) + 0.02 * Math.sin(T * 3.1);
    const bx = bxN * rows;
    const by = byN * rows;
    const open = Math.floor(T * 7) % 2 === 0;
    this.overlay.set(bx, by, "#1C1C1C");
    if (open) {
      for (const [dx, dy] of [[-1, 0], [1, 0], [-1, -1], [1, -1], [-2, -1], [2, -1]]) this.overlay.set(bx + dx, by + dy, "#E9B86A");
    } else {
      this.overlay.set(bx, by - 1, "#D9944A");
    }
  }

  color(x: number, y: number): string {
    const { rows, T } = this.f;
    const X = x / rows;
    const Y = y / rows;

    const ov = this.overlay.get(x, y);
    if (ov) return ov;

    const g = this.ground[x];
    if (Y >= g) return pick(this.grass, (Y - g) / 0.2 + (hash(x, y, 4) - 0.5) * 0.12, x, y);
    const m = this.mid[x];
    if (Y >= m) {
      // Ploughed field bands following the hill.
      const band = Math.floor((Y - m) * rows * 0.5 + X * 3) % 3;
      return band === 0 ? "#7FA05F" : pick(["#8FA472", "#6B8E5A"], (Y - m) / 0.12, x, y);
    }
    if (Y >= this.far[x]) return pick(["#C3CDA6", "#ADBE8E", "#9DB07F"], (Y - this.far[x]) / 0.1, x, y);

    // Clouds: two-tone, flat-bottomed, drifting.
    const c = fbm2(X * 2.4 - T * 0.035, Y * 6.5, 33) - Y * 0.55;
    if (c > 0.36) return c > 0.41 ? "#FCFBF8" : "#E6E4DA";
    return pick(this.sky, Y / 0.55, x, y);
  }
}

// ── Engine ─────────────────────────────────────────────────────────────────

export type PixelNatureOptions = {
  /** Target cell size in CSS pixels. Bigger = chunkier. */
  cell?: number;
  /** Seconds each landscape holds. */
  sceneSeconds?: number;
  /** Seconds the code-glyph transition takes. */
  transitionSeconds?: number;
  /** Render one still frame and stop (prefers-reduced-motion). */
  still?: boolean;
};

const GLYPHS = "{}[]<>()/=+*;:#01fnletmutpub&|~$";
const FRAME_MS = 1000 / 30;

export function createPixelNature(canvas: HTMLCanvasElement, opts: PixelNatureOptions = {}) {
  const ctx = canvas.getContext("2d", { alpha: false })!;
  const scenes: Scene[] = [new Dawn(), new Forest(), new Lake(), new Meadow()];
  const HOLD = opts.sceneSeconds ?? 7.5;
  const TRANS = opts.transitionSeconds ?? 1.7;
  const cellCss = opts.cell ?? 13;

  let cols = 0;
  let rows = 0;
  let cs = 1; // cell size in device px
  let ox = 0;
  let oy = 0;
  let clock = 0;
  let raf = 0;
  let last = 0;
  let acc = 0;
  let still = !!opts.still;
  let px = 0;
  let pxTarget = 0;

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    canvas.width = w;
    canvas.height = h;
    // Keep cells chunky on small cards, integer-sized so edges stay crisp.
    const target = Math.max(8, Math.min(cellCss, canvas.clientWidth / 40));
    cs = Math.max(2, Math.round(target * dpr));
    cols = Math.ceil(w / cs);
    rows = Math.ceil(h / cs);
    ox = Math.floor((w - cols * cs) / 2);
    oy = Math.floor((h - rows * cs) / 2);
    ctx.imageSmoothingEnabled = false;
    if (still) draw();
  }

  function frameFor(t: number): Frame {
    return { cols, rows, W: cols / rows, t, T: clock, px };
  }

  function draw() {
    if (!cols) return;
    // Intro: the first scene compiles out of ink, same as every cut after it.
    const n = scenes.length;
    const idx = Math.floor(clock / HOLD) % n;
    const t = clock % HOLD;
    const cur = scenes[idx];
    const inTrans = t < TRANS && !still;
    const intro = clock < HOLD;
    const prev = intro ? null : scenes[(idx - 1 + n) % n];

    cur.prepare(frameFor(t));
    if (inTrans && prev) prev.prepare(frameFor(t + HOLD));

    const p = inTrans ? t / TRANS : 1;
    const sweep = idx % 2 === 0; // alternate the wipe direction per cut
    const glyphSeed = Math.floor(clock * 14);
    ctx.font = `${Math.round(cs * 0.86)}px "Monaspace Neon", "SF Mono", ui-monospace, Menlo, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    let fill = "";
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        let c: string;
        let glyph: string | null = null;
        if (p >= 1) {
          c = cur.color(x, y);
        } else {
          const dir = sweep ? x / cols : 1 - x / cols;
          // Mostly a directional sweep, roughened by noise so the front is ragged.
          const k = clamp01(0.32 * hash(x, y, 99) + 0.68 * (dir * 0.8 + (y / rows) * 0.2));
          const q = (p * 1.25 - k) / 0.25;
          if (q <= 0) {
            c = prev ? prev.color(x, y) : cur.ink;
          } else if (q >= 1) {
            c = cur.color(x, y);
          } else {
            c = cur.ink;
            glyph = cur.color(x, y);
          }
        }
        if (c !== fill) {
          ctx.fillStyle = c;
          fill = c;
        }
        ctx.fillRect(ox + x * cs, oy + y * cs, cs, cs);
        if (glyph) {
          ctx.fillStyle = glyph;
          fill = glyph;
          const ch = GLYPHS[Math.floor(hash(x, y, glyphSeed) * GLYPHS.length)];
          ctx.fillText(ch, ox + x * cs + cs / 2, oy + y * cs + cs / 2 + 0.5);
        }
      }
    }
  }

  function loop(ts: number) {
    raf = requestAnimationFrame(loop);
    if (!last) {
      last = ts;
      return;
    }
    const dt = Math.min(100, ts - last);
    last = ts;
    acc += dt;
    if (acc < FRAME_MS) return;
    clock += acc / 1000;
    acc = 0;
    px += (pxTarget - px) * 0.08;
    draw();
  }

  function onPointer(e: PointerEvent) {
    const r = canvas.getBoundingClientRect();
    pxTarget = Math.max(-1, Math.min(1, ((e.clientX - (r.left + r.width / 2)) / Math.max(1, window.innerWidth / 2)) * 1.4));
  }

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  function start() {
    if (raf) return;
    if (still) {
      // A finished meadow: every flower open.
      clock = HOLD * 3 + 6.5;
      resize();
      draw();
      return;
    }
    last = 0;
    window.addEventListener("pointermove", onPointer, { passive: true });
    raf = requestAnimationFrame(loop);
  }

  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
    window.removeEventListener("pointermove", onPointer);
  }

  function setStill(v: boolean) {
    stop();
    still = v;
    start();
  }

  resize();
  return {
    start,
    stop,
    setStill,
    /** Jump to a point in the loop and redraw — handy for stills and tests. */
    seek(seconds: number) {
      clock = Math.max(0, seconds);
      draw();
    },
    destroy() {
      stop();
      ro.disconnect();
    },
  };
}
