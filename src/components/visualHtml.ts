// Model-authored HTML, rendered inside the conversation instead of shown as
// source. The renderer is the trust boundary: a model writes this markup from
// text it read (a file, a tool result, a page), so it is attacker-influenceable
// and never goes into the DOM as-is.
//
// Two things have to hold before that markup can share the app's document:
//
//   1. Nothing executes. An allowlist keeps a known set of layout/SVG
//      elements and drops the rest whole — script, iframe, form, media — plus
//      every `on*` handler and every non-`#`/`data:` URL.
//   2. Nothing escapes the block. A `<style>` in the source would otherwise
//      restyle the whole app, so its rules are lifted out and every selector
//      is re-anchored under the block's own scope class. Element ids are
//      suffixed the same way, so two visuals in one conversation can both
//      define `#arrow` and each keeps its own.
//
// Pure string work on purpose: no DOMParser, so the rules are testable in a
// plain Node test run and identical in the webview.

/**
 * What the model wrote. A `drawing` is a diagram — it sits on the conversation's
 * own ground with nothing around it. A `page` is a document: the source declared
 * one (a doctype, an `<html>`/`<body>` wrapper, a `:root`/`body` rule), so it
 * gets a page back — a ground, a hairline, and gutters. Nothing is inferred
 * from shape; a page is a page because its author said so.
 */
export type VisualKind = "drawing" | "page";

export type VisualHtml = {
  /** Sanitized markup — safe for `dangerouslySetInnerHTML`. */
  html: string;
  /** Every `<style>` body, merged, selectors scoped to the block. */
  css: string;
  /** Element names removed whole, deduped, for the "not rendered" note. */
  dropped: string[];
  /** Whether the source declared a document or a drawing. */
  kind: VisualKind;
};

// Structure, text, tables, and the SVG drawing vocabulary. Anything that
// loads, submits, executes, or plays is absent by construction.
const ALLOWED_TAGS = new Set([
  // document structure
  "div", "span", "p", "section", "article", "header", "footer", "main", "aside",
  "nav", "figure", "figcaption", "details", "summary", "hr", "br", "wbr",
  "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "code", "kbd", "samp",
  // text
  "a", "b", "strong", "i", "em", "u", "s", "small", "sub", "sup", "mark", "abbr",
  "cite", "q", "time", "var", "dfn", "label",
  // lists + tables
  "ul", "ol", "li", "dl", "dt", "dd",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "col", "colgroup",
  // media that cannot fetch anything but a data: URI
  "img", "picture",
  // svg
  "svg", "g", "defs", "desc", "title", "symbol", "use", "marker", "foreignobject",
  "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan", "textpath",
  "lineargradient", "radialgradient", "stop", "clippath", "mask", "pattern",
  "filter", "fegaussianblur", "feoffset", "feblend", "fecolormatrix",
  "fecomposite", "fedropshadow", "feflood", "femerge", "femergenode",
  "femorphology", "feturbulence", "fedisplacementmap",
]);

// Dropped with everything inside them. The rest of the drop list (a stray
// `<input>`, say) is handled by the allowlist: the tag goes, its text stays.
const DROP_SUBTREE = new Set([
  "script", "noscript", "iframe", "object", "embed", "template", "form",
  "video", "audio", "canvas", "applet", "frame", "frameset", "map", "select",
  "textarea", "button",
]);

// A page's own skeleton. These wrap content rather than being content, so they
// are unwrapped — not reported as dropped, which would put "body, head, html
// not rendered" under every page a model writes. Seeing one is also how the
// block learns a document was meant.
const PAGE_WRAPPERS = new Set(["html", "head", "body"]);

// Head metadata renders nothing anywhere. Naming it in the "not rendered" note
// would be noise about something no reader expected to see.
const SILENT_DROP = new Set(["meta", "link", "base"]);

// `<style>` is neither kept nor dropped — it is lifted out and scoped.
const STYLE_TAG = "style";

// A stylesheet can declare a page without any markup saying so.
const ROOT_RULE_RE = /(?:^|[},])\s*(?::root|html|body)\b/i;

// The page's own ground, wherever it wrote it: a `body`/`html`/`:root` rule, or
// the wrapper's own style attribute.
const GROUND_RULE_RE = /(?:^|[},>])\s*(?::root|html|body)\b[^{}]*\{([^}]*)\}/gi;
const GROUND_ATTR_RE = /<body\b[^>]*\sstyle\s*=\s*("[^"]*"|'[^']*')/i;

/**
 * Whether the source was written on a dark ground. Read once, before anything
 * is rewritten, because the page's own background is the only thing that says
 * which world its neutrals came from — and the block drops that background.
 */
function authoredDark(source: string): boolean {
  const grounds: string[] = [];
  GROUND_RULE_RE.lastIndex = 0;
  for (let m = GROUND_RULE_RE.exec(source); m; m = GROUND_RULE_RE.exec(source)) grounds.push(m[1]);
  const attr = GROUND_ATTR_RE.exec(source);
  if (attr) grounds.push(attr[1].slice(1, -1));
  for (const decls of grounds) {
    const background = BACKGROUND_DECL_RE.exec(decls);
    const color = background && parseColor(background[1].trim());
    if (color && color.a > 0.5) return lightnessOf(color) < 0.5;
  }
  return false;
}

// Attributes that carry a URL, a form target, or a legacy fetch. Names not
// listed here pass the generic shape check below, which is what gives the SVG
// presentation vocabulary (stroke-dasharray, dominant-baseline, marker-end …)
// through without enumerating three hundred names.
const URL_ATTRS = new Set(["href", "xlink:href", "src", "srcset", "poster", "background", "ping", "action", "formaction", "data", "codebase", "lowsrc", "dynsrc"]);

// SVG's color-bearing presentation attributes.
const COLOR_ATTRS = new Set(["fill", "stroke", "color", "stop-color", "flood-color", "lighting-color"]);

const TEXT_TAGS = new Set(["text", "tspan", "textpath"]);
// Closed primitives read as boxes; a path or a polyline is nearly always a line.
const BOX_TAGS = new Set(["rect", "circle", "ellipse", "polygon"]);
const STROKE_TAGS = new Set(["path", "polyline", "line"]);

// On an attribute the element itself says what the color is for — no guessing.
function attrColorRole(tag: string, attr: string): ColorRole {
  if (attr === "stroke") return "line";
  if (attr === "color" || TEXT_TAGS.has(tag)) return "ink";
  if (attr === "fill") return "surface";
  return "auto";
}

const ATTR_NAME_RE = /^(?:xlink:href|xml:space|xmlns(?::xlink)?|[A-Za-z][A-Za-z0-9-]*)$/;

const TAG_OPEN_RE = /^<([A-Za-z][A-Za-z0-9-]*)/;
const TAG_CLOSE_RE = /^<\/([A-Za-z][A-Za-z0-9-]*)\s*>/;

/**
 * Sanitize model markup and scope its CSS to one block.
 *
 * `scope` is the block's own class name (also the suffix every id and id
 * reference gets), so two visuals in one conversation never collide.
 */
export function prepareVisual(source: string, scope: string): VisualHtml {
  const dropped = new Set<string>();
  const styles: string[] = [];
  const drawingWidths: number[] = [];
  let out = "";
  let i = 0;
  let page = false;
  const invert = authoredDark(source);
  // `<title>` is the one name that means two things: a tooltip inside a
  // drawing, the document's name outside one. Only the first is content, so
  // the block has to know which side of an `<svg>` it is reading.
  let svgDepth = 0;

  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt < 0) {
      out += escapeText(source.slice(i));
      break;
    }
    out += escapeText(source.slice(i, lt));
    const rest = source.slice(lt);

    // Comments and doctypes carry nothing we render.
    if (rest.startsWith("<!--")) {
      const end = source.indexOf("-->", lt + 4);
      i = end < 0 ? source.length : end + 3;
      continue;
    }
    if (rest.startsWith("<!") || rest.startsWith("<?")) {
      if (/^<!doctype\s+html/i.test(rest)) page = true;
      const end = source.indexOf(">", lt);
      i = end < 0 ? source.length : end + 1;
      continue;
    }

    const close = TAG_CLOSE_RE.exec(rest);
    if (close) {
      // SVG is case-sensitive — `foreignObject`, `linearGradient`, `clipPath`.
      // Case is folded to look a name up and never to write one out.
      const closing = close[1].toLowerCase();
      if (closing === "svg") svgDepth = Math.max(0, svgDepth - 1);
      if (ALLOWED_TAGS.has(closing)) out += `</${close[1]}>`;
      i = lt + close[0].length;
      continue;
    }

    const open = TAG_OPEN_RE.exec(rest);
    if (!open) {
      // A bare `<` in prose. Text, not markup.
      out += "&lt;";
      i = lt + 1;
      continue;
    }

    const name = open[1].toLowerCase();
    const written = open[1];
    const tagEnd = findTagEnd(source, lt + open[0].length);
    const raw = source.slice(lt + open[0].length, tagEnd.attrsEnd);

    if (name === STYLE_TAG) {
      const body = readRawText(source, tagEnd.end, STYLE_TAG);
      styles.push(body.text);
      i = body.end;
      continue;
    }
    if (PAGE_WRAPPERS.has(name)) {
      page = true;
      i = tagEnd.end;
      continue;
    }
    if (SILENT_DROP.has(name)) {
      i = tagEnd.end;
      continue;
    }
    if (name === "title" && svgDepth === 0) {
      i = readRawText(source, tagEnd.end, name).end;
      continue;
    }
    if (DROP_SUBTREE.has(name)) {
      dropped.add(name);
      const body = readRawText(source, tagEnd.end, name);
      i = body.end;
      continue;
    }
    if (!ALLOWED_TAGS.has(name)) {
      dropped.add(name);
      i = tagEnd.end;
      continue;
    }

    if (name === "svg") {
      if (!tagEnd.selfClosing) svgDepth++;
      const viewBox = /viewbox\s*=\s*["']?\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)/i.exec(raw);
      if (viewBox) drawingWidths.push(Number(viewBox[1]));
    }
    const attrs = sanitizeAttrs(raw, name, scope, invert);
    out += `<${written}${attrs}${tagEnd.selfClosing ? "/>" : ">"}`;
    i = tagEnd.end;
  }

  const authored = styles.join("\n");
  if (ROOT_RULE_RE.test(authored)) page = true;
  return {
    html: out,
    // The block's own rules come first so the drawing's can override them.
    css: responsiveBase(scope, drawingWidths) + (authored ? scopeCss(authored, scope, invert) : ""),
    dropped: [...dropped].sort(),
    kind: page ? "page" : "drawing",
  };
}

/**
 * A drawing has to fit the column it lands in — an AI panel is 360px wide and
 * Focus is twice that — so a fixed `width="680"` is overridden and every
 * viewBox drawing is made fluid, capped at its authored drawing width.
 *
 * Fluid down to a floor, not all the way: a 680-unit diagram squeezed into a
 * narrow panel scales its 12px type to 6px, which is adaptable and unreadable.
 * Below the floor the block scrolls instead, and the type stays legible.
 */
const LEGIBLE_FLOOR = 520;

function responsiveBase(scope: string, drawingWidths: number[]): string {
  const widest = drawingWidths.length ? Math.max(...drawingWidths) : 0;
  const floor = Math.min(widest, LEGIBLE_FLOOR);
  return (
    `.${scope} svg{max-width:100%;height:auto}` +
    `.${scope} svg[viewBox]{width:100%${floor ? `;min-width:${Math.round(floor)}px` : ""}}` +
    (widest ? `.${scope} svg[viewBox]{max-width:${Math.round(widest)}px}` : "") +
    `.${scope} img,.${scope} table,.${scope} pre{max-width:100%}` +
    // A label that crosses a line or a shape is read through it. The halo is
    // the ground's own color drawn behind the glyphs — invisible where nothing
    // overlaps, and the difference between legible and not where something
    // does. Sized in em so it holds at any viewBox scale.
    `.${scope} svg text{paint-order:stroke fill;stroke:var(--viz-surface);stroke-width:0.22em;stroke-linejoin:round}`
  );
}

function escapeText(text: string): string {
  return text.replace(/</g, "&lt;");
}

// Walk to the `>` that closes an open tag, respecting quoted attribute values
// so a `>` inside `style="..."` does not end the tag early.
function findTagEnd(src: string, from: number): { attrsEnd: number; end: number; selfClosing: boolean } {
  let i = from;
  let quote = "";
  while (i < src.length) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      const before = src.slice(from, i);
      const selfClosing = before.trimEnd().endsWith("/");
      const attrsEnd = selfClosing ? from + before.trimEnd().length - 1 : i;
      return { attrsEnd, end: i + 1, selfClosing };
    }
    i++;
  }
  return { attrsEnd: src.length, end: src.length, selfClosing: false };
}

// Everything up to the matching close tag, dropped or lifted as one piece.
function readRawText(src: string, from: number, tag: string): { text: string; end: number } {
  const close = new RegExp(`</${tag}\\s*>`, "i");
  const tail = src.slice(from);
  const m = close.exec(tail);
  if (!m) return { text: tail, end: src.length };
  return { text: tail.slice(0, m.index), end: from + m.index + m[0].length };
}

const ATTR_RE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function sanitizeAttrs(raw: string, tag: string, scope: string, invert: boolean): string {
  let out = "";
  let m: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(raw))) {
    const written = m[1];
    const name = written.toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    if (!ATTR_NAME_RE.test(name)) continue;
    // Every event handler, under every spelling.
    if (name.startsWith("on")) continue;
    if (name === "style") {
      const decls = sanitizeDeclsPaired(value, scope, invert);
      if (decls) out += ` ${written}="${quote(decls)}"`;
      continue;
    }
    if (name === "id") {
      out += ` ${written}="${quote(namespaceId(value, scope))}"`;
      continue;
    }
    if (URL_ATTRS.has(name)) {
      const url = safeVisualUrl(value, tag, scope);
      if (url) out += ` ${written}="${quote(url)}"`;
      continue;
    }
    // Values elsewhere can still reference an id: `fill="url(#grad)"`,
    // `filter="url(#blur)"`, `clip-path="url(#cut)"`.
    // `fill="var(--surface)"` is the same guess in attribute clothing, and
    // `fill="#e9e5dc"` the same hardcoded surface.
    let rewritten = value.includes("url(#") ? namespaceUrlRefs(value, scope) : value;
    if (rewritten.includes("var(--")) rewritten = withTokenFallbacks(rewritten);
    if (COLOR_ATTRS.has(name)) rewritten = normalizeColors(rewritten, attrColorRole(tag, name), invert);
    out += rewritten ? ` ${written}="${quote(rewritten)}"` : ` ${written}`;
  }
  // A link that survives leaves the app, so it never carries a referrer or an
  // opener back to the window it came from.
  if (tag === "a" && /\shref="/.test(out)) out += ' rel="noreferrer noopener" target="_blank"';
  // SVG's initial fill is black: invisible on a dark ground, wrong on a light
  // one. The default belongs per element, not inherited from the root — a
  // shape with no fill is an outline, while a label with no fill is ink. Both
  // are written as presentation attributes, the weakest layer in SVG, so any
  // rule the model wrote still wins over them.
  if (!/\sfill=/i.test(out)) {
    const stroked = /\sstroke=/i.test(out);
    if (BOX_TAGS.has(tag)) {
      // A closed shape with no fill *and* no stroke is a box the model expected
      // the black default to draw. Left as `none` it disappears entirely, so it
      // gets the box treatment — a raised surface and an outline that measure
      // 14.7:1 for its label and 3.1:1 for its edge. With a stroke of its own
      // it was always meant to be an outline.
      out += stroked ? ' fill="none"' : ' fill="var(--viz-surface-2)" stroke="var(--viz-line)"';
    } else if (STROKE_TAGS.has(tag)) {
      out += ' fill="none"';
    } else if (TEXT_TAGS.has(tag)) {
      out += ' fill="var(--viz-ink)"';
    }
  }
  // SVG's stroke default is `none`, so a line whose color lives in a class the
  // drawing forgot to define is drawn as nothing at all — the arrows vanish
  // and the boxes they connect look unrelated. A line that paints no interior
  // has to have an edge, or it is not a line.
  if (STROKE_TAGS.has(tag) && !/\sstroke=/i.test(out) && /\sfill="none"/i.test(out)) {
    out += ' stroke="var(--viz-line)"';
  }
  return out;
}

function quote(value: string): string {
  return value.replace(/"/g, "&quot;");
}

function namespaceId(id: string, scope: string): string {
  return `${id.trim()}-${scope}`;
}

function namespaceUrlRefs(value: string, scope: string): string {
  return value.replace(/url\(\s*(['"]?)#([^)'"]+)\1\s*\)/g, (_all, q, id) => `url(${q}#${namespaceId(id, scope)}${q})`);
}

/**
 * A URL a visual may point at: a fragment inside itself, an inline image, or
 * an ordinary web link. Everything else — `javascript:`, `file:`, a bare
 * relative path into the app's own origin — resolves to nothing.
 */
export function safeVisualUrl(value: string, tag: string, scope: string): string | null {
  const url = value.trim();
  if (url.startsWith("#")) return `#${namespaceId(url.slice(1), scope)}`;
  if (tag === "img" || tag === "image") {
    return /^data:image\/(png|jpe?g|gif|webp|svg\+xml|avif);base64,[A-Za-z0-9+/=\s]*$/i.test(url) ? url : null;
  }
  if (tag === "a") return /^https?:\/\//i.test(url) || /^mailto:/i.test(url) ? url : null;
  return null;
}

// A model writes `var(--surface)` or `var(--text-muted)` because that is what
// most design systems call those things. Klide calls them something else, and
// an unresolved custom property does not degrade politely: an invalid `fill`
// in SVG paints **black**, so one guessed name turns a diagram into a row of
// black slabs on a dark background.
//
// A `var()` fallback is consulted only when the property is undefined, so one
// is appended to every reference that lacks one. A name Klide really defines
// keeps its own value and the guess is never read; a name it doesn't lands on
// the nearest Klide token instead of on black.
const TOKEN_FALLBACKS: [RegExp, string][] = [
  [/mono|code|tt\b/, "var(--font-mono)"],
  [/font|family|typeface/, "var(--font-ui)"],
  [/radius|rounded|corner/, "var(--radius-md)"],
  [/shadow|elevation/, "none"],
  [/success|good|pass|positive|ok\b|green|add\b/, "var(--viz-success)"],
  [/warn|caution|amber|yellow|pending/, "var(--viz-warning)"],
  [/danger|error|fail|critical|negative|red\b|destructive|remove/, "var(--viz-danger)"],
  [/accent|primary|brand|link|highlight|active|focus/, "var(--viz-accent)"],
  [/border|outline|divider|rule\b|hairline|stroke|grid/, "var(--viz-line)"],
  [/bg|background|surface|card|panel|paper|canvas|elevated|fill|sheet|layer/, "var(--viz-surface)"],
  [/muted|dim|subtle|faint|placeholder|tertiary|weak|caption|meta/, "var(--viz-ink-dim)"],
  [/text|fg|foreground|ink|heading|title|label|body|strong/, "var(--viz-ink)"],
];

// Anything with no clue in its name inherits the text color, which is readable
// on the surface the block sits on whatever the theme is.
const LAST_RESORT = "currentColor";

function fallbackFor(token: string): string {
  const name = token.toLowerCase();
  const series = /(?:chart|series|cat|color|colour|hue|lane|step)-?([1-9])/.exec(name);
  if (series) return `var(--chart-${series[1]})`;
  for (const [pattern, value] of TOKEN_FALLBACKS) if (pattern.test(name)) return value;
  return LAST_RESORT;
}

/** Give every `var(--x)` without a fallback one, so no name can render black. */
export function withTokenFallbacks(value: string): string {
  return value.replace(/var\(\s*(--[A-Za-z0-9_-]+)\s*\)/g, (_all, token: string) =>
    // A `--viz-*` name is one this renderer defines; it always resolves.
    token.startsWith("--viz-") || fallbackFor(token) === `var(${token})`
      ? `var(${token})`
      : `var(${token}, ${fallbackFor(token)})`,
  );
}

// The other half of the same problem: a model that doesn't guess a token name
// writes a hex instead. It hardcodes the box (`#e9e5dc`) and leaves the label to
// a token — so under a dark theme the drawing is bone boxes under near-white
// ink, present and unreadable. A drawing cannot be half-themed.
//
// So a literal color is read for what it *means* and re-expressed in the
// palette: a light neutral is a surface, a dark neutral is ink, and a saturated
// hue keeps its hue. The polarity then follows the theme, because every color
// in the drawing now comes from one set chosen for one ground — and two colors
// a model chose to be different stay different.

const NAMED_COLORS: Record<string, string> = {
  white: "#ffffff", ivory: "#fffff0", snow: "#fffafa", beige: "#f5f5dc",
  whitesmoke: "#f5f5f5", linen: "#faf0e6", ghostwhite: "#f8f8ff", azure: "#f0ffff",
  lightgray: "#d3d3d3", lightgrey: "#d3d3d3", gainsboro: "#dcdcdc", silver: "#c0c0c0",
  gray: "#808080", grey: "#808080", dimgray: "#696969", dimgrey: "#696969",
  darkgray: "#a9a9a9", darkgrey: "#a9a9a9", black: "#000000",
  red: "#ff0000", crimson: "#dc143c", tomato: "#ff6347", firebrick: "#b22222",
  orange: "#ffa500", coral: "#ff7f50", gold: "#ffd700", yellow: "#ffff00",
  green: "#008000", limegreen: "#32cd32", seagreen: "#2e8b57", teal: "#008080",
  cyan: "#00ffff", aqua: "#00ffff", steelblue: "#4682b4", blue: "#0000ff",
  navy: "#000080", royalblue: "#4169e1", indigo: "#4b0082", purple: "#800080",
  violet: "#ee82ee", magenta: "#ff00ff", pink: "#ffc0cb", brown: "#a52a2a",
};

type Rgba = { r: number; g: number; b: number; a: number };

function parseColor(value: string): Rgba | null {
  const raw = (NAMED_COLORS[value.trim().toLowerCase()] ?? value.trim()).toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/.exec(raw);
  if (short) {
    const at = (h: string) => parseInt(h + h, 16);
    return { r: at(short[1]), g: at(short[2]), b: at(short[3]), a: short[4] ? at(short[4]) / 255 : 1 };
  }
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/.exec(raw);
  if (long) {
    return {
      r: parseInt(long[1], 16), g: parseInt(long[2], 16), b: parseInt(long[3], 16),
      a: long[4] ? parseInt(long[4], 16) / 255 : 1,
    };
  }
  const fn = /^rgba?\(\s*([0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)(?:[\s,/]+([0-9.%]+))?\s*\)$/.exec(raw);
  if (fn) {
    const alpha = fn[4] ? (fn[4].endsWith("%") ? Number(fn[4].slice(0, -1)) / 100 : Number(fn[4])) : 1;
    return { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]), a: alpha };
  }
  const hsl = /^hsla?\(\s*([-0-9.]+)(?:deg)?[\s,]+([0-9.]+)%[\s,]+([0-9.]+)%(?:[\s,/]+([0-9.%]+))?\s*\)$/.exec(raw);
  if (hsl) {
    const alpha = hsl[4] ? (hsl[4].endsWith("%") ? Number(hsl[4].slice(0, -1)) / 100 : Number(hsl[4])) : 1;
    return { ...hslToRgb(Number(hsl[1]), Number(hsl[2]) / 100, Number(hsl[3]) / 100), a: alpha };
  }
  return null;
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

/** Perceived lightness, 0–1. Yellow reads far lighter than blue at equal RGB. */
function lightnessOf({ r, g, b }: Rgba): number {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function saturationOf({ r, g, b }: Rgba): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

function hueOf({ r, g, b }: Rgba): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
}

// Hue → the palette entry that keeps both the color's meaning and its distance
// from its neighbours. Red is danger *and* categorical red; the drawing reads
// the same either way.
const HUES: [number, number, string][] = [
  [345, 12, "--viz-danger"],
  [12, 32, "--viz-2"],
  [32, 70, "--viz-warning"],
  [70, 165, "--viz-success"],
  [165, 200, "--viz-5"],
  [200, 242, "--viz-accent"],
  [242, 310, "--viz-7"],
  [310, 345, "--viz-8"],
];

const COLOR_LITERAL_RE =
  /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\([^)]*\)|\b[a-z]{3,20}\b/g;

const KEYWORD_RE = /^(?:currentcolor|transparent|inherit|none|initial|unset|auto|solid|dashed|dotted)$/i;

/**
 * What a color is doing where it was written. Lightness says how light a color
 * is, never what it is *for* — `#d6d1c6` is a surface on a box and a hairline
 * on a stroke, and only the property it sits on can tell the two apart.
 */
export type ColorRole = "surface" | "ink" | "line" | "auto";

// A neutral is re-expressed by role first and lightness second, so the drawing
// keeps its structure while its polarity follows the theme: a light box becomes
// the elevated surface (dark under a dark theme) and dark ink becomes near-white.
const NEUTRALS: Record<ColorRole, [number, string][]> = {
  // [at or above this lightness, this token]
  surface: [[0.72, "--viz-surface"], [0.45, "--viz-surface-2"], [0.28, "--viz-ink-dim"], [0, "--viz-ink"]],
  ink: [[0.72, "--viz-surface"], [0.45, "--viz-ink-dim"], [0, "--viz-ink"]],
  line: [[0.2, "--viz-line"], [0, "--viz-ink"]],
  auto: [[0.72, "--viz-surface"], [0.45, "--viz-line"], [0.28, "--viz-ink-dim"], [0, "--viz-ink"]],
};

/**
 * The ramp above reads a neutral as a drawing on paper does — light is surface,
 * dark is ink. A page authored on a dark ground says the opposite with the same
 * hexes: `#151515` is its *raised* box and `#f2f2f2` is its text. Read straight,
 * every one of them flips, and the page comes back half-themed — a near-white
 * slab across a dark theme with its own label invisible on it.
 *
 * The page already told us which world it was written in, in the `body`
 * background the block drops. So a dark-authored page has its neutrals read
 * against that ground, and only its neutrals: a hue means the same thing on
 * either ground.
 */
function paletteToken(color: Rgba, role: ColorRole, invert = false): { token: string; chromatic: boolean } {
  if (saturationOf(color) < 0.14) {
    const lightness = invert ? 1 - lightnessOf(color) : lightnessOf(color);
    return { token: NEUTRALS[role].find(([from]) => lightness >= from)?.[1] ?? "--viz-ink", chromatic: false };
  }
  const hue = hueOf(color);
  const match = HUES.find(([from, to]) => (from > to ? hue >= from || hue < to : hue >= from && hue < to));
  return { token: match?.[2] ?? "--viz-accent", chromatic: true };
}

// How much of a chroma survives when it is asked to be a surface. Both
// references keep full-strength color for ink and lines and dim it for fills —
// Claude Code ships `diffAddedDimmed` / `diffRemovedDimmed` for exactly this —
// because a full-strength slab shouts and takes its own label down with it.
const TINT = 16;

/** One literal color, re-expressed in the visual palette. */
export function normalizeColor(literal: string, role: ColorRole = "auto", invert = false): string | null {
  const color = parseColor(literal);
  if (!color) return null;
  const { token, chromatic } = paletteToken(color, role, invert);
  if (chromatic && role === "surface") return `color-mix(in srgb, var(${token}) ${TINT}%, var(--viz-surface))`;
  // A wash stays a wash: a 6% black tint must not come back as solid ink.
  return color.a < 0.92
    ? `color-mix(in srgb, var(${token}) ${Math.round(color.a * 100)}%, transparent)`
    : `var(${token})`;
}

// `context-stroke` and `context-fill` mean "whatever the element I am attached
// to is painted with" — the idiomatic way to write an arrowhead that follows
// its line. Chrome and Firefox implement them; WebKit does not, and Klide draws
// in a WKWebView, where the value is invalid and the arrowhead is painted with
// nothing at all. Every connector then stops short of its box with no head on
// it, which reads as a diagram whose lines don't reach. The line color is what
// the keyword would have resolved to here anyway.
const CONTEXT_PAINT_RE = /\bcontext-(?:stroke|fill)\b/gi;

/** Every literal color in one value, onto the palette. */
export function normalizeColors(value: string, role: ColorRole = "auto", invert = false): string {
  return value.replace(CONTEXT_PAINT_RE, "var(--viz-line)").replace(COLOR_LITERAL_RE, (literal) =>
    KEYWORD_RE.test(literal) ? literal : (normalizeColor(literal, role, invert) ?? literal),
  );
}

// The same dimming for a chroma the model named itself: `background:
// var(--viz-danger)` is the loud slab written in the palette's own words.
const CHROMA_TOKEN_RE = /var\(\s*(--viz-(?:danger|warning|success|accent|[1-8]))\s*\)/g;

function softenChroma(value: string, role: ColorRole): string {
  // A drawing that mixed its own tint already said what it wanted.
  if (role !== "surface" || /color-mix/i.test(value)) return value;
  return value.replace(CHROMA_TOKEN_RE, (_all, token: string) => `color-mix(in srgb, var(${token}) ${TINT}%, var(--viz-surface))`);
}

const ROLE_BY_PROPERTY: [RegExp, ColorRole][] = [
  [/^(?:background|background-color)$/, "surface"],
  [/^(?:color|caret-color|stop-color|flood-color|lighting-color)$/, "ink"],
  [/^(?:border|border-[a-z-]*color|border-[a-z]+|outline|outline-color|stroke|column-rule|column-rule-color|text-decoration-color)$/, "line"],
];

/**
 * `fill` is the ambiguous one: it paints a box and it paints a label. Its
 * neighbours in the same rule settle it — a rule that also sets a stroke is
 * drawing a shape, one that sets type is drawing a label.
 */
function fillRole(decls: string): ColorRole {
  const shape = /(?:^|[;\s])stroke(?:-width)?\s*:/i.test(decls);
  const type = /(?:^|[;\s])(?:font-|text-anchor|letter-spacing|dominant-baseline)/i.test(decls);
  if (type && !shape) return "ink";
  if (shape) return "surface";
  return "auto";
}

/** Each declaration's colors, normalized for what that declaration paints. */
function normalizeDeclColors(decls: string, invert: boolean): string {
  return decls
    .split(";")
    .map((decl) => {
      const split = decl.indexOf(":");
      if (split < 0) return decl;
      const property = decl.slice(0, split).trim().toLowerCase();
      const value = decl.slice(split + 1);
      if (!/#|\(|[a-z]{3}/i.test(value)) return decl;
      const role =
        property === "fill" ? fillRole(decls) : (ROLE_BY_PROPERTY.find(([re]) => re.test(property))?.[1] ?? "auto");
      // Soften first: a tint normalization produced must not be tinted again.
      return `${decl.slice(0, split)}:${normalizeColors(softenChroma(value, role), role, invert)}`;
    })
    .join(";");
}

// A rule that paints a chroma fill and says nothing about text leaves the label
// to whatever it inherits, which on a saturated ground is a coin toss. The
// answer is local and certain: the fill is right there.
const BACKGROUND_DECL_RE = /(?:^|[;\s])(?:background|background-color)\s*:\s*([^;!]+)/i;

function withPairedInk(decls: string, original: string, invert: boolean): string {
  if (/(?:^|[;\s])color\s*:/i.test(decls)) return decls;
  const background = BACKGROUND_DECL_RE.exec(original);
  if (!background) return decls;
  const color = parseColor(background[1].trim());
  if (!color || color.a < 0.5) return decls;
  // Pair against the token the fill *became*, never against the literal the
  // model wrote: `#1c1c1c` is a dark box on bone and a light one on near-black,
  // so reading the literal's lightness picks the wrong ink in one theme.
  const { token } = paletteToken(color, "surface", invert);
  const inverted = token === "--viz-ink" || token === "--viz-ink-dim";
  return `${decls.replace(/;\s*$/, "")};color:var(${inverted ? "--viz-surface" : "--viz-ink"})`;
}

/**
 * A block has no window, so a viewport unit measures the app around the visual
 * instead of the visual. That is how a hero sized `clamp(2rem, 6vw, 4rem)`
 * lands on its cap in a 900px column — 6vw of a 1850px window is 111px — and
 * how `section { min-height: 100vh }` becomes a screenful of empty space
 * nobody asked for.
 *
 * The inline axis has an exact answer: the block is a container-query
 * container, so `cqw` *is* the width the author meant by `vw`. The block axis
 * has none — the visual's height is whatever its content comes to — so the
 * block declares a notional page height (`--viz-vh`, in tokens.css) and `vh`
 * resolves against that. Proportions survive; no viewport is invented.
 */
const VIEWPORT_UNIT_RE = /(-?\d*\.?\d+)(vw|vh|vmin|vmax|vi|vb)(?![\w%-])/gi;

function mapViewportUnits(value: string): string {
  return value.replace(VIEWPORT_UNIT_RE, (_all, n: string, unit: string) => {
    const block = `calc(${n} * var(--viz-vh))`;
    switch (unit.toLowerCase()) {
      case "vw": case "vi": return `${n}cqw`;
      case "vh": case "vb": return block;
      case "vmin": return `min(${n}cqw, ${block})`;
      default: return `max(${n}cqw, ${block})`;
    }
  });
}

// `min-height: 100vh` does not mean 640px. It means "fill the screen", and a
// visual has no screen and no fold — so the honest height is the one its
// content comes to. The declaration goes, rather than opening a screenful of
// nothing in the middle of a conversation. Every other property means a
// proportion, which --viz-vh can keep.
const SCREENFUL_PROPERTY_RE = /^(?:min-|max-)?(?:height|block-size)$/i;
const BLOCK_AXIS_UNIT_RE = /\d\s*(?:vh|vb|vmin|vmax)(?![\w%-])/i;

/** Every declaration re-measured against the block instead of the window. */
function withBlockRelativeUnits(decls: string): string {
  return decls
    .split(";")
    .map((decl) => {
      const split = decl.indexOf(":");
      if (split < 0) return decl;
      const value = decl.slice(split + 1);
      if (SCREENFUL_PROPERTY_RE.test(decl.slice(0, split).trim()) && BLOCK_AXIS_UNIT_RE.test(value)) return null;
      return `${decl.slice(0, split)}:${mapViewportUnits(value)}`;
    })
    .filter((decl): decl is string => decl !== null)
    .join(";");
}

/** A declaration list from a `style="…"` attribute, with the unsafe parts out. */
export function sanitizeDecls(value: string, scope: string, invert = false): string {
  return withBlockRelativeUnits(normalizeDeclColors(withTokenFallbacks(namespaceUrlRefs(value, scope)), invert))
    // A `url()` that is not an inline image or an own-id reference would be a
    // network fetch the model chose — a beacon. Neutralize the value, keep the
    // property, so a broken background does not take the layout with it.
    .replace(/url\(\s*(?!['"]?(?:#|data:image\/))[^)]*\)/gi, "none")
    // Containment already traps a fixed child in the block, but saying so
    // costs nothing and keeps the intent readable.
    .replace(/position\s*:\s*fixed/gi, "position:absolute")
    .replace(/expression\s*\(/gi, "(")
    .trim();
}

/** The same list, plus the text color a literal background implies. */
function sanitizeDeclsPaired(value: string, scope: string, invert = false): string {
  return withPairedInk(sanitizeDecls(value, scope, invert), value, invert);
}

/**
 * Re-anchor a stylesheet under one scope class. `:root`, `html` and `body`
 * become the block itself; everything else becomes a descendant of it. At-rules
 * that reach outside a block — `@import`, `@font-face`, `@page` — are dropped.
 */
export function scopeCss(css: string, scope: string, invert = false): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    if (css.startsWith("/*", i)) {
      const end = css.indexOf("*/", i + 2);
      i = end < 0 ? css.length : end + 2;
      continue;
    }
    const brace = css.indexOf("{", i);
    if (brace < 0) break;
    const prelude = css.slice(i, brace).trim();
    const block = readBalanced(css, brace);

    if (prelude.startsWith("@")) {
      const at = prelude.slice(1).split(/[\s({]/)[0].toLowerCase();
      if (at === "media" || at === "supports" || at === "container" || at === "layer") {
        const inner = scopeCss(block.inner, scope, invert);
        // A drawing sits in a column, not in a window: a width query has to ask
        // about the block. Anything else a @media can ask — a color scheme, a
        // motion preference — is still about the window and stays put.
        const prelude2 = at === "media" && SIZE_QUERY_RE.test(prelude) ? prelude.replace(/^@media/, "@container") : prelude;
        if (inner) out += `${prelude2}{${inner}}`;
      } else if (at.endsWith("keyframes")) {
        // Frame selectors are percentages, not document selectors — the body
        // is kept verbatim and the animation stays inside the block anyway.
        out += `${prelude}{${block.inner}}`;
      }
      // @import, @font-face, @page, @charset: dropped.
    } else {
      const parts = prelude
        .split(",")
        .map((part) => scopeSelector(part.trim(), scope))
        .filter(Boolean);
      // A page's ground is the block's ground. `body { background: #0b0b0b }`
      // is a whole-window decision made for a window this block does not have,
      // and kept it half-themes the visual — a near-black slab across a light
      // theme, or, once the palette maps that literal to ink, a white slab
      // across a dark one. The gutters, the measure, the type all stay.
      const authored = parts.includes(`.${scope}`) ? withoutGround(block.inner) : block.inner;
      const decls = sanitizeDeclsPaired(authored, scope, invert);
      if (parts.length && decls) out += `${parts.join(", ")}{${decls}}`;
    }
    i = block.end;
  }
  return out;
}

const GROUND_PROPERTY_RE = /^(?:background(?:-color|-image)?|color)$/i;

function withoutGround(decls: string): string {
  return decls
    .split(";")
    .filter((decl) => {
      const split = decl.indexOf(":");
      return split < 0 || !GROUND_PROPERTY_RE.test(decl.slice(0, split).trim());
    })
    .join(";");
}

// Only width/height/aspect-ratio conditions — no `prefers-*`, no `print`.
const SIZE_QUERY_RE = /^@media\s*(?:\(\s*(?:min-|max-)?(?:width|height|aspect-ratio)\b[^)]*\)\s*(?:and\s*)?)+$/i;

function scopeSelector(selector: string, scope: string): string {
  if (!selector || selector.startsWith("@")) return "";
  const rest = selector.replace(/^(:root|html|body)\b/i, "");
  const self = rest.trim();
  if (!self) return `.${scope}`;
  // `body.dark` is one element wearing two conditions, not a descendant of one:
  // scoped as a descendant it would paint any `.dark` inside the block instead.
  if (rest !== selector && rest === self && /^[.#:[]/.test(self)) return `.${scope}${self}`;
  return `.${scope} ${self}`;
}

function readBalanced(css: string, openBrace: number): { inner: string; end: number } {
  let depth = 0;
  let i = openBrace;
  let quote = "";
  while (i < css.length) {
    const ch = css[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return { inner: css.slice(openBrace + 1, i), end: i + 1 };
    }
    i++;
  }
  return { inner: css.slice(openBrace + 1), end: css.length };
}
