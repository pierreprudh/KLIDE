// ── Pixel nature ───────────────────────────────────────────────────────────
// A looping big-pixel film for the Welcome screen, nine landscapes —
//   dawn, forest, lake, under the surface, meadow,
//   autumn temple, Fuji at dawn, moonsea, karst valley —
// dealt in a fresh order every time the film is created (see `order`).
// Each scene is a pure function of (cell, time) returning an RGB int, written
// into a tiny cols×rows buffer, then scaled up crisp. A tile texture (hairline
// seams) and a drifting film grain sit on top, so cells read as mosaic tiles.
// Between scenes the grid "compiles": cells flip to code glyphs on ink, then
// resolve into the next landscape.

type Frame = {
  cols: number;
  rows: number;
  /** Width in height units (cols / rows). Shapes are laid out in square space. */
  W: number;
  /** Seconds since this scene began (keeps running through its exit). */
  t: number;
  /** Global seconds, for motion that should never reset. */
  T: number;
  /** Smoothed pointer parallax, −1…1. */
  px: number;
};

interface Scene {
  ink: number;
  prepare(f: Frame): void;
  color(x: number, y: number): number;
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

function noise1(x: number, s: number): number {
  const i = Math.floor(x);
  const a = hash(i, 0, s);
  return a + (hash(i + 1, 0, s) - a) * smooth(x - i);
}

function fbm1(x: number, s: number): number {
  return noise1(x, s) * 0.55 + noise1(x * 2.1 + 3.7, s + 1) * 0.28 + noise1(x * 4.3 + 9.1, s + 2) * 0.12 + noise1(x * 8.7 + 1.3, s + 3) * 0.05;
}

function noise2(x: number, y: number, s: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = smooth(x - xi);
  const v = smooth(y - yi);
  const a = hash(xi, yi, s);
  const b = hash(xi + 1, yi, s);
  const c = hash(xi, yi + 1, s);
  const d = hash(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm2(x: number, y: number, s: number): number {
  return noise2(x, y, s) * 0.57 + noise2(x * 2.07 + 5.3, y * 2.07 + 1.9, s + 1) * 0.29 + noise2(x * 4.1 + 2.2, y * 4.1 + 7.7, s + 2) * 0.14;
}

const hx = (s: string) => parseInt(s.slice(1), 16);
const R = (...cs: string[]) => cs.map(hx);

function mix(a: number, b: number, t: number): number {
  t = clamp01(t);
  const ar = a >> 16, ag = (a >> 8) & 255, ab = a & 255;
  const r = ar + ((b >> 16) - ar) * t;
  const g = ag + (((b >> 8) & 255) - ag) * t;
  const bl = ab + ((b & 255) - ab) * t;
  return ((r & 255) << 16) | ((g & 255) << 8) | (bl & 255);
}

/** Ordered-dither a 0…1 value onto a palette ramp. */
function pick(ramp: readonly number[], v: number, x: number, y: number): number {
  const i = clamp01(v) * (ramp.length - 1);
  const b = Math.floor(i);
  return ramp[Math.min(ramp.length - 1, b + (i - b > bayer(x, y) ? 1 : 0))];
}

/** Sprites (birds, fish, flowers…) stamped into a per-frame layer. */
class Overlay {
  private buf = new Int32Array(0);
  private cols = 0;
  private rows = 0;
  reset(cols: number, rows: number) {
    if (this.buf.length !== cols * rows) this.buf = new Int32Array(cols * rows);
    this.cols = cols;
    this.rows = rows;
    this.buf.fill(-1);
  }
  set(x: number, y: number, c: number) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return;
    this.buf[y * this.cols + x] = c;
  }
  get(x: number, y: number) {
    return this.buf[y * this.cols + x];
  }
}

// ── 1 · Dawn over ridges, a lake below ─────────────────────────────────────

class Dawn implements Scene {
  ink = hx("#1B140F");
  private sky = R("#3E2433", "#58303B", "#723B40", "#8E4744", "#A8574A", "#C06A45", "#D4833F", "#E19D4C", "#EBB666", "#F2CD8C", "#F7E2B6", "#FBF0D8", "#FFF8EA");
  private cloud = R("#6B3644", "#9A5049", "#D0794A", "#F0AE66", "#FAD9A0");
  private bases = [0.47, 0.54, 0.61, 0.68, 0.745];
  private cols: number[] = [];
  private tops: Float32Array[] = [];
  private shore = new Float32Array(0);
  private ov = new Overlay();
  private f!: Frame;
  private sun = { x: 0, y: 0, r: 0.085 };
  private WATER = 0.8;

  constructor() {
    const haze = hx("#E6C39E");
    const deep = hx("#17221A");
    this.cols = this.bases.map((_, i) => {
      const d = i / (this.bases.length - 1);
      return mix(mix(haze, deep, Math.pow(d, 1.35)), hx("#5A7B4C"), 0.35 * Math.sin(d * Math.PI));
    });
  }

  prepare(f: Frame) {
    this.f = f;
    const { cols, rows, T, t, W, px } = f;
    this.tops = this.bases.map((base, i) => {
      const shift = Math.floor(T * (0.12 + i * 0.3) + px * (1 + i * 1.5));
      const orig = new Float32Array(cols);
      for (let x = 0; x < cols; x++) {
        const X = (x + shift) / rows;
        orig[x] = base - (0.14 - i * 0.012) * (fbm1(X * (1 + i * 0.55) + i * 13, 11 + i * 7) - 0.45) * 2;
      }
      const top = Float32Array.from(orig);
      if (i >= 2) {
        for (let x = 0; x < cols; x++) {
          const wx = x + shift;
          if (hash(wx, i, 5) <= 0.66) continue;
          const th = Math.floor(1 + hash(wx, i, 6) * (0.5 + i * 0.55));
          for (let dx = -th; dx <= th; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= cols) continue;
            top[xx] = Math.min(top[xx], orig[x] - Math.max(0, th * 1.3 - Math.abs(dx) * 1.5) / rows);
          }
        }
      }
      return top;
    });
    this.shore = new Float32Array(cols);
    for (let x = 0; x < cols; x++) {
      const X = x / rows;
      const l = Math.max(0, 1 - X / (0.16 * W));
      const r = Math.max(0, (X - 0.86 * W) / (0.14 * W));
      const edge = l + r > 0 ? (fbm1(X * 3, 99) - 0.5) * 0.3 : 0;
      this.shore[x] = this.WATER + 0.25 - 0.25 * Math.min(1, (l + r) * 1.4 + edge);
    }
    const rise = easeOut(t / 7);
    this.sun = { x: W * 0.62 - px * 0.01, y: 0.6 - 0.2 * rise, r: 0.085 };

    this.ov.reset(cols, rows);
    const lead = (((T * 0.028 + 0.35) % 1.5) - 0.25) * W;
    const flock: [number, number][] = [[0, 0], [-0.05, 0.03], [0.06, 0.035], [-0.1, 0.06], [0.11, 0.07]];
    flock.forEach(([dx, dy], i) => {
      const bx = (lead + dx) * rows;
      const by = (0.2 + dy + 0.008 * Math.sin(T * 0.8 + i)) * rows;
      const up = Math.floor(T * 4 + i * 1.3) % 2 === 0;
      const c = hx("#3A2430");
      this.ov.set(bx, by, c);
      if (up) {
        this.ov.set(bx - 1, by - 1, c);
        this.ov.set(bx + 1, by - 1, c);
      } else {
        this.ov.set(bx - 1, by, c);
        this.ov.set(bx + 1, by, c);
        this.ov.set(bx - 2, by + 1, c);
        this.ov.set(bx + 2, by + 1, c);
      }
    });
  }

  private above(x: number, y: number): number {
    const { rows, T } = this.f;
    const X = x / rows;
    const Y = y / rows;
    const { x: SX, y: SY, r: SR } = this.sun;
    for (let i = this.bases.length - 1; i >= 0; i--) {
      const top = this.tops[i][x];
      if (Y < top) continue;
      const d = i / (this.bases.length - 1);
      const c = this.cols[i];
      let col = pick([mix(c, 0xfff0d2, 0.22 * (1 - d)), c, mix(c, 0x0a0e08, 0.25)], (Y - top) / (0.09 + 0.05 * d), x, y);
      if (Y - top < 1.2 / rows && Math.abs(X - SX) < 0.6) {
        col = mix(col, 0xffd696, 0.45 * (1 - Math.abs(X - SX) / 0.6) * (1 - d * 0.6));
      }
      if (i > 0) {
        const m = (1 - (Y - top) / 0.07) * (fbm1(X * 3.2 + i * 4 - T * 0.04 * (i + 1), 70 + i) - 0.42) * 3.4;
        if (m > 0.75) col = 0xf4e2c2;
        else if (m > 0.45 + bayer(x, y) * 0.3) col = mix(col, 0xeed8b2, 0.7);
      }
      return col;
    }
    const ov = this.ov.get(x, y);
    if (ov >= 0) return ov;
    const d = Math.hypot(X - SX, Y - SY) / SR;
    if (d < 1) return d < 0.75 ? 0xfffbf1 : pick([0xfcefd0, 0xfffbf1], (1 - d) / 0.25, x, y);
    const glow = Math.pow(Math.max(0, 1 - d / 8), 2) * 0.45 + (d < 1.35 ? 0.06 : 0);
    const cl = fbm2(X * 0.9 - T * 0.012, Y * 11, 33) - Math.abs(Y - 0.2) * 3.2;
    if (cl > 0.44) {
      const lit = Math.max(0, 1 - Math.abs(X - SX) / 0.7);
      return pick(this.cloud, 0.15 + lit * 0.75 + (cl - 0.44) * 2, x, y);
    }
    return pick(this.sky, 0.04 + Math.pow(Y / 0.75, 1.1) * 0.82 + glow, x, y);
  }

  color(x: number, y: number): number {
    const { rows, T } = this.f;
    const X = x / rows;
    const Y = y / rows;
    const sh = this.shore[x];
    if (Y >= sh) return pick(R("#1A2416", "#121A10", "#0C110A"), (Y - sh) / 0.1 + hash(x, y, 3) * 0.3, x, y);
    if (Y < this.WATER) return this.above(x, y);
    const dep = Y - this.WATER;
    const SX = this.sun.x;
    if (Math.abs(X - SX) < 0.04 + dep * 1.2 && hash(x, y, Math.floor(T * 5)) > 0.35 + dep * 1.4 && (y % 2 === 0 || dep < 0.05)) {
      return hash(x, y, 9) > 0.5 ? 0xfff3d6 : 0xf2c985;
    }
    const wob = Math.round(Math.sin(y * 1.7 + T * 1.4) * dep * 14);
    const my = Math.floor((2 * this.WATER - Y) * rows);
    let c = this.above(Math.min(this.f.cols - 1, Math.max(0, x + wob)), Math.max(0, my));
    c = mix(c, 0x2b2a33, 0.22 + dep * 0.6);
    if (y % 3 === 0 && hash(Math.floor((x + T * 2) / 3), y, 4) > 0.72) c = mix(c, 0xffe6be, 0.18);
    return c;
  }
}

// ── 2 · Forest at golden hour, fireflies in the clearing ───────────────────

type TreeLayer = { sp: number; base: number; vary: number; scale: number; col: number; d: number; seed: number };

class Forest implements Scene {
  ink = hx("#0B110A");
  private bg = R("#1A2419", "#253323", "#33452B", "#4A5D33", "#6B743C", "#93904A", "#BBA95E", "#DCC47C", "#F0DCA2", "#FCEFCA", "#FFF8E6");
  private layers: TreeLayer[];
  private GROUND = 0.86;
  private LIGHT = hx("#D9C27E");
  private DARK = hx("#0B110A");
  private ov = new Overlay();
  private f!: Frame;
  private SX = 0;
  private SY = 0.5;

  constructor() {
    const specs: [number, number, number, number][] = [[0.055, 0.3, 0.1, 0.6], [0.075, 0.24, 0.12, 0.8], [0.11, 0.14, 0.14, 1.1], [0.2, 0.0, 0.12, 1.6]];
    this.layers = specs.map(([sp, base, vary, scale], i) => {
      const d = i / (specs.length - 1);
      const col = mix(mix(this.LIGHT, this.DARK, Math.pow(d, 0.7)), hx("#4C6B3E"), 0.3 * Math.sin(d * Math.PI));
      return { sp, base, vary, scale, col, d, seed: 3 + i * 11 };
    });
  }

  prepare(f: Frame) {
    this.f = f;
    const { cols, rows, T, W } = f;
    this.SX = W * 0.6;
    this.ov.reset(cols, rows);
    const ferns = [hx("#2E4426"), hx("#3F5A34"), hx("#4C6B3E")];
    const nf = Math.round(cols * 0.4);
    for (let i = 0; i < nf; i++) {
      const fx = hash(i, 0, 41) * cols;
      const fy = this.GROUND * rows + 1 + hash(i, 1, 41) * 3;
      const ln = 2 + Math.floor(hash(i, 2, 41) * 4);
      const sway = Math.sin(T * 1.1 + i) * 0.4;
      for (let s = 0; s < ln; s++) {
        this.ov.set(fx + s * (0.6 + sway), fy - s, ferns[i % 3]);
        this.ov.set(fx - s * (0.6 - sway), fy - s, ferns[i % 3]);
      }
    }
    // Fireflies low in the clearing, drifting and blinking.
    for (let i = 0; i < 22; i++) {
      const X = this.SX + (hash(i, 0, 43) - 0.5) * W * 0.9 + 0.04 * Math.sin(T * (0.3 + hash(i, 1, 43) * 0.4) + i);
      const Y = 0.62 + hash(i, 2, 43) * 0.22 + 0.025 * Math.cos(T * (0.35 + hash(i, 3, 43) * 0.3) + i * 2);
      const b = Math.sin(T * (1.2 + hash(i, 4, 43) * 1.8) + i * 5);
      if (b < 0.15) continue;
      const fx = X * rows;
      const fy = Y * rows;
      this.ov.set(fx, fy, b > 0.6 ? 0xfbf3b8 : 0xd8cf78);
      if (b > 0.8) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) this.ov.set(fx + dx, fy + dy, 0x8c8a45);
    }
    // Dust in the beam, drifting up and twinkling.
    for (let i = 0; i < 46; i++) {
      const X = this.SX + (hash(i, 0, 42) - 0.5) * 1.1 + Math.sin(T * 0.2 + i) * 0.03;
      const Y = 0.85 - ((hash(i, 1, 42) * 0.65 + T * 0.01) % 0.65);
      if (Math.hypot(X - this.SX, (Y - this.SY) * 1.5) > 0.5) continue;
      if (Math.sin(T * (1 + hash(i, 2, 42) * 2) + i) < 0) continue;
      this.ov.set(X * rows, Y * rows, hash(i, 3, 42) > 0.5 ? hx("#FFF3C4") : hx("#E9CF85"));
    }
  }

  private tree(L: TreeLayer, X: number, Y: number, x: number, y: number): number {
    const { T } = this.f;
    const SX = this.SX;
    const k0 = Math.floor(X / L.sp);
    for (let k = k0 - 1; k <= k0 + 1; k++) {
      const cx0 = (k + 0.2 + hash(k, 0, L.seed) * 0.6) * L.sp;
      if (L.d > 0.5 && Math.abs(cx0 - SX) < 0.22) continue;
      if (L.d > 0.2 && Math.abs(cx0 - SX) < 0.12) continue;
      const top = L.base + hash(k, 1, L.seed) * L.vary;
      const dy = Y - top;
      if (dy < 0) continue;
      const s = L.scale * (0.85 + hash(k, 2, L.seed) * 0.3);
      const cx = cx0 + Math.sin(T * 0.7 + k * 1.9) * 0.004 * s * Math.max(0, 1 - dy / 0.6);
      const du = Math.abs(X - cx);
      const tier = 0.055 * s;
      const n = Math.floor(dy / tier);
      const fr = (dy % tier) / tier;
      const half = (0.007 + n * 0.0062 + fr * 0.017) * s;
      const c = L.col;
      if (du < half) {
        const facing = (SX - cx) * (X > cx ? 1 : -1) > 0;
        if (facing && du > half * 0.65 && L.d > 0.3) return mix(c, 0xe2b864, 0.45 * (1 - L.d * 0.4));
        return pick([mix(c, this.LIGHT, 0.12), c, mix(c, this.DARK, 0.3)], (du / half) * 0.8 + (facing ? 0 : 0.2), x, y);
      }
      if (du < 0.007 * s * (L.d === 1 ? 2.2 : 1) && dy > tier * 4) return mix(c, this.DARK, 0.2);
    }
    return -1;
  }

  color(x: number, y: number): number {
    const { rows, T } = this.f;
    const X = x / rows;
    const Y = y / rows;
    const ov = this.ov.get(x, y);
    if (ov >= 0) return ov;
    const SX = this.SX;
    if (Y >= this.GROUND) {
      const lit = Math.max(0, 1 - Math.abs(X - SX) / 0.4) * Math.max(0, 1 - (Y - this.GROUND) / 0.1);
      return pick(R("#0E150C", "#1A2416", "#2B3720", "#5E5E33", "#A8914E"), 0.15 + lit * 0.85 - hash(x, y, 5) * 0.1, x, y);
    }
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const c = this.tree(this.layers[i], X, Y, x, y);
      if (c >= 0) return c;
    }
    const d = Math.hypot(X - SX, (Y - this.SY) * 1.3);
    const ang = Math.atan2(Y - this.SY, X - SX);
    const ray = Math.pow(Math.max(0, Math.sin(ang * 11 + 0.6 + Math.sin(T * 0.15) * 0.25)), 4) * Math.max(0, 1 - d / 1.1) * (0.22 + 0.06 * Math.sin(T * 0.5));
    return pick(this.bg, 1.0 - d * 0.9 + ray, x, y);
  }
}

// ── 3 · Lake at night: moon, cabin, jetty ──────────────────────────────────

const CABIN = ["...RR...", "..RRRR..", ".RRRRRR.", "RRRRRRRR", ".WWWWWW.", ".WWLWWW.", ".WWWWWW."];

class Lake implements Scene {
  ink = hx("#060A12");
  private sky = R("#090D17", "#0E1422", "#141C2E", "#1C273D", "#26344E", "#334560", "#465B76", "#5F768D", "#8297A6", "#AEBCC0", "#D3D9D4");
  private H = 0.62;
  private hills: { top: Float32Array; col: number }[] = [];
  private ov = new Overlay();
  private reeds = new Overlay();
  private f!: Frame;
  private moon = { x: 0, y: 0.21, r: 0.075 };
  private lantern = { x: 0, y: 0, r: 4.5 };
  private jettyEnd = 0;
  private stars = new Set<number>();
  private sized = "";

  private build(cols: number, rows: number) {
    this.hills = ([[0.52, 0.07, "#22304A"], [0.57, 0.06, "#151E2E"], [0.6, 0.035, "#0D1320"]] as [number, number, string][]).map(([base, amp, col], i) => {
      const orig = new Float32Array(cols);
      for (let x = 0; x < cols; x++) orig[x] = base - amp * (fbm1((x / rows) * (1.4 + i) + i * 9, 91 + i) - 0.4) * 2;
      const top = Float32Array.from(orig);
      if (i >= 1) {
        for (let x = 0; x < cols; x++) {
          if (hash(x, i, 93) <= 0.55) continue;
          const th = 1 + Math.floor(hash(x, i, 94) * (1 + i));
          for (let dx = -th; dx <= th; dx++) {
            const xx = x + dx;
            if (xx >= 0 && xx < cols) top[xx] = Math.min(top[xx], orig[x] - Math.max(0, th * 1.4 - Math.abs(dx) * 1.5) / rows);
          }
        }
      }
      return { top, col: hx(col) };
    });
    this.stars.clear();
    const n = Math.round(cols * 0.35);
    for (let i = 0; i < n; i++) this.stars.add(Math.floor(hash(i, 1, 17) * rows * 0.36) * cols + Math.floor(hash(i, 0, 17) * cols));
  }

  prepare(f: Frame) {
    this.f = f;
    const { cols, rows, T, t, W, px } = f;
    const key = `${cols}x${rows}`;
    if (key !== this.sized) {
      this.build(cols, rows);
      this.sized = key;
    }
    this.moon = { x: W * 0.62 - px * 0.01, y: 0.22 - 0.02 * easeOut(t / 6), r: 0.075 };
    this.ov.reset(cols, rows);
    // Cabin, window light, smoke.
    const cx = Math.round(W * 0.84 * rows) - 4;
    const cxc = Math.min(cols - 1, Math.max(0, cx));
    const cy = Math.round(this.hills[1].top[cxc] * rows) - 6;
    const windowOn = Math.sin(T * 0.37) > -0.92;
    CABIN.forEach((row, r) => {
      for (let c = 0; c < row.length; c++) {
        const ch = row[c];
        if (ch === "R") this.ov.set(cx + c, cy + r, 0x0a0f18);
        else if (ch === "W") this.ov.set(cx + c, cy + r, 0x111826);
        else if (ch === "L") this.ov.set(cx + c, cy + r, windowOn ? 0xf5c46e : 0x111826);
      }
    });
    this.ov.set(cx + 2, cy - 1, 0x0a0f18);
    for (let s = 0; s < 6; s++) {
      const k = (s + T * 0.9) % 6;
      this.ov.set(cx + 2 + k * 0.5 + Math.sin(k + T) * 0.6, cy - 2 - k, k < 3 ? 0x2b3a52 : 0x22304a);
    }
    // Jetty, posts and a flickering lantern at its end.
    const deck = Math.round(this.H * rows) - 1;
    const x1 = Math.round(W * 0.38 * rows);
    this.jettyEnd = x1;
    for (let x = 0; x < x1; x++) {
      this.ov.set(x, deck, x % 3 ? 0x2a2622 : 0x1e1b18);
      if (x % 6 === 0) {
        this.ov.set(x, deck - 1, 0x1e1b18);
        this.ov.set(x, deck - 2, 0x1e1b18);
      } else if (x % 2 === 0) this.ov.set(x, deck - 2, 0x1a1714);
    }
    for (let k = 0; k < 4; k++) this.ov.set(x1 - 1, deck - 1 - k, 0x1e1b18);
    this.lantern = { x: x1 - 1, y: deck - 5, r: 4.5 * (1 + 0.08 * Math.sin(T * 9) + 0.05 * Math.sin(T * 13.7)) };
    this.ov.set(this.lantern.x, this.lantern.y, 0xffe3a3);
    this.ov.set(this.lantern.x, this.lantern.y + 1, 0xe9a94f);
    // A shooting star, once per visit.
    if (t > 3.0 && t < 3.7) {
      const p = (t - 3.0) / 0.7;
      const sx = (W * 0.12 + p * W * 0.35) * rows;
      const sy = (0.06 + p * 0.1) * rows;
      for (let k = 0; k < 5; k++) this.ov.set(sx - k * 1.8, sy - k * 0.5, k === 0 ? 0xf8f5ec : k < 3 ? 0xaebcc0 : 0x5f768d);
    }
    // A few fireflies over the reeds.
    for (let i = 0; i < 9; i++) {
      const right = i > 3;
      const X = right ? W - 0.04 - hash(i, 0, 44) * 0.16 + 0.02 * Math.sin(T * 0.5 + i) : 0.03 + hash(i, 0, 44) * 0.14 + 0.02 * Math.sin(T * 0.5 + i);
      const Y = 0.72 + hash(i, 1, 44) * 0.18 + 0.015 * Math.cos(T * 0.6 + i);
      const b = Math.sin(T * (1.3 + hash(i, 2, 44) * 1.5) + i * 4);
      if (b > 0.3) this.ov.set(X * rows, Y * rows, b > 0.75 ? 0xf6eeb0 : 0xb7ae60);
    }
    // Reeds at both corners, swaying.
    this.reeds.reset(cols, rows);
    for (let i = 0; i < 26; i++) {
      const right = i > 11;
      const X = right ? W - hash(i, 0, 5) * 0.14 : hash(i, 0, 5) * 0.1;
      const ln = (0.08 + hash(i, 1, 5) * 0.18) * rows;
      const bend = (hash(i, 2, 5) - 0.5) * 3 + Math.sin(T * 1.1 + i * 0.8) * 0.9;
      for (let s = 0; s < ln; s++) {
        const p = s / ln;
        this.reeds.set(X * rows + bend * p * p, rows - 1 - s, 0x04070c);
      }
      if (hash(i, 3, 5) > 0.5) {
        this.reeds.set(X * rows + bend, rows - 1 - ln, 0x2a1e18);
        this.reeds.set(X * rows + bend, rows - 2 - ln, 0x2a1e18);
      }
    }
  }

  private above(x: number, y: number, reflect: boolean): number {
    const { rows, cols, T } = this.f;
    const X = x / rows;
    const Y = y / rows;
    const ov = this.ov.get(x, y);
    if (ov >= 0) return ov;
    for (let i = this.hills.length - 1; i >= 0; i--) {
      const { top, col } = this.hills[i];
      if (Y >= top[x]) return pick([mix(col, 0x788caa, 0.12), col, mix(col, 0, 0.25)], (Y - top[x]) / 0.05, x, y);
    }
    const L = this.lantern;
    const dl = Math.hypot(x - L.x, (y - L.y) * 1.1);
    if (!reflect && dl < L.r) {
      const g = Math.pow(1 - dl / L.r, 1.5);
      if (g > 0.15 + bayer(x, y) * 0.5) return mix(0x2a3346, 0xe9a94f, g * 0.7);
    }
    const { x: MX, y: MY, r: MR } = this.moon;
    const d = Math.hypot(X - MX, Y - MY) / MR;
    if (d < 1) return hash(x, y, 77) > 0.83 || (d > 0.55 && X > MX && Y > MY) ? 0xe3dfd3 : 0xf8f5ec;
    const cl = fbm2(X * 1.5 - T * 0.02, Y * 10, 61) - Math.abs(Y - 0.27) * 4;
    if (cl > 0.4) return pick(R("#1B2538", "#2C3B54", "#56698A", "#A3AFBF"), 0.1 + Math.max(0, 1 - d / 6) * 0.9 + (cl - 0.4), x, y);
    const v = Math.pow(Y / this.H, 1.25) * 0.78 + Math.pow(Math.max(0, 1 - d / 5), 2) * 0.45 + (d < 1.6 ? 0.04 : 0);
    const idx = y * cols + x;
    if (this.stars.has(idx)) return Math.sin(T * 2.2 + x * 1.3) > -0.3 ? 0xf8f5ec : 0x8297a6;
    if (v < 0.4 && hash(x, y, 7) > 0.988) return Math.sin(T * 3 + hash(x, y, 8) * 30) > 0 ? 0x8297a6 : 0x465b76;
    return pick(this.sky, v, x, y);
  }

  color(x: number, y: number): number {
    const { rows, cols, T } = this.f;
    const X = x / rows;
    const Y = y / rows;
    const rd = this.reeds.get(x, y);
    if (rd >= 0) return rd;
    if (Y < this.H) return this.above(x, y, false);
    const ov = this.ov.get(x, y);
    if (ov >= 0) return ov;
    const dep = Y - this.H;
    const { x: MX, r: MR } = this.moon;
    if (Math.abs(X - MX) < MR * (0.5 + dep * 4) && hash(x, y, Math.floor(T * 4)) > 0.42 + dep * 1.6 && (y % 2 === 0 || dep < 0.04)) {
      return hash(x, y, 9) > 0.45 ? 0xe3dfd3 : 0x8297a6;
    }
    const lx = this.lantern.x;
    if (Math.abs(x - lx) < 1 + dep * 8 && hash(x, y, Math.floor(T * 6) + 18) > 0.5 + dep * 2 && y % 2 === 1) {
      return hash(x, y, 19) > 0.5 ? 0xe9a94f : 0x8c6236;
    }
    if (Y < this.H + 0.04 && x < this.jettyEnd && x % 6 === 0) return 0x141210;
    const wob = Math.round(Math.sin(y * 1.9 + T * 1.3) * dep * 12 + Math.sin(y * 0.7 + 1 - T * 0.8) * dep * 6);
    const my = Math.floor((2 * this.H - Y) * rows);
    let c = this.above(Math.min(cols - 1, Math.max(0, x + wob)), Math.max(0, my), true);
    c = mix(c, 0x060a12, 0.25 + dep * 0.9);
    if (y % 4 === 0 && hash(Math.floor((x + T * 1.5) / 4), y, 4) > 0.78) c = mix(c, 0x5f768d, 0.35);
    return c;
  }
}

// ── 4 · Under the surface: kelp, light, a distant shoal ───────────────────────

class Deep implements Scene {
  ink = hx("#061823");
  private water = R("#EAF5EF", "#C4E2D8", "#9DCFC4", "#76B9AF", "#56A19D", "#3D8689", "#2C6C77", "#1F5465", "#163F52", "#0F2E40", "#0A2131", "#061823");
  private sand = R("#EDE2C4", "#DCCDA6", "#C7B68C", "#A89872", "#857859", "#625945");
  private rockR = R("#6E7A66", "#55624F", "#414C3E", "#2F382E", "#222A22");
  private floor = new Float32Array(0);
  private rocks = new Float32Array(0);
  private coral = new Overlay();
  private ov = new Overlay();
  private f!: Frame;
  private sized = "";
  private rays: [number, number, number][] = [];

  private build(cols: number, rows: number, W: number) {
    this.floor = new Float32Array(cols);
    this.rocks = new Float32Array(cols);
    for (let x = 0; x < cols; x++) {
      const X = x / rows;
      this.floor[x] = 0.83 - 0.08 * fbm1(X * 1.6 + 4, 81);
      this.rocks[x] = this.floor[x] - Math.max(0, fbm1(X * 1.7 + 30, 83) - 0.56) * 0.75;
    }
    // Coral is static; stamp it once per size.
    this.coral.reset(cols, rows);
    const cc = R("#A8514A", "#C98FA0", "#E9B86A", "#D9944A");
    const n = Math.max(4, Math.round(cols / 9));
    for (let i = 0; i < n; i++) {
      const cx = Math.floor(hash(i, 0, 31) * cols);
      const cy = Math.floor(Math.min(this.rocks[cx], this.floor[cx]) * rows);
      const c = cc[Math.floor(hash(i, 1, 31) * 4)];
      const hl = mix(c, 0xfff5e6, 0.3);
      if (hash(i, 2, 31) < 0.5) {
        for (let b = -2; b <= 2; b++) {
          const ln = 2 + Math.floor(hash(i, b + 5, 32) * 4);
          for (let s = 0; s < ln; s++) this.coral.set(cx + b + Math.floor(s / 2) * Math.sign(b), cy - s, s < ln - 1 ? c : hl);
        }
      } else {
        for (let dx = -3; dx <= 3; dx++) {
          for (let dy = 0; dy < 4 - Math.abs(dx); dy++) {
            if (hash(i, dx * 9 + dy, 33) > 0.3) this.coral.set(cx + dx, cy - dy, dy === 3 - Math.abs(dx) ? hl : c);
          }
        }
      }
    }
    this.rays = [[0.1, 0.06, 0.5], [0.3, 0.035, 0.35], [0.5, 0.08, 0.55], [0.68, 0.04, 0.4], [0.85, 0.06, 0.45]].map(([x, w, a]) => [x * W, w, a]);
  }

  prepare(f: Frame) {
    this.f = f;
    const { cols, rows, T, W } = f;
    const key = `${cols}x${rows}`;
    if (key !== this.sized) {
      this.build(cols, rows, W);
      this.sized = key;
    }
    this.ov.reset(cols, rows);
    // Kelp in three depths, gathered in clusters, swaying.
    const clusters = [0.08, 0.3, 0.55, 0.78, 0.95];
    const fog = (c: number, d: number) => mix(c, 0x4e9896, d);
    const spec: [number, number, number, number][] = [[0.6, 1, 1.4, 1.0], [0.3, 1, 2.2, 0.65], [0, 2, 3.2, 0.35]];
    spec.forEach(([haze, thick, amp, dens], layer) => {
      const count = Math.max(2, Math.round(cols * 0.17 * dens));
      for (let i = 0; i < count; i++) {
        const cl = clusters[Math.floor(hash(i, layer, 20) * clusters.length)];
        const fx = Math.floor((cl + (hash(i, layer, 21) - 0.5) * 0.22) * W * rows);
        if (fx < 0 || fx >= cols) continue;
        const base = Math.floor(this.floor[fx] * rows) + (layer === 2 ? 2 : 0);
        const ln = Math.floor((0.35 + hash(i, layer, 22) * 0.45) * rows * (0.7 + layer * 0.18));
        const col = fog([0x4c6b3e, 0x5a7b4c, 0x3f5a34][i % 3], haze);
        const leaf = fog([0x7fa05f, 0x8fae68][i % 2], haze);
        for (let s = 0; s < ln; s++) {
          const p = s / ln;
          const sx = fx + Math.sin(s * 0.16 + i * 1.7 + layer - T * 0.9) * amp * p * p;
          for (let k = 0; k < thick; k++) this.ov.set(sx + k, base - s, k === 0 ? col : mix(col, 0, 0.15));
          if (s % 3 === 1 && s > 2) {
            const side = Math.floor(s / 3) % 2 ? 1 : -1;
            for (let k = 1; k < 3 + layer; k++) this.ov.set(sx + side * (k + (side > 0 ? thick - 1 : 0)), base - s - (k >> 1), leaf);
          }
        }
      }
    });
    // A shoal far off in the blue: small, hazy, turning on itself.
    const CX = W * 0.8 * rows;
    const CY = 0.36 * rows;
    const nfish = Math.max(16, Math.round(cols * 0.45));
    for (let i = 0; i < nfish; i++) {
      const a = hash(i, 0, 51) * Math.PI * 2 + T * 0.4;
      const rr = (0.05 + hash(i, 1, 51) * 0.045 + 0.012 * Math.sin(a * 3)) * rows;
      const x = CX + Math.cos(a) * rr * 1.6;
      const y = CY + Math.sin(a) * rr * 0.65;
      const dir = Math.sin(a) > 0 ? 1 : -1;
      this.ov.set(x, y, mix(hash(i, 2, 51) > 0.45 ? 0xf2f8f3 : 0xc4e2d8, 0x5aa3a0, 0.45));
      this.ov.set(x - dir, y, mix(0x5e8f93, 0x5aa3a0, 0.5));
    }
    // Bubbles rising from the kelp beds.
    for (let i = 0; i < 22; i++) {
      const life = (T * (0.08 + hash(i, 0, 61) * 0.06) + hash(i, 1, 61)) % 1;
      const bx = hash(i, 2, 61) * cols + Math.sin(T * 2 + i) * 0.8;
      const by = (0.85 - life * 0.8) * rows;
      this.ov.set(bx, by, hash(i, 3, 61) > 0.4 ? 0xeaf5ef : 0xbfe0d6);
    }
  }

  color(x: number, y: number): number {
    const { rows, T } = this.f;
    const X = x / rows;
    const Y = y / rows;
    const ov = this.ov.get(x, y);
    if (ov >= 0) return ov;
    const W = this.f.W;
    const win = Math.max(0, 1 - Math.abs(X - W * 0.6) / 0.5);
    const surf = 0.055 + 0.015 * Math.sin(X * 7.3 + T * 1.3) + 0.01 * Math.sin(X * 19 + 1 - T * 2.1);
    if (Y < surf) return pick(R("#B9DDD3", "#DCEFE7", "#F6FBF7"), 0.3 + win * 0.7 - (surf - Y) * 3, x, y);
    const fl = this.floor[x];
    if (Y >= fl) {
      const n = Math.abs(Math.sin(X * 13 + T * 0.8 + Math.sin(Y * 21 - T * 0.5)) + Math.sin(Y * 17 - X * 7 + T * 0.6));
      if (n < 0.2 && Y - fl < 0.09) return 0xfbf3de;
      return pick(this.sand, (Y - fl) / 0.17 + 0.06 * Math.sin(X * 9 + Y * 30), x, y);
    }
    const co = this.coral.get(x, y);
    if (co >= 0) return co;
    if (Y >= this.rocks[x]) return pick(this.rockR, (Y - this.rocks[x]) / 0.1 + hash(x, y, 7) * 0.2, x, y);
    let ray = 0;
    for (let i = 0; i < this.rays.length; i++) {
      const [rx, w, a] = this.rays[i];
      const d = Math.abs(X - (rx + Y * 0.38 + Math.sin(T * 0.25 + i * 2) * 0.03));
      ray += Math.pow(Math.max(0, 1 - d / w), 2) * a;
    }
    ray *= Math.pow(Math.max(0, 1 - Y * 1.15), 1.4);
    const glow = Math.pow(Math.max(0, 1 - Math.hypot((X - W * 0.6) * 0.45, Y) / 0.55), 2) * 0.25;
    const v = 0.06 + Math.pow(Y / 0.85, 0.95) * 0.95 - ray * 0.55 - glow;
    if (hash(x, y + Math.floor(T * 1.2), 71) > 0.988) return mix(pick(this.water, v, x, y), 0xebf8f0, 0.55);
    return pick(this.water, v, x, y);
  }
}

// ── 5 · Meadow in summer: an oak on the hill, flowers opening ──────────────

class Meadow implements Scene {
  ink = hx("#16200F");
  private sky = R("#6E9BB0", "#80A8BA", "#94B5C4", "#A9C3CD", "#BED2D6", "#D2DFDE", "#E4EAE3", "#F1F0E8");
  private cloudR = R("#A8B6BE", "#C6CFD1", "#E3E6E2", "#F8F7F1", "#FFFEFA");
  private canopyR = R("#A9BE7C", "#86A262", "#6B8E5A", "#557548", "#3F5A34", "#2C4126");
  private grass = R("#9DB86F", "#86A462", "#6B8E5A", "#557548", "#3F5A34", "#2E4426");
  private petals = R("#E9B86A", "#A8514A", "#F7F4ED", "#D9944A", "#C98FA0", "#F2D49A", "#8E7CC3");
  private far = new Float32Array(0);
  private mid = new Float32Array(0);
  private near = new Float32Array(0);
  private ov = new Overlay();
  private f!: Frame;
  private trunk = new Overlay();
  private oak = { x: 0, y: 0, cx: 0, cy: 0, r: 0.12 };
  private lobes: [number, number, number][] = [[0, 0, 1], [-0.09, 0.03, 0.72], [0.1, 0.02, 0.75], [-0.04, -0.06, 0.7], [0.06, -0.05, 0.72], [-0.14, 0.06, 0.5], [0.15, 0.07, 0.5]];

  prepare(f: Frame) {
    this.f = f;
    const { cols, rows, T, t, W, px } = f;
    const TX = W * 0.66;
    this.far = new Float32Array(cols);
    this.mid = new Float32Array(cols);
    this.near = new Float32Array(cols);
    for (let x = 0; x < cols; x++) {
      const X = x / rows;
      this.far[x] = 0.5 - 0.09 * fbm1(X * 1.2 + 20 + px * 0.02, 61);
      this.mid[x] = 0.58 - 0.08 * fbm1(X * 1.6 + 5, 62) - 0.07 * Math.pow(Math.max(0, 1 - Math.abs(X - TX) / 0.5), 2);
      const gust = Math.round(Math.sin(T * 1.7 + X * 5) * 1.2);
      this.near[x] = 0.74 - 0.05 * fbm1(X * 2.2 + 9, 63) - hash(x + gust, 0, 64) * 0.012;
    }
    const tx = Math.round(TX * rows);
    const ty = this.mid[Math.min(cols - 1, Math.max(0, tx))];
    this.oak = { x: tx, y: ty, cx: TX, cy: ty - 0.14, r: 0.12 };

    this.ov.reset(cols, rows);
    // The trunk sits behind the canopy, so it lives on its own layer.
    this.trunk.reset(cols, rows);
    const ty0 = Math.round(ty * rows);
    for (let s = 0; s < Math.round(0.12 * rows); s++) {
      this.trunk.set(tx, ty0 - s, 0x3b2e22);
      this.trunk.set(tx + 1, ty0 - s, 0x2c2219);
    }
    // Flowers grow, then open, swaying in the wind.
    const nfl = Math.round(cols * 0.6);
    for (let i = 0; i < nfl; i++) {
      const fx = hash(i, 0, 9) * cols;
      const nx = Math.min(cols - 1, Math.floor(fx));
      const depth = hash(i, 1, 9);
      const base = this.near[nx] * rows + 3 + depth * rows * 0.24;
      const born = 0.2 + hash(i, 6, 9) * 3.8;
      const grow = clamp01((t - born) / 1.1);
      if (grow <= 0) continue;
      const full = 2 + Math.floor(hash(i, 2, 9) * (2 + (base / rows - 0.74) * 30));
      const ln = Math.max(1, Math.round(full * easeOut(grow)));
      const lean = (hash(i, 3, 9) - 0.5) * 2 + Math.sin(T * 1.6 + fx * 0.2) * 1.1;
      for (let s = 0; s < ln; s++) {
        const p = s / Math.max(1, ln);
        this.ov.set(fx + lean * p * p, base - s, 0x4c6b3e);
      }
      const bloom = clamp01((t - born - 0.9) / 0.6);
      if (bloom <= 0) continue;
      const topx = fx + lean;
      const topy = base - ln;
      const pc = this.petals[Math.floor(hash(i, 4, 9) * this.petals.length)];
      this.ov.set(topx, topy, bloom < 0.35 ? pc : 0xb5832e);
      if (bloom >= 0.35) for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) this.ov.set(topx + dx, topy + dy, pc);
      if (bloom >= 0.9 && base / rows > 0.88 && hash(i, 5, 9) > 0.3) {
        const hl = mix(pc, 0xffffff, 0.3);
        for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) this.ov.set(topx + dx, topy + dy, pc);
        for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2]]) this.ov.set(topx + dx, topy + dy, hl);
      }
    }
    // Butterflies and far birds.
    for (let b = 0; b < 2; b++) {
      const x = (W * (0.3 + b * 0.4) + 0.12 * Math.sin(T * (0.31 + b * 0.1) + b * 2)) * rows;
      const y = (0.68 + 0.04 * Math.sin(T * 0.7 + b) + 0.01 * Math.sin(T * 4.1)) * rows;
      this.ov.set(x, y, 0x1c1c1c);
      if (Math.floor(T * 7 + b) % 2) for (const [dx, dy] of [[-1, 0], [1, 0], [-1, -1], [1, -1], [-2, -1], [2, -1]]) this.ov.set(x + dx, y + dy, 0xe9b86a);
      else this.ov.set(x, y - 1, 0xd9944a);
    }
    const bl = (((T * 0.025) % 1.4) - 0.2) * W;
    [[0, 0], [0.04, 0.015], [-0.04, 0.02]].forEach(([dx, dy], i) => {
      const x = (bl + dx) * rows;
      const y = (0.1 + dy) * rows;
      const up = Math.floor(T * 4 + i) % 2;
      this.ov.set(x, y, 0x4a5a63);
      this.ov.set(x - 1, y - up, 0x4a5a63);
      this.ov.set(x + 1, y - up, 0x4a5a63);
    });
  }

  color(x: number, y: number): number {
    const { rows, T, W } = this.f;
    const X = x / rows;
    const Y = y / rows;
    const ov = this.ov.get(x, y);
    if (ov >= 0) return ov;

    // Oak canopy: lobes with a rustling edge, lit from the upper left.
    const o = this.oak;
    if (Math.abs(X - o.cx) < o.r * 1.6 && Math.abs(Y - o.cy) < o.r * 1.4) {
      let inside = -9;
      for (const [ox, oy, r] of this.lobes) {
        inside = Math.max(inside, 1 - Math.hypot(X - (o.cx + ox * 0.9), (Y - (o.cy + oy * 0.9)) * 1.15) / (o.r * r));
      }
      if (inside > -0.15) {
        inside += (fbm2(X * 30 + T * 0.4, Y * 30, 71) - 0.5) * 0.25;
        if (inside > 0) {
          const shade = ((Y - (o.cy - o.r)) / (o.r * 2)) * 0.8 + (X - o.cx) * 1.6 + 0.15 - inside * 0.4;
          return pick(this.canopyR, shade, x, y);
        }
      }
    }
    const tr = this.trunk.get(x, y);
    if (tr >= 0) return tr;
    const nr = this.near[x];
    if (Y >= nr) {
      const pc = o.cx - 0.12 + 0.18 * Math.sin((Y - 0.74) * 9) + (1 - Y) * 0.2;
      const pw = 0.015 + (Y - nr) * 0.4;
      if (Math.abs(X - pc) < pw) return pick(R("#E3D3A8", "#CDB98A", "#AE9A6E"), (Math.abs(X - pc) / pw) * 0.7 + hash(x, y, 2) * 0.3, x, y);
      return pick(this.grass, (Y - nr) / 0.22 + (hash(x, y, 4) - 0.5) * 0.18, x, y);
    }
    const md = this.mid[x];
    if (Y >= md) {
      const band = Math.floor((Y - md) * rows * 0.45 + X * 2.4) % 4;
      const fields = [R("#A3BA79", "#8FAA6A"), R("#7FA05F", "#6B8E5A"), R("#D6C384", "#C2AD6B"), R("#8FAA6A", "#7FA05F")];
      return pick(fields[band], (Y - md) / 0.1, x, y);
    }
    if (Y >= this.far[x]) return pick(R("#C9D3B8", "#B5C4A0", "#A2B68E"), (Y - this.far[x]) / 0.08, x, y);
    let c = 0;
    const clouds: [number, number, number, number][] = [[0.22 * W, 0.25, 0.3, 0.11], [0.78 * W, 0.18, 0.36, 0.12]];
    for (const [cx0, cy, sx, sy] of clouds) {
      if (Y > cy + 0.07) continue;
      const cx = cx0 + ((T * 0.006) % 0.3) - 0.15;
      let e = -9;
      for (const [bx, by, bs] of [[0, 0.02, 0.8], [-0.42, 0.05, 0.5], [0.42, 0.05, 0.55], [-0.15, -0.05, 0.55], [0.18, -0.07, 0.5], [0.02, -0.12, 0.35]]) {
        e = Math.max(e, 1 - Math.hypot((X - cx - bx * sx) / (sx * bs), (Y - cy - by) / (sy * bs * 1.1)));
      }
      c = Math.max(c, e + (fbm2(X * 4 - T * 0.02, Y * 7, 33) - 0.5) * 0.22 - (Y - cy) * 1.5);
    }
    if (c > 0.12) return pick(this.cloudR, (c - 0.12) * 2.2 + 0.25, x, y);
    return pick(this.sky, Math.pow(Y / 0.5, 1.1), x, y);
  }
}

// ── 6 · Autumn temple: a five-storey pagoda in a sea of maples ─────────────

type Crown = { cx: number; cy: number; r: number; pal: number[]; haze: number; s: number };
type Tier = { wb: number; wt: number; whw: number; rb: number; rt: number; rhw: number; i: number };

const MAPLES = [
  R("#EE8048", "#D1502E", "#AE3622", "#842719", "#5C1B12"),
  R("#F5AE52", "#E3812F", "#C55F23", "#97431B", "#6A2E14"),
  R("#F7D262", "#ECAE3E", "#CF8A2B", "#A0631F", "#704517"),
  R("#F5E384", "#E8C64E", "#CBA236", "#9E7826", "#6D531B"),
];

class Pagoda implements Scene {
  ink = hx("#2A1410");
  private sky = R("#143A78", "#1A478C", "#2157A2", "#2A68B6", "#387BC5", "#4F90D1", "#6AA4DB", "#8BB9E2", "#AECDE5");
  private roofR = R("#93A2DC", "#7183C8", "#5869B1", "#465398", "#353F7A", "#272F5D");
  private groundR = R("#EBCB60", "#DAB247", "#C6973A", "#AA7B30", "#7F5B26");
  private pathR = R("#C2C6C8", "#A3A9AE", "#868D95");
  private hillR = R("#6E8DBC", "#5A79AA", "#476594");
  private cloudR = R("#8FB8E0", "#BCD5EC", "#E4EEF5");
  private HAZE = hx("#7F9DC6");
  private S = 1.42;
  private BASE = 0.87;
  private PAD = 6;
  private PX = 0;
  private cxc = 0;
  private spireTop = 0;
  private spireBot = 0;
  private tiers: Tier[] = [];
  private layers: Crown[][][] = [];
  private hills = new Float32Array(0);
  private ground = new Float32Array(0);
  private ov = new Overlay();
  private f!: Frame;
  private sized = "";

  private build(cols: number, rows: number, W: number) {
    const { S, BASE, PAD } = this;
    this.PX = W * 0.6;
    this.tiers = [];
    let y = BASE;
    for (let i = 0; i < 5; i++) {
      const wh = (0.068 - i * 0.005) * S;
      const rh = (0.058 - i * 0.003) * S;
      const wt = y - wh;
      const rb = wt + 0.012 * S;
      const rt = rb - rh;
      this.tiers.push({ wb: y, wt, whw: (0.055 - i * 0.006) * S, rb, rt, rhw: (0.15 - i * 0.013) * S, i });
      y = rt + 0.009 * S;
    }
    this.cxc = Math.floor(this.PX * rows);
    const top = this.tiers[4].rt;
    this.spireTop = Math.floor((top - 0.115) * rows);
    this.spireBot = Math.floor(top * rows) + 1;
    this.hills = new Float32Array(cols + PAD * 2);
    this.ground = new Float32Array(cols);
    for (let x = -PAD; x < cols + PAD; x++) this.hills[x + PAD] = 0.47 - 0.07 * fbm1((x / rows) * 1.3 + 3, 201);
    for (let x = 0; x < cols; x++) this.ground[x] = 0.69 + 0.014 * (fbm1((x / rows) * 2 + 7, 202) - 0.5);
    // Maples as dithered crowns at three depths; the far ones fade into the haze.
    const specs: [number, number, number, number, number, number][] = [
      [9, 0.47, 0.53, 0.05, 0.075, 0.32],
      [7, 0.56, 0.66, 0.08, 0.12, 0.12],
      [3.2, 0.93, 1.06, 0.15, 0.23, 0],
    ];
    this.layers = specs.map(([dens, y0, y1, r0, r1, haze], li) => {
      const n = Math.floor(W * dens) + 2;
      const trees: Crown[] = [];
      for (let k = -1; k <= n; k++) {
        const cx = ((k + 0.15 + hash(k, li, 210) * 0.7) / n) * W;
        if (li === 2 && Math.abs(cx - this.PX) < 0.2 * S) continue;
        trees.push({ cx, cy: y0 + hash(k, li, 211) * (y1 - y0), r: r0 + hash(k, li, 212) * (r1 - r0), pal: MAPLES[Math.floor(hash(k, li, 213) * 4)], haze, s: 220 + k * 3 + li });
      }
      if (li === 2) {
        trees.push({ cx: W * 0.98, cy: 0.78, r: 0.2, pal: MAPLES[0], haze: 0, s: 260 });
        trees.push({ cx: 0.06 * W, cy: 0.78, r: 0.2, pal: MAPLES[1], haze: 0, s: 261 });
      }
      trees.sort((a, b) => b.cy - a.cy); // nearest first
      const lists: Crown[][] = [];
      for (let x = -PAD; x < cols + PAD; x++) lists.push(trees.filter((t) => Math.abs(t.cx - x / rows) < t.r * 1.35));
      return lists;
    });
  }

  prepare(f: Frame) {
    this.f = f;
    const { cols, rows, T, W } = f;
    const key = `${cols}x${rows}`;
    if (key !== this.sized) {
      this.build(cols, rows, W);
      this.sized = key;
    }
    // Leaves drifting down through the frame, swaying as they fall.
    this.ov.reset(cols, rows);
    const leaf = R("#E3812F", "#D1502E", "#ECAE3E", "#F5AE52");
    for (let i = 0; i < 34; i++) {
      const v = 0.035 + hash(i, 0, 230) * 0.04;
      const Y = ((hash(i, 1, 230) + T * v) % 1.15) - 0.08;
      const X = hash(i, 2, 230) * W + Math.sin(T * (0.9 + hash(i, 3, 230)) + i) * 0.035 + T * 0.006;
      const lx = (((X % W) + W) % W) * rows;
      const ly = Y * rows;
      this.ov.set(lx, ly, leaf[i % 4]);
      if (Math.sin(T * 3 + i) > 0.3) this.ov.set(lx + 1, ly, 0x97431b);
    }
  }

  private crown(t: Crown, X: number, Y: number, x: number, y: number): number {
    const { T } = this.f;
    const sw = t.haze === 0 ? Math.sin(T * 0.8 + t.s) * 0.004 : 0;
    const dx = (X - t.cx - sw) / t.r;
    const dy = (Y - t.cy) / (t.r * 1.1);
    if (dx * dx + dy * dy > 1.5) return -1;
    const d = Math.hypot(dx, dy) + (fbm2(X * 16, Y * 16, t.s) - 0.5) * 0.45;
    if (d > 1) return -1;
    const v = 0.3 + dy * 0.28 + dx * 0.22 + (fbm2((X - sw) * 28, Y * 28, t.s + 3) - 0.5) * 0.65 + d * 0.1;
    const c = pick(t.pal, v, x, y);
    return t.haze ? mix(c, this.HAZE, t.haze) : c;
  }

  private building(X: number, Y: number, x: number, y: number): number {
    const { rows, T } = this.f;
    const { PX, S, BASE, cxc } = this;
    if (y >= this.spireTop && y < this.spireBot) {
      const dy = y - this.spireTop;
      if (x === cxc) return dy < 1 ? (Math.sin(T * 0.9) > 0.85 ? 0xfff6dc : 0xf2d58a) : 0x8c6a3a;
      if (Math.abs(x - cxc) === 1 && dy >= 2 && dy < this.spireBot - this.spireTop - 1) return x < cxc ? 0xc29a55 : 0x6e5030;
    }
    const u = Math.abs(X - PX);
    for (let k = this.tiers.length - 1; k >= 0; k--) {
      const { wb, wt, whw, rb, rt, rhw, i } = this.tiers[k];
      if (Y >= rt && Y <= rb) {
        const curl = 0.012 * S * Math.pow(Math.max(0, (u - rhw * 0.7) / (rhw * 0.3)), 2);
        const bot = rb - curl;
        const tt = (Y - rt) / (rb - rt);
        const hw = whw * 0.75 + (rhw - whw * 0.75) * Math.pow(tt, 0.55);
        if (Y <= bot && u <= hw) {
          const lit = X < PX;
          if (Y - rt < 0.8 / rows) return 0x1e2652;
          if (bot - Y < 1 / rows) return lit ? 0xb3bee6 : 0x7c89be;
          let v = 0.38 + (u / hw) * (lit ? -0.2 : 0.3) + tt * 0.12;
          if ((x + Math.floor((Y - rt) * rows)) % 2 === 0) v += 0.14;
          return pick(this.roofR, v, x, y);
        }
      }
      if (Y >= wt && Y <= wb && u <= whw) {
        const ry = (Y - wt) / (wb - wt);
        const col = x - cxc;
        let c: number;
        if (u > whw - 0.8 / rows) c = 0x5e301d;
        else if (ry < 0.38) c = col % 2 === 0 ? 0xb4602e : 0xece5d4;
        else if (ry < 0.5) c = 0x6e3a22;
        else if (i === 0 && Math.abs(col) <= 1) c = 0x2f3240;
        else if (i === 0 && Math.abs(col) === 3) c = 0x7fb3b0;
        else if (col % 3 === 0) c = 0x6e3a22;
        else c = 0xe2dbc8;
        if (Y - wt < 1 / rows) c = mix(c, 0x1c1a2a, 0.45);
        if (X > PX) c = mix(c, 0x2a2238, 0.14);
        return c;
      }
    }
    if (Y >= BASE && Y < BASE + 0.045 && u < 0.13 * S) {
      if (u < 0.035) return y % 2 ? 0xc9c5bb : 0x8f8b84;
      const c = Y - BASE < 1 / rows ? 0xdcd8ce : 0xa9a59c;
      return X > PX ? mix(c, 0x3a3440, 0.18) : c;
    }
    return -1;
  }

  color(x: number, y: number): number {
    const { rows, cols, T, W, px } = this.f;
    const X = x / rows;
    const Y = y / rows;
    const { PX, S, BASE, PAD } = this;
    const ov = this.ov.get(x, y);
    if (ov >= 0) return ov;
    for (const t of this.layers[2][x + PAD]) {
      const c = this.crown(t, X, Y, x, y);
      if (c >= 0) return c;
    }
    const b = this.building(X, Y, x, y);
    if (b >= 0) return b;
    if (Y >= this.ground[x]) {
      let c: number;
      const pc = PX - (Y - BASE - 0.04) * 1.9;
      if (Y > BASE + 0.04 && Math.abs(X - pc) < 0.03 + (Y - BASE) * 0.25) {
        c = pick(this.pathR, hash(x, y, 240) * 0.6 + (Y - BASE) * 2, x, y);
      } else {
        c = pick(this.groundR, 0.15 + (fbm2(X * 5, Y * 9, 241) - 0.5) * 0.7 + (Y - this.ground[x]) * 1.2, x, y);
        if (hash(x, y, 242) > 0.9) c = hash(x, y, 243) > 0.5 ? 0xc24e2a : 0xe3812f;
      }
      const sh = Math.hypot((X - (PX + 0.2 * S)) / (0.19 * S), (Y - (BASE + 0.015)) / 0.06);
      if (sh < 1 && X > PX) c = mix(c, 0x4a3a2c, 0.38);
      return c;
    }
    // Far layers slide a little with the pointer.
    for (const li of [1, 0]) {
      const sh = Math.round(px * (li === 1 ? 1 : 2));
      const xi = Math.min(cols + PAD - 1, Math.max(-PAD, x + sh));
      const Xs = xi / rows;
      for (const t of this.layers[li][xi + PAD]) {
        const c = this.crown(t, Xs, Y, xi, y);
        if (c >= 0) return c;
      }
    }
    const hxI = Math.min(cols + PAD - 1, Math.max(-PAD, x + Math.round(px * 3)));
    const ht = this.hills[hxI + PAD];
    if (Y >= ht) return pick(this.hillR, (Y - ht) / 0.06, x, y);
    const cl = fbm2(X * 0.8 - T * 0.012, Y * 13, 250) - Math.abs(Y - 0.16) * 4;
    if (cl > 0.45) return pick(this.cloudR, (cl - 0.45) * 4, x, y);
    return pick(this.sky, 0.03 + Math.pow(Y / 0.5, 1.2) * 0.85 + Math.max(0, 1 - X / (0.5 * W)) * 0.08 * (1 - Y), x, y);
  }
}

// ── 7 · Karst valley: limestone towers, drifting mist, a river, bamboo ──────

type KarstLayer = { top: Float32Array; pk: Float32Array; col: number; d: number; base: number; i: number };

class Karst implements Scene {
  ink = hx("#1A2E14");
  private sky = R("#7EA6C4", "#95B8D0", "#AEC9D8", "#C6D8DC", "#DBE4DA", "#EAECD8", "#F4F1DA", "#FAF6E2", "#FFFCEE");
  private bamboo = R("#D3E48A", "#B4D467", "#93BE52", "#73A341", "#548434", "#3A6427", "#26461B");
  private water = R("#F6F5EA", "#DCE7E0", "#BCD1CA", "#92B0A8", "#5E8379");
  private rock = R("#C9C8B4", "#A2A493", "#7E846F", "#5E6A50");
  private cloudR = R("#C8D6DC", "#E6EBE2", "#F8F5E6", "#FFFDF4");
  private HAZE = hx("#DCE4CF");
  private DEEP = hx("#33652E");
  private MIST = hx("#EEF1E6");
  private layers: KarstLayer[] = [];
  private near = new Float32Array(0);
  private ov = new Overlay();
  private f!: Frame;
  private sized = "";
  private glow = 0.6;

  private rc(Y: number) {
    return this.f.W * 0.45 + 0.06 * Math.sin((Y - 0.745) * 16);
  }

  private build(cols: number, rows: number, W: number) {
    const specs: [number, number, number, number][] = [[0.54, 0.12, 0.06, 8], [0.6, 0.16, 0.075, 6], [0.665, 0.21, 0.09, 4.5], [0.745, 0.26, 0.11, 3.2]];
    const LX = W * 0.84;
    this.layers = specs.map(([base, ph, pw, dens], i) => {
      const d = i / (specs.length - 1);
      const col = mix(mix(this.HAZE, this.DEEP, Math.pow(d, 1.15)), hx("#4E8A38"), 0.35 * Math.sin(d * Math.PI));
      const n = Math.floor(W * dens) + 2;
      let peaks: [number, number, number][] = [];
      for (let k = -1; k <= n; k++) peaks.push([((k + 0.2 + hash(k, i, 301) * 0.6) / n) * W, ph * (0.45 + hash(k, i, 302) * 0.7), pw * (0.7 + hash(k, i, 303) * 0.6)]);
      if (i === 3) {
        peaks = peaks.filter((p) => Math.abs(p[0] - LX) > 0.22 && Math.abs(p[0] - W * 0.64) > 0.16);
        peaks.push([LX, 0.47, 0.15], [W * 0.64, 0.32, 0.11]);
      }
      const top = new Float32Array(cols);
      const pk = new Float32Array(cols);
      for (let x = 0; x < cols; x++) {
        const X = x / rows;
        let best = 0;
        let bc = X;
        for (const [cx, hh, ww] of peaks) {
          const q = 1 - ((X - cx) / ww) ** 2;
          if (q > 0 && hh * Math.pow(q, 0.45) > best) {
            best = hh * Math.pow(q, 0.45);
            bc = cx;
          }
        }
        top[x] = base - best - 0.01 * (fbm1(X * 20, 310 + i) - 0.5);
        pk[x] = bc;
      }
      return { top, pk, col, d, base, i };
    });
  }

  prepare(f: Frame) {
    this.f = f;
    const { cols, rows, T, t, W } = f;
    const key = `${cols}x${rows}`;
    if (key !== this.sized) {
      this.build(cols, rows, W);
      this.sized = key;
    }
    this.glow = 0.35 + 0.25 * easeOut(t / 5);
    this.near = new Float32Array(cols);
    const rc9 = this.rc(0.9);
    for (let x = 0; x < cols; x++) {
      const X = x / rows;
      const tt = 0.87 - 0.04 * fbm1(X * 3, 350) - 0.2 * Math.pow(Math.max(0, 1 - X / (0.24 * W)), 1.3) - 0.14 * Math.pow(Math.max(0, (X - 0.8 * W) / (0.2 * W)), 1.2);
      this.near[x] = tt + 0.07 * Math.max(0, 1 - Math.abs(X - rc9) / 0.3) + Math.sin(T * 1.1 + X * 6) * 0.004;
    }
    // Two far birds gliding across the haze.
    this.ov.reset(cols, rows);
    const lead = (((T * 0.022 + 0.2) % 1.4) - 0.2) * W;
    [[0, 0], [0.03, 0.025]].forEach(([dx, dy], i) => {
      const bx = (lead + dx) * rows;
      const by = (0.27 + dy + 0.006 * Math.sin(T * 0.7 + i)) * rows;
      const up = Math.floor(T * 3 + i) % 2 === 0;
      this.ov.set(bx, by, 0x8c9c8e);
      this.ov.set(bx - 1, by - (up ? 1 : 0), 0x8c9c8e);
      this.ov.set(bx + 1, by - (up ? 1 : 0), 0x8c9c8e);
    });
  }

  color(x: number, y: number): number {
    const { rows, T, W } = this.f;
    const X = x / rows;
    const Y = y / rows;
    const ov = this.ov.get(x, y);
    if (ov >= 0) return ov;
    const rc = this.rc(Y);
    const rw = 0.006 + (Y - 0.745) * 0.26;
    if (Y > 0.745 && Math.abs(X - rc) < rw) {
      const v = Math.abs(X - rc) / rw;
      if (v < 0.6 && hash(x, y, 360 + Math.floor(T * 4)) > 0.93) return 0xfffdf2;
      return pick(this.water, 0.15 + v * 0.65 + (Y - 0.745) * 0.4, x, y);
    }
    const nb = this.near[x] + (fbm2(X * 22, Y * 8, 362) - 0.5) * 0.035;
    if (Y >= nb) {
      const sway = Math.sin(T * 0.9 + Y * 4) * 0.012 * Math.max(0, 1 - (Y - nb) / 0.15);
      const stalk = fbm2((X + sway) * 45, Y * 2.5, 363);
      const v = 0.12 + (Y - nb) / 0.3 + (fbm2((X + sway) * 20, Y * 20, 361) - 0.5) * 0.7 + (stalk > 0.64 ? 0.18 : 0) + (X / W) * 0.12;
      let c = pick(this.bamboo, v, x, y);
      const m = (fbm2(X * 3 - T * 0.03, Y * 8, 364) - 0.5) * 3 - (Y - 0.84) * 6 - Math.abs(X - rc) * 2;
      if (m > 0.5) c = mix(c, this.MIST, m > 0.75 ? 0.65 : 0.35);
      return c;
    }
    for (let k = this.layers.length - 1; k >= 0; k--) {
      const L = this.layers[k];
      const t = L.top[x];
      if (Y < t) continue;
      const { d, col: c } = L;
      const side = X - L.pk[x];
      const v = 0.3 + ((Y - t) / (0.12 + 0.1 * d)) * 0.5 + (side > 0 ? 0.22 : -0.1) + (fbm2(X * 18, Y * 18, 330 + L.i) - 0.5) * 0.7 * d;
      let col = pick([mix(c, 0xfffae1, 0.28), mix(c, 0xe6f0c8, 0.1), c, mix(c, 0x0a1408, 0.25), mix(c, 0x050a05, 0.42)], v, x, y);
      if (L.i === 3 && side > -0.09 && side < 0 && Y - t > 0.03 && Y - t < 0.2 && fbm2(X * 9, Y * 4, 340) > 0.5) {
        col = pick(this.rock, v - 0.15 + (fbm2(X * 20, Y * 20, 341) - 0.5) * 0.8, x, y);
      }
      if (Y - t < 1 / rows && side < 0) col = mix(col, 0xfff8dc, 0.35 * (1 - d * 0.5));
      // Mist pooling at each layer's foot, drifting slowly sideways.
      const m = Math.max(0, 1 - Math.abs(Y - (L.base + 0.02)) / 0.09) * (fbm2(X * 2.2 - T * (0.02 + d * 0.015), Y * 5, 320 + L.i) - 0.1) * 2.1;
      if (m > 1.1) return this.MIST;
      if (m > 0.5 + bayer(x, y) * 0.5) return mix(col, this.MIST, 0.6);
      return col;
    }
    const SX = W * 0.1;
    const dsun = Math.hypot(X - SX, (Y - 0.12) * 1.2);
    if (dsun < 0.06) return 0xfffdf5;
    const glow = Math.pow(Math.max(0, 1 - dsun / 1.7), 1.6) * this.glow;
    const cl = fbm2(X * 1.1 - T * 0.015, Y * 4.5, 370) - Math.abs(Y - 0.2) * 2.4;
    if (cl > 0.42) return pick(this.cloudR, (cl - 0.42) * 3 + glow, x, y);
    return pick(this.sky, 0.18 + Y * 0.45 + glow, x, y);
  }
}

// ── 8 · Moonsea: a crescent world rising over still water, a torii ─────────

const TORII = ["KKK.......KKK", "KKKKKKKKKKKKK", ".BBBBBBBBBBB.", "...P..T..P...", ".NNNNNNNNNNN.", "...P.....P...", "...P.....P...", "...P.....P...", "...P.....P..."];

class Moonsea implements Scene {
  ink = hx("#04060D");
  private sky = R("#04060D", "#070B17", "#0B1122", "#10182E", "#16213B", "#1D2B4A", "#263759", "#304468", "#3C5277");
  private litR = R("#8C6E4A", "#C9A673", "#E8CB95", "#FBE7C0", "#FFF6E2");
  private darkR = R("#26324F", "#1E2845", "#18213A", "#131B31");
  private seaR = R("#1C2744", "#141D35", "#0E1528", "#0A0F1E", "#060A14");
  private H = 0.64;
  private R0 = 0.23;
  private moon = { x: 0, y: 0 };
  private stars = new Set<number>();
  private torii = new Overlay();
  private ov = new Overlay();
  private hb = 0;
  private f!: Frame;
  private sized = "";

  private build(cols: number, rows: number, W: number) {
    this.stars.clear();
    const n = Math.round(cols * 0.45);
    for (let i = 0; i < n; i++) this.stars.add(Math.floor(hash(i, 1, 410) * rows * this.H * 0.95) * cols + Math.floor(hash(i, 0, 410) * cols));
    this.torii.reset(cols, rows);
    const tx0 = Math.floor(W * 0.27 * rows) - 6;
    this.hb = Math.floor((this.H + 0.075) * rows);
    TORII.forEach((row, r) => {
      for (let c = 0; c < row.length; c++) {
        if (row[c] === ".") continue;
        this.torii.set(tx0 + c, this.hb - TORII.length + r, r < 2 ? 0x2a1416 : c === 4 || c === 10 ? 0x5a2a24 : 0x3a1a1c);
      }
    });
  }

  prepare(f: Frame) {
    this.f = f;
    const { cols, rows, t, W, px } = f;
    const key = `${cols}x${rows}`;
    if (key !== this.sized) {
      this.build(cols, rows, W);
      this.sized = key;
    }
    // The world lifts out of the sea, then settles.
    this.moon = { x: W * 0.58 - px * 0.01, y: this.H - 0.13 + 0.07 * (1 - easeOut(t / 6)) };
    this.ov.reset(cols, rows);
    if (t > 4.2 && t < 4.9) {
      const p = (t - 4.2) / 0.7;
      const sx = (W * 0.08 + p * W * 0.3) * rows;
      const sy = (0.05 + p * 0.09) * rows;
      for (let k = 0; k < 5; k++) this.ov.set(sx - k * 1.8, sy - k * 0.5, k === 0 ? 0xe8eaf2 : k < 3 ? 0x9aa4c2 : 0x3c5277);
    }
  }

  private above(x: number, y: number): number {
    const { rows, cols, T } = this.f;
    const X = x / rows;
    const Y = y / rows;
    const ov = this.ov.get(x, y);
    if (ov >= 0) return ov;
    const { x: MX, y: MY } = this.moon;
    const R0 = this.R0;
    const OX = MX - 0.045;
    const OY = MY + 0.03;
    const d = Math.hypot(X - MX, Y - MY) / R0;
    if (d < 1) {
      const ds = Math.hypot(X - OX, Y - OY) / R0;
      if (ds > 0.985) return pick(this.litR, 0.15 + Math.min(1, (ds - 0.985) / 0.2) * 0.55 + (d > 0.94 ? 0.3 : 0), x, y);
      return pick(this.darkR, 0.45 + (fbm2(X * 9, Y * 9, 420) - 0.5) * 0.9 - (d > 0.95 ? 0.45 : 0), x, y);
    }
    const v = Math.pow(Y / this.H, 1.3) * 0.9;
    if (d < 1.45) {
      const len = Math.max(1e-6, Math.hypot(X - OX, Y - OY));
      const dir = ((X - OX) - (Y - OY) * 0.25) / len;
      const glow = Math.pow(1 - (d - 1) / 0.45, 2) * Math.max(0, dir) * (0.78 + 0.07 * Math.sin(T * 0.6));
      if (glow > 0.12 + bayer(x, y) * 0.4) return mix(pick(this.sky, v, x, y), 0xb08a5e, glow * 0.75);
    }
    if (this.stars.has(y * cols + x)) {
      const tw = Math.sin(T * (1.4 + hash(x, y, 412) * 2) + x * 1.3);
      return hash(x, y, 411) > 0.75 && tw > -0.4 ? 0xe8eaf2 : mix(pick(this.sky, v, x, y), 0x9aa4c2, 0.35 + 0.25 * tw);
    }
    return pick(this.sky, v, x, y);
  }

  color(x: number, y: number): number {
    const { rows, cols, T } = this.f;
    const X = x / rows;
    const Y = y / rows;
    const tc = this.torii.get(x, y);
    if (tc >= 0) return tc;
    if (Y < this.H) return this.above(x, y);
    const dep = Y - this.H;
    if (y === Math.floor(this.H * rows)) return 0x2c3a5c;
    const RX = this.moon.x + this.R0 * 0.86;
    const lift = clamp01((this.moon.y + this.R0 - this.H) / this.R0 + 1);
    if (Math.abs(X - RX) < 0.012 + dep * 0.09 && hash(x, y, 412 + Math.floor(T * 3)) > 0.4 + dep * 1.3 + (1 - lift) && y % 2 === 0) {
      return hash(x, y, 413) > 0.5 ? 0xf2d6a2 : 0x9c7b52;
    }
    const wob = Math.round(Math.sin(y * 1.7 + T * 1.2) * dep * 4);
    if (y >= this.hb && this.torii.get(Math.min(cols - 1, Math.max(0, x + wob)), 2 * this.hb - y - 1) >= 0) return 0x1a1018;
    let c = pick(this.seaR, dep / 0.32 + (hash(Math.floor(x / 3), y, 414) - 0.5) * 0.25, x, y);
    if (y % 2 === 0 && hash(Math.floor((x + T * 2) / 2), y, 415) > 0.8) c = mix(c, 0x3c5277, 0.35 - dep);
    return c;
  }
}

// ── 9 · Fuji at dawn: snow cap catching pink light, sakura, a still lake ───

class Fuji implements Scene {
  ink = hx("#1E1A2E");
  private sky = R("#2C3766", "#3E4778", "#575A8A", "#76699A", "#97789F", "#B98A9F", "#D49FA1", "#E8B5A4", "#F4CBAA", "#FADDB8", "#FDEBCF");
  private snowLit = R("#FFF4EA", "#FBE0D6", "#EBC4C8", "#C5BCD6", "#A3A0C4", "#8786AE");
  private body = R("#7A7AA4", "#66689A", "#55588A", "#46497A", "#3A3D6A");
  private cloudR = R("#5C5A8A", "#8A709C", "#C98E9E", "#F0B6A6", "#FCDDBE");
  private bloom = R("#FFF2F5", "#FAD6E2", "#F0B3C8", "#DB8DAB", "#B56887", "#7F4762");
  private nearHill = R("#2A3050", "#20253F", "#181C30");
  private farHill = R("#4A4D74", "#3C3F63", "#323556");
  private shoreR = R("#2A2230", "#1E1824", "#140F18");
  private H = 0.68;
  private hill1 = new Float32Array(0);
  private hill2 = new Float32Array(0);
  private shore = new Float32Array(0);
  private clumps: [number, number, number][] = [];
  private ov = new Overlay();
  private f!: Frame;
  private sized = "";
  private FX = 0;
  private SPAN = 0;
  private bloomK = 1;
  private glowK = 0.4;

  private build(cols: number, rows: number, W: number) {
    this.FX = W * 0.58;
    this.SPAN = Math.min(0.95, 0.32 * W);
    this.hill1 = new Float32Array(cols);
    this.hill2 = new Float32Array(cols);
    this.shore = new Float32Array(cols);
    for (let x = 0; x < cols; x++) {
      const X = x / rows;
      this.hill1[x] = 0.615 - 0.035 * fbm1(X * 2 + 3, 430);
      let t = 0.655 - 0.03 * fbm1(X * 3.2 + 8, 431);
      if (hash(x, 0, 432) > 0.55) t -= (1 + Math.floor(hash(x, 0, 433) * 2)) / rows;
      this.hill2[x] = t;
      const l = Math.max(0, 1 - X / (0.24 * W));
      const r = Math.max(0, (X - 0.86 * W) / (0.14 * W));
      this.shore[x] = this.H + 0.32 - 0.32 * Math.min(1, (l + r) * 1.3 + (l + r > 0 ? (fbm1(X * 3, 434) - 0.5) * 0.3 : 0));
    }
    this.clumps = [[0.03 * W, 0.78, 0.13], [0.12 * W, 0.86, 0.15], [0.2 * W, 0.93, 0.11], [0.04 * W, 0.06, 0.12], [0.13 * W, 0.0, 0.11], [0.96 * W, 0.9, 0.11]];
  }

  prepare(f: Frame) {
    this.f = f;
    const { cols, rows, T, t, W } = f;
    const key = `${cols}x${rows}`;
    if (key !== this.sized) {
      this.build(cols, rows, W);
      this.sized = key;
    }
    this.bloomK = 0.55 + 0.45 * easeOut(t / 4);
    this.glowK = 0.22 + 0.2 * easeOut(t / 6);
    // Petals loosed from the blossoms, carried right on the breeze.
    this.ov.reset(cols, rows);
    for (let i = 0; i < 30; i++) {
      const v = 0.03 + hash(i, 0, 440) * 0.03;
      const Y = ((hash(i, 1, 440) + T * v) % 1.1) - 0.05;
      const X = (hash(i, 2, 440) * 0.5 * W + T * (0.02 + hash(i, 3, 440) * 0.02) + Math.sin(T * 1.2 + i) * 0.02) % W;
      this.ov.set(X * rows, Y * rows, Math.sin(T * 2.5 + i) > 0 ? 0xf9d3e0 : 0xefb0c6);
    }
  }

  private ftop(X: number) {
    return 0.2 + 0.48 * Math.pow(Math.min(1, Math.max(0, Math.abs(X - this.FX) - 0.045) / this.SPAN), 0.55);
  }

  private above(x: number, y: number): number {
    const { rows, T, W } = this.f;
    const X = x / rows;
    const Y = y / rows;
    if (Y >= this.hill2[x]) return pick(this.nearHill, (Y - this.hill2[x]) / 0.04, x, y);
    if (Y >= this.hill1[x]) return pick(this.farHill, (Y - this.hill1[x]) / 0.05, x, y);
    const t = this.ftop(X);
    if (Y >= t) {
      const lit = X > this.FX;
      const sl = 0.33 + 0.02 * (fbm1(X * 18, 401) - 0.5) * 2 + 0.1 * Math.max(0, fbm1(X * 30, 402) - 0.5) * 3;
      const gully = fbm1(X * 40, 403) > 0.62 ? 0.12 : 0;
      if (Y < sl) return pick(this.snowLit, (Y - t) / 0.14 + (lit ? 0 : 0.35) + gully, x, y);
      const c = pick(this.body, 0.2 + (lit ? 0 : 0.35) + gully + (fbm2(X * 12, Y * 12, 404) - 0.5) * 0.3, x, y);
      return mix(c, 0xa795b2, Math.max(0, (Y - 0.42) / 0.26) * 0.45);
    }
    const SUNX = W * 0.88;
    const d = Math.hypot(X - SUNX, (Y - this.H) * 1.4);
    const glow = Math.pow(Math.max(0, 1 - d / 1.3), 1.8) * this.glowK;
    const cl = fbm2(X * 0.9 - T * 0.012, Y * 11, 405) - Math.abs(Y - 0.27) * 6;
    if (cl > 0.44) return pick(this.cloudR, 0.15 + Math.max(0, 1 - Math.abs(X - SUNX) / 1.4) * 0.7 + (cl - 0.44) * 2, x, y);
    return pick(this.sky, 0.02 + Math.pow(Y / this.H, 1.1) * 0.85 + glow, x, y);
  }

  color(x: number, y: number): number {
    const { rows, cols, T, W } = this.f;
    const X = x / rows;
    const Y = y / rows;
    const ov = this.ov.get(x, y);
    if (ov >= 0) return ov;
    for (const [cx, cy, r0] of this.clumps) {
      const r = r0 * this.bloomK;
      const sw = Math.sin(T * 0.7 + cx * 3) * 0.004;
      const dx = (X - cx - sw) / r;
      const dy = (Y - cy) / r;
      if (dx * dx + dy * dy > 1.6) continue;
      const dd = Math.hypot(dx, dy) + (fbm2(X * 18, Y * 18, 450 + Math.floor(cx * 10)) - 0.5) * 0.5;
      if (dd < 1) {
        if (hash(x, y, 451) > 0.985) return 0xb56887;
        return pick(this.bloom, 0.25 - dx * 0.2 + dy * 0.3 + (fbm2(X * 30, Y * 30, 452) - 0.5) * 0.7 + dd * 0.15, x, y);
      }
    }
    if (Y >= this.shore[x]) return pick(this.shoreR, (Y - this.shore[x]) / 0.08 + hash(x, y, 453) * 0.3, x, y);
    if (Y < this.H) return this.above(x, y);
    const dep = Y - this.H;
    const SUNX = W * 0.88;
    if (Math.abs(X - SUNX) < 0.05 + dep * 0.6 && hash(x, y, 454 + Math.floor(T * 3)) > 0.45 + dep * 1.4 && y % 2 === 0) {
      return hash(x, y, 455) > 0.5 ? 0xfce3c8 : 0xe8b5a4;
    }
    const wob = Math.round(Math.sin(y * 1.7 + T * 1.2) * dep * 12);
    let c = this.above(Math.min(cols - 1, Math.max(0, x + wob)), Math.max(0, Math.floor((2 * this.H - Y) * rows)));
    c = mix(c, 0x22263e, 0.25 + dep * 0.9);
    if (y % 3 === 0 && hash(Math.floor((x + T * 1.5) / 3), y, 456) > 0.75) c = mix(c, 0xf0c8b8, 0.18);
    return c;
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
  /** Film clock rate: 1 = real time. Slows holds, cuts and motion alike. */
  speed?: number;
  /**
   * Which scenes play, and in what order. `shuffle` (the default) deals the
   * landscapes anew every time the film is created, so Welcome opens on a
   * different scene each launch; `fixed` keeps the authored order (see
   * PIXEL_NATURE_SCENES); a scene id pins that one landscape — it still
   * moves, it just never cuts away.
   */
  order?: PixelNatureOrder;
};

export type PixelNatureSceneId = "dawn" | "forest" | "lake" | "deep" | "meadow" | "pagoda" | "fuji" | "moonsea" | "karst";
export type PixelNatureOrder = "shuffle" | "fixed" | PixelNatureSceneId;

/** The landscapes, in authored order, with the words Settings shows. */
export const PIXEL_NATURE_SCENES: ReadonlyArray<{ id: PixelNatureSceneId; label: string }> = [
  { id: "dawn", label: "Dawn" },
  { id: "forest", label: "Forest" },
  { id: "lake", label: "Lake" },
  { id: "deep", label: "Under the surface" },
  { id: "meadow", label: "Meadow" },
  { id: "pagoda", label: "Autumn temple" },
  { id: "fuji", label: "Fuji at dawn" },
  { id: "moonsea", label: "Moonsea" },
  { id: "karst", label: "Karst valley" },
];

export function isPixelNatureOrder(v: unknown): v is PixelNatureOrder {
  return v === "shuffle" || v === "fixed" || PIXEL_NATURE_SCENES.some((s) => s.id === v);
}

/** Fisher–Yates over a copy; the authored list is never reordered in place. */
function shuffled<T>(items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const GLYPHS = "{}[]<>()/=+*;:#01fnletmutpub&|~$";
const FRAME_MS = 1000 / 30;

export function createPixelNature(canvas: HTMLCanvasElement, opts: PixelNatureOptions = {}) {
  const ctx = canvas.getContext("2d", { alpha: false })!;
  const meadow = new Meadow();
  const byId: Record<PixelNatureSceneId, Scene> = {
    dawn: new Dawn(),
    forest: new Forest(),
    lake: new Lake(),
    deep: new Deep(),
    meadow,
    pagoda: new Pagoda(),
    fuji: new Fuji(),
    moonsea: new Moonsea(),
    karst: new Karst(),
  };
  const authored = PIXEL_NATURE_SCENES.map((s) => byId[s.id]);
  const order = opts.order ?? "shuffle";
  const scenes: Scene[] = order === "fixed" ? authored : order === "shuffle" ? shuffled(authored) : [byId[order]];
  // One pinned landscape never cuts: its clock runs on unwrapped, and every
  // scene's entrance (sunrise, moon lift, blooms) is eased to a rest, so
  // holding it for an hour is the same picture as holding it for a minute.
  const pinned = scenes.length === 1;
  const HOLD = opts.sceneSeconds ?? 8;
  const TRANS = opts.transitionSeconds ?? 1.7;
  const cellCss = opts.cell ?? 13;
  const SPEED = opts.speed ?? 0.5;

  // Low-res frame buffer: one pixel per cell.
  const small = document.createElement("canvas");
  const sctx = small.getContext("2d")!;
  let img: ImageData | null = null;
  let tile: CanvasPattern | null = null;
  let grain: CanvasPattern | null = null;

  let cols = 0;
  let rows = 0;
  let cs = 1;
  let ox = 0;
  let oy = 0;
  let clock = 0;
  let raf = 0;
  let last = 0;
  let acc = 0;
  let still = !!opts.still;
  let px = 0;
  let pxTarget = 0;

  function makeTile() {
    // One cell's worth of texture: hairline seam right/bottom, faint top light.
    const c = document.createElement("canvas");
    c.width = cs;
    c.height = cs;
    const t = c.getContext("2d")!;
    t.fillStyle = "rgba(0,0,0,0.10)";
    t.fillRect(cs - 1, 0, 1, cs);
    t.fillRect(0, cs - 1, cs - 1, 1);
    t.fillStyle = "rgba(255,255,255,0.045)";
    t.fillRect(0, 0, cs - 1, 1);
    tile = ctx.createPattern(c, "repeat");
    const g = document.createElement("canvas");
    g.width = g.height = 192;
    const gc = g.getContext("2d")!;
    const gi = gc.createImageData(192, 192);
    for (let i = 0; i < gi.data.length; i += 4) {
      const v = Math.random() < 0.5 ? 0 : 255;
      gi.data[i] = gi.data[i + 1] = gi.data[i + 2] = v;
      gi.data[i + 3] = Math.floor(Math.random() * 14);
    }
    gc.putImageData(gi, 0, 0);
    grain = ctx.createPattern(g, "repeat");
  }

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    canvas.width = w;
    canvas.height = h;
    // Never finer than 8 CSS px on the big canvas (it would stop reading as
    // mosaic), unless the caller asked for a finer cell — a thumbnail does.
    const target = Math.max(Math.min(8, cellCss), Math.min(cellCss, canvas.clientWidth / 40));
    cs = Math.max(3, Math.round(target * dpr));
    cols = Math.ceil(w / cs);
    rows = Math.ceil(h / cs);
    ox = Math.floor((w - cols * cs) / 2);
    oy = Math.floor((h - rows * cs) / 2);
    small.width = cols;
    small.height = rows;
    img = sctx.createImageData(cols, rows);
    makeTile();
    if (still || raf === 0) draw();
  }

  const frameFor = (t: number): Frame => ({ cols, rows, W: cols / rows, t, T: clock, px });

  function draw() {
    if (!cols || !img) return;
    const n = scenes.length;
    const idx = pinned ? 0 : Math.floor(clock / HOLD) % n;
    const t = pinned ? clock : clock % HOLD;
    const cur = scenes[idx];
    const inTrans = !pinned && t < TRANS && !still;
    const prev = pinned || clock < HOLD ? null : scenes[(idx - 1 + n) % n];
    cur.prepare(frameFor(t));
    if (inTrans && prev) prev.prepare(frameFor(t + HOLD));

    const p = inTrans ? t / TRANS : 1;
    const sweep = idx % 2 === 0;
    const data = img.data;
    const glyphs: number[] = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        let c: number;
        if (p >= 1) c = cur.color(x, y);
        else {
          const dir = sweep ? x / cols : 1 - x / cols;
          const k = clamp01(0.32 * hash(x, y, 99) + 0.68 * (dir * 0.8 + (y / rows) * 0.2));
          const q = (p * 1.25 - k) / 0.25;
          if (q <= 0) c = prev ? prev.color(x, y) : cur.ink;
          else if (q >= 1) c = cur.color(x, y);
          else {
            c = cur.ink;
            glyphs.push(x, y, cur.color(x, y));
          }
        }
        const i = (y * cols + x) * 4;
        data[i] = c >> 16;
        data[i + 1] = (c >> 8) & 255;
        data[i + 2] = c & 255;
        data[i + 3] = 255;
      }
    }
    sctx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, cols, rows, ox, oy, cols * cs, rows * cs);

    if (glyphs.length) {
      ctx.font = `${Math.round(cs * 0.86)}px "Monaspace Neon", "SF Mono", ui-monospace, Menlo, monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const seed = Math.floor(clock * 14);
      for (let i = 0; i < glyphs.length; i += 3) {
        const x = glyphs[i];
        const y = glyphs[i + 1];
        const c = glyphs[i + 2];
        ctx.fillStyle = `rgb(${c >> 16},${(c >> 8) & 255},${c & 255})`;
        ctx.fillText(GLYPHS[Math.floor(hash(x, y, seed) * GLYPHS.length)], ox + x * cs + cs / 2, oy + y * cs + cs / 2 + 0.5);
      }
    }
    // Tile seams, then a grain that shifts every frame so it reads as film.
    if (tile) {
      ctx.save();
      ctx.translate(ox, oy);
      ctx.fillStyle = tile;
      ctx.fillRect(0, 0, cols * cs, rows * cs);
      ctx.restore();
    }
    if (grain && !still) {
      ctx.save();
      ctx.translate(-Math.floor(Math.random() * 192), -Math.floor(Math.random() * 192));
      ctx.fillStyle = grain;
      ctx.fillRect(0, 0, canvas.width + 192, canvas.height + 192);
      ctx.restore();
    }
  }

  function loop(ts: number) {
    raf = requestAnimationFrame(loop);
    if (!last) {
      last = ts;
      return;
    }
    acc += Math.min(100, ts - last);
    last = ts;
    if (acc < FRAME_MS) return;
    clock += (acc / 1000) * SPEED;
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
      // The meadow with every flower open — or, when one landscape is pinned,
      // that landscape once its entrance has settled.
      const at = scenes.indexOf(meadow);
      clock = (at < 0 ? 0 : HOLD * at) + 6.8;
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

  resize();
  return {
    start,
    stop,
    setStill(v: boolean) {
      stop();
      still = v;
      start();
    },
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
