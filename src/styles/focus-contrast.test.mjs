import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Exercise the shipped token values, not copies of the palette in the test.
const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
function declarations(block) {
  return Object.fromEntries(Array.from(block.matchAll(/(--[\w-]+):\s*([^;]+);/g), m => [m[1], m[2].trim()]));
}
const defaults = declarations(css.match(/:root\s*\{([\s\S]*?)\n\}/)[1]);
function tokens(theme) {
  const block = css.match(new RegExp(`:root\\[data-theme="${theme}"\\][^{]*\\{([^}]+)\\}`));
  return { ...defaults, ...declarations(block?.[1] ?? "") };
}
function color(value) {
  if (value.startsWith("#")) return [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16)).concat(1);
  return value.match(/[\d.]+/g).map(Number);
}
function composite(fg, bg) {
  const alpha = fg[3] ?? 1;
  return fg.slice(0, 3).map((v, i) => v * alpha + bg[i] * (1 - alpha));
}
function luminance(rgb) {
  return rgb.slice(0, 3).reduce((total, v, i) => {
    const s = v / 255;
    return total + (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i];
  }, 0);
}
function contrast(fg, bg) {
  const a = luminance(composite(fg, bg)), b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("keyboard focus and readable rail/tab information", () => {
  for (const theme of ["klide-light", "sage-garden", "sage-garden-dark", "cursor-dark", "vscode-dark", "github-light", "cerulean", "solarized-dark"]) {
    it(`${theme}: focus remains distinct on normal, raised, hovered and selected surfaces`, () => {
      const t = tokens(theme), bg = color(t["--bg"]);
      for (const surface of ["--bg", "--bg-elevated", "--bg-hover", "--bg-selected"]) {
        expect(contrast(color(t["--focus-ring"]), composite(color(t[surface]), bg)), `${theme} ${surface}`).toBeGreaterThanOrEqual(3);
      }
    });
    it(`${theme}: secondary text passes on page/raised surfaces, body ink passes on selection`, () => {
      const t = tokens(theme), bg = color(t["--bg"]);
      for (const surface of ["--bg", "--bg-elevated"]) {
        expect(contrast(color(t["--fg-subtle"]), composite(color(t[surface]), bg)), `${theme} ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(color(t["--fg"]), composite(color(t["--bg-selected"]), bg))).toBeGreaterThanOrEqual(4.5);
    });
  }
});
