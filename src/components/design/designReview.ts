// The pure half of Design mode: what a review item is, what task it becomes
// for Kit, and how a page's own CSS custom properties sort into the
// inspector's colour, size and radius scales. No React, no IPC.

export type Rect = { x: number; y: number; w: number; h: number };

/** An element the picker reported — ids are per page load. */
export type Facts = {
  id: number;
  component: string;
  where: string;
  style: { paddingTop: string; paddingRight: string; gap: string; fontSize: string; fontWeight: string; color: string; backgroundColor: string; borderRadius: string };
  text: string | null;
  rect: Rect;
};

type Base = { id: number; epoch: number; elementId: number; component: string; where: string };
export type ReviewItem =
  | (Base & { kind: "edit"; prop: string; label: string; from: string; to: string })
  | (Base & { kind: "comment"; n: number; text: string; resolved: boolean });

/** `--name: value`, resolved in the framed page. */
export type PageTokens = Record<string, string>;

/** The Work turn a review becomes. Exact edits, then requests, grouped by component. */
export function designTask(items: ReviewItem[], extra: string, page: string | null): string {
  const live = items.filter(i => i.kind === "edit" || !i.resolved);
  const groups = new Map<string, string[]>();
  for (const i of live) {
    const line = i.kind === "edit"
      ? `- ${i.where}: ${i.label.toLowerCase()} ${i.from || "(unset)"} → ${i.to}`
      : `- ${i.where}: ${i.text}`;
    const key = i.component || "Page";
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }
  return [
    `Design review${page ? ` of ${page}` : ""}. Apply it to the source: direct edits are exact values someone tried live; comments are requests. ` +
      "Find each element from its component and text, prefer the project's existing tokens (`var(--…)`) over raw values, follow the code's existing styling convention, and change only what is listed.",
    ...[...groups].map(([k, v]) => `${k}\n${v.join("\n")}`),
    extra.trim() && `Also: ${extra.trim()}`,
  ].filter(Boolean).join("\n\n");
}

type Token = { name: string; value: string; short: string; rgb: string };
const COLOR = /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\(|oklab\(|color\(|lab\(|lch\()/i;
const TEXTY = /(^|-)(fg|text|ink|foreground|accent|primary|danger|error|muted)(-|$)/i;
const SURFACE = /(^|-)(bg|background|surface|panel|card|elevated|selected|hover|soft)(-|$)/i;
const SIZE = /(^|-)(fs|font-size|text-size|size-text)(-|$)/i;
const RADIUS = /radius|rounded/i;
const LENGTH = /^-?\d*\.?\d+(px|rem|em)$/;

/** Sort a page's tokens into the inspector's rows, by name and value shape. */
export function sortTokens(tokens: PageTokens, toRgb: (value: string) => string = resolveColor) {
  const entries = Object.entries(tokens).filter(([, v]) => v);
  const pick = (test: (n: string, v: string) => boolean, limit: number): Token[] =>
    entries.filter(([n, v]) => test(n, v)).slice(0, limit).map(([name, value]) => ({ name, value, short: shortName(name), rgb: COLOR.test(value) ? toRgb(value) : "" }));
  const isColor = (_: string, v: string) => COLOR.test(v);
  const byPx = (a: Token, b: Token) => toPx(a.value) - toPx(b.value);
  return {
    text: pick((n, v) => isColor(n, v) && TEXTY.test(n) && !SURFACE.test(n), 8),
    surface: pick((n, v) => isColor(n, v) && SURFACE.test(n) && !/(word|diff|chart|code)/.test(n), 8),
    sizes: pick((n, v) => SIZE.test(n) && LENGTH.test(v), 7).sort(byPx),
    radii: pick((n, v) => RADIUS.test(n) && LENGTH.test(v), 6).sort(byPx),
  };
}

function shortName(name: string) {
  return name.replace(/^--/, "").replace(/^(fs|font-size|text|radius|rounded)-/, "");
}
function toPx(v: string) {
  const n = parseFloat(v);
  return v.endsWith("rem") || v.endsWith("em") ? n * 16 : n;
}
/** Computed `rgb()` of a colour, to compare with what getComputedStyle reports. */
function resolveColor(value: string): string {
  if (typeof document === "undefined") return value;
  const probe = document.createElement("span");
  probe.style.color = value;
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color;
  probe.remove();
  return rgb;
}

// ── which conversations get Design mode ─────────────────────────────────────
const UI_FILE = /[\w./-]+\.(tsx|jsx|vue|svelte|astro|html|css|scss|sass|less)\b/i;
const UI_WORDS = /\b(ui|ux|design|layout|css|styles?|styling|buttons?|screens?|pages?|components?|interface|spacing|padding|margins?|colou?rs?|fonts?|typography|themes?|dark mode|light mode|responsive|navbar|sidebar|modals?|cards?|icons?|animations?|landing)\b/i;

type ConversationMsg = { role: string; content?: unknown; toolCalls?: { args?: unknown }[] };

/** A conversation is about the interface when you talk about it or the work
 *  touches files that render: an on-screen word in your messages, or an
 *  interface file in any message or tool call. Design mode is offered only
 *  there — elsewhere it would be a canvas with nothing to say. */
export function isInterfaceConversation(msgs: ConversationMsg[]): boolean {
  return msgs.some(m => {
    const text = typeof m.content === "string" ? m.content : "";
    if (m.role === "user" && UI_WORDS.test(text)) return true;
    if (UI_FILE.test(text)) return true;
    return (m.toolCalls ?? []).some(c => UI_FILE.test(typeof c.args === "string" ? c.args : JSON.stringify(c.args ?? "")));
  });
}

/** The dock's width for a window this wide: room for a page, never the whole window. */
export function designDockWidth(windowWidth: number): number {
  return Math.round(Math.min(1100, Math.max(560, windowWidth * 0.58), windowWidth - 360));
}

// ── how to run the project ──────────────────────────────────────────────────
const RUN_SCRIPTS = ["dev", "start", "serve", "preview"];

/** The dev command a project declares: its package manager (from the lockfile
 *  beside package.json) running the first of dev / start / serve / preview. */
export function devCommand(packageJson: string, files: string[]): string | null {
  let scripts: Record<string, unknown>;
  try { scripts = (JSON.parse(packageJson) as { scripts?: Record<string, unknown> }).scripts ?? {}; } catch { return null; }
  const script = RUN_SCRIPTS.find(name => typeof scripts[name] === "string");
  if (!script) return null;
  const has = (f: string) => files.includes(f);
  const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun" : "npm";
  return pm === "yarn" ? `yarn ${script}` : `${pm} run ${script}`;
}
