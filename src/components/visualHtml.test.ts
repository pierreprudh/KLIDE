import { describe, expect, it } from "vitest";
import { normalizeColor, normalizeColors, prepareVisual, safeVisualUrl, sanitizeDecls, scopeCss, withTokenFallbacks } from "./visualHtml";

const SCOPE = "kv1";

// Every block opens with its own responsive base sheet; these assertions are
// about the rules the *drawing* contributed after it.
const drawn = (css: string) => css.slice(css.lastIndexOf("max-width:100%}") + "max-width:100%}".length);

describe("prepareVisual", () => {
  it("keeps the drawing vocabulary a diagram is made of", () => {
    const { html } = prepareVisual(
      '<svg viewBox="0 0 10 10"><g class="node"><rect x="1" y="2" rx="8"/><text dominant-baseline="central">hi</text></g></svg>',
      SCOPE,
    );
    expect(html).toBe(
      '<svg viewBox="0 0 10 10"><g class="node"><rect x="1" y="2" rx="8" fill="var(--viz-surface-2)" stroke="var(--viz-line)"/>' +
        '<text dominant-baseline="central" fill="var(--viz-ink)">hi</text></g></svg>',
    );
  });

  it("drops a script with its body, not just its tags", () => {
    const { html, dropped } = prepareVisual('<div>a<script>fetch("/x")</script>b</div>', SCOPE);
    expect(html).toBe("<div>ab</div>");
    expect(dropped).toEqual(["script"]);
  });

  it("drops every event handler, however it is spelled", () => {
    const { html } = prepareVisual('<div onclick="x()" ONMOUSEOVER="y()" title="t">z</div>', SCOPE);
    expect(html).toBe('<div title="t">z</div>');
  });

  it("refuses a javascript: link but keeps its text", () => {
    const { html } = prepareVisual('<a href="javascript:alert(1)">click</a>', SCOPE);
    expect(html).toBe("<a>click</a>");
  });

  it("sends a real link out without a referrer or an opener", () => {
    const { html } = prepareVisual('<a href="https://example.com">docs</a>', SCOPE);
    expect(html).toContain('rel="noreferrer noopener" target="_blank"');
  });

  it("survives a > inside an attribute value", () => {
    const { html } = prepareVisual('<div style="width:10px" data-q="a>b">t</div>', SCOPE);
    expect(html).toContain('data-q="a>b"');
    expect(html).toContain("t</div>");
  });

  it("treats a stray < as text", () => {
    const { html } = prepareVisual("<p>a < b</p>", SCOPE);
    expect(html).toBe("<p>a &lt; b</p>");
  });

  it("namespaces ids and the references that point at them", () => {
    const { html } = prepareVisual(
      '<defs><marker id="arrow"/></defs><path marker-end="url(#arrow)"/><use href="#arrow"/>',
      SCOPE,
    );
    expect(html).toContain('id="arrow-kv1"');
    expect(html).toContain('marker-end="url(#arrow-kv1)"');
    expect(html).toContain('href="#arrow-kv1"');
  });

  it("lifts a style block out and anchors every rule to the block", () => {
    const { html, css } = prepareVisual(
      "<style>.row { display:flex; } body { margin:0 } :root { --x: 1px }</style><div class=\"row\">r</div>",
      SCOPE,
    );
    expect(html).toBe('<div class="row">r</div>');
    expect(drawn(css)).toBe(".kv1 .row{display:flex;}.kv1{margin:0}.kv1{--x: 1px}");
  });

  it("only lets an image in as an inline data URI", () => {
    const ok = prepareVisual('<img src="data:image/png;base64,AAAA">', SCOPE);
    const no = prepareVisual('<img src="https://tracker.example/p.gif">', SCOPE);
    expect(ok.html).toContain("data:image/png;base64,AAAA");
    expect(no.html).toBe("<img>");
  });
});

describe("scopeCss", () => {
  it("asks the block about its width, not the window", () => {
    expect(scopeCss("@media (max-width: 400px) { .a { color: red } }", SCOPE)).toBe(
      "@container (max-width: 400px){.kv1 .a{color: var(--viz-danger)}}",
    );
  });

  it("keeps keyframes verbatim", () => {
    expect(scopeCss("@keyframes in { from { opacity: 0 } to { opacity: 1 } }", SCOPE)).toContain("@keyframes in{");
  });

  it("drops the at-rules that reach outside the block", () => {
    expect(scopeCss('@import url("evil.css"); @font-face { src: url(x) } .a { color: red }', SCOPE)).toBe(
      ".kv1 .a{color: var(--viz-danger)}",
    );
  });
});

describe("sanitizeDecls", () => {
  it("neutralizes a remote url() but keeps an inline image and an own reference", () => {
    expect(sanitizeDecls("background:url(https://evil/x.png)", SCOPE)).toBe("background:none");
    expect(sanitizeDecls("fill:url(#g)", SCOPE)).toBe("fill:url(#g-kv1)");
    expect(sanitizeDecls("background:url(data:image/png;base64,AA)", SCOPE)).toContain("data:image/png");
  });

  it("pins a fixed child to the block", () => {
    expect(sanitizeDecls("position: fixed; inset: 0", SCOPE)).toBe("position:absolute; inset: 0");
  });
});

describe("safeVisualUrl", () => {
  it("answers nothing for a scheme a visual has no business using", () => {
    expect(safeVisualUrl("file:///etc/passwd", "a", SCOPE)).toBeNull();
    expect(safeVisualUrl("/src/main.tsx", "img", SCOPE)).toBeNull();
    expect(safeVisualUrl("#top", "use", SCOPE)).toBe("#top-kv1");
  });
});

describe("tokens a model guesses", () => {
  it("lands an unknown name on the nearest Klide token instead of on black", () => {
    const { html } = prepareVisual('<rect fill="var(--surface)" stroke="var(--border-color)"/>', SCOPE);
    expect(html).toContain('fill="var(--surface, var(--viz-surface))"');
    expect(html).toContain('stroke="var(--border-color, var(--viz-line))"');
  });

  it("reads the intent in the name", () => {
    const guess = (token: string) => {
      const filled = withTokenFallbacks(`var(${token})`);
      return filled.slice(`var(${token}, `.length, -1);
    };
    expect(guess("--text-muted")).toBe("var(--viz-ink-dim)");
    expect(guess("--font-sans")).toBe("var(--font-ui)");
    expect(guess("--error")).toBe("var(--viz-danger)");
    expect(guess("--primary")).toBe("var(--viz-accent)");
    expect(guess("--series-3")).toBe("var(--chart-3)");
    expect(guess("--whatever")).toBe("currentColor");
  });

  it("leaves a name Klide defines, and a fallback the model wrote, alone", () => {
    // The guess rides along but is never read while the token resolves.
    expect(withTokenFallbacks("color:var(--accent)")).toBe("color:var(--accent, var(--viz-accent))");
    // A name this renderer defines needs no fallback at all.
    expect(withTokenFallbacks("fill:var(--viz-ink)")).toBe("fill:var(--viz-ink)");
    expect(withTokenFallbacks("color:var(--nope, #fff)")).toBe("color:var(--nope, #fff)");
  });

  it("draws a box the drawing left bare, instead of a slab or nothing", () => {
    // Two regressions in one test. A `fill` inherited from the root painted
    // every bare shape in the *ink* color — a cream slab with its own label
    // invisible inside it. Defaulting to `none` instead made the box vanish.
    const html = prepareVisual("<svg><rect/><text>t</text></svg>", SCOPE).html;
    expect(html).toContain('<rect fill="var(--viz-surface-2)" stroke="var(--viz-line)"/>');
    expect(html).toContain('<text fill="var(--viz-ink)">');
  });

  it("leaves an outline an outline, and a line a line", () => {
    // A stroke of its own says the shape was always meant to be hollow.
    expect(prepareVisual('<rect stroke="var(--viz-line)"/>', SCOPE).html).toContain('fill="none"');
    // A line paints no interior, so without an edge it is drawn as nothing.
    expect(prepareVisual('<path d="M0 0L9 9"/>', SCOPE).html).toBe(
      '<path d="M0 0L9 9" fill="none" stroke="var(--viz-line)"/>',
    );
  });

  it("never overrides a fill the drawing states, in either layer", () => {
    expect(prepareVisual('<rect fill="#e9e5dc"/>', SCOPE).html).toContain('fill="var(--viz-surface)"');
    // A presentation attribute is the weakest layer in SVG, so the default
    // this renderer writes loses to the model's own rule.
    const styled = prepareVisual('<style>.box { fill:#e9e5dc }</style><rect class="box"/>', SCOPE);
    expect(styled.html).toContain('<rect class="box" fill="var(--viz-surface-2)" stroke="var(--viz-line)"/>');
    expect(styled.css).toContain("fill:var(--viz-surface)");
  });
});

describe("colors a model hardcodes", () => {
  const fill = (markup: string) => prepareVisual(markup, SCOPE).html;

  it("reads a light neutral as a surface and a dark one as ink", () => {
    expect(fill('<rect fill="#e9e5dc"/>')).toContain('fill="var(--viz-surface)"');
    expect(fill('<text fill="#1c1c1c">t</text>')).toContain('fill="var(--viz-ink)"');
    expect(fill('<line stroke="#d6d1c6"/>')).toContain('stroke="var(--viz-line)"');
    // The same literal is a surface on a box and a hairline on a stroke.
    expect(fill('<rect fill="#d6d1c6"/>')).toContain('fill="var(--viz-surface)"');
  });

  it("keeps a hue, so two colors a model chose apart stay apart", () => {
    expect(normalizeColor("#dc2626")).toBe("var(--viz-danger)");
    expect(normalizeColor("#f5c14e")).toBe("var(--viz-warning)");
    expect(normalizeColor("#16a34a")).toBe("var(--viz-success)");
    expect(normalizeColor("#3b82f6")).toBe("var(--viz-accent)");
    expect(normalizeColor("#827dbd")).toBe("var(--viz-7)");
    expect(normalizeColor("rebeccapurple")).toBeNull();
    expect(normalizeColor("purple")).toBe("var(--viz-7)");
  });

  it("reads fill by what the rule around it is drawing", () => {
    const shape = prepareVisual("<style>.box { fill:#e9e5dc; stroke:#d6d1c6 }</style>", SCOPE).css;
    const label = prepareVisual("<style>.th { font-size:12px; fill:#1c1c1c }</style>", SCOPE).css;
    expect(shape).toContain("fill:var(--viz-surface)");
    expect(label).toContain("fill:var(--viz-ink)");
  });

  it("keeps a wash a wash", () => {
    expect(normalizeColor("rgba(0,0,0,0.06)")).toBe("color-mix(in srgb, var(--viz-ink) 6%, transparent)");
  });

  it("leaves the keywords that are not colors", () => {
    expect(normalizeColors("1px solid currentColor")).toBe("1px solid currentColor");
    expect(normalizeColors("1px dashed", "line")).toBe("1px dashed");
    expect(normalizeColors("fill:none; stroke-width:1.5")).toBe("fill:none; stroke-width:1.5");
  });

  it("normalizes inside a shorthand without eating the rest of it", () => {
    expect(normalizeColors("1px solid #d6d1c6", "line")).toBe("1px solid var(--viz-line)");
    expect(drawn(prepareVisual("<style>.b { border: 1px solid #d6d1c6 }</style>", SCOPE).css)).toBe(
      ".kv1 .b{border: 1px solid var(--viz-line)}",
    );
  });

  it("dims a chroma asked to be a surface and pairs it with readable ink", () => {
    // A full-strength amber bar shouts and takes its own label down with it.
    // Measured: ink on the 16% tint clears 11:1 on both grounds.
    const { css } = prepareVisual("<style>.warn { background: #f5c14e }</style>", SCOPE);
    expect(drawn(css)).toBe(
      ".kv1 .warn{background: color-mix(in srgb, var(--viz-warning) 16%, var(--viz-surface));color:var(--viz-ink)}",
    );
  });

  it("dims a chroma the model names in the palette's own words", () => {
    const { css } = prepareVisual("<style>.warn { background: var(--viz-danger) }</style>", SCOPE);
    expect(css).toContain("background: color-mix(in srgb, var(--viz-danger) 16%, var(--viz-surface))");
    // Not tinted twice, and untouched where chroma belongs — on ink and lines.
    expect(css).not.toContain("color-mix(in srgb, color-mix");
    expect(prepareVisual("<style>.a { color: var(--viz-danger) }</style>", SCOPE).css).toContain("color: var(--viz-danger)");
  });

  it("keeps a chroma at full strength for ink and for lines", () => {
    expect(normalizeColor("#dc2626", "ink")).toBe("var(--viz-danger)");
    expect(normalizeColor("#dc2626", "line")).toBe("var(--viz-danger)");
    expect(normalizeColor("#dc2626", "surface")).toBe(
      "color-mix(in srgb, var(--viz-danger) 16%, var(--viz-surface))",
    );
  });

  it("pairs an inverted fill against the token it became, not the hex", () => {
    // `#1c1c1c` is a dark box on bone and a light one on near-black. Reading
    // the literal picks the wrong ink in one of the two themes.
    expect(prepareVisual("<style>.inv { background: #1c1c1c }</style>", SCOPE).css).toContain("color:var(--viz-surface)");
    expect(prepareVisual("<style>.card { background: #fcfbf8 }</style>", SCOPE).css).toContain("color:var(--viz-ink)");
  });

  it("leaves a rule that already states its text color alone", () => {
    const { css } = prepareVisual("<style>.warn { background: #f5c14e; color: #333 }</style>", SCOPE);
    expect(drawn(css)).toBe(
      ".kv1 .warn{background: color-mix(in srgb, var(--viz-warning) 16%, var(--viz-surface)); color: var(--viz-ink)}",
    );
  });
});

describe("a drawing that references classes it never defined", () => {
  // Taken from a real message: the model's <style> defined `.row` and `.sev`,
  // while its SVG used `.th`, `.ts`, `.arr` and four `.c-*` colors. Every box
  // came out with no fill and every arrow with no stroke — invisible lines
  // between identical grey boxes.
  const REAL = `<style>.row { display:flex } .sev { font-size:11px }</style>
<svg viewBox="0 0 680 360">
  <g class="c-gray"><rect x="40" y="60" width="150" height="64" rx="8" stroke-width="0.5"/>
  <text class="th" x="115" y="82">connectors.json</text></g>
  <path d="M190 92 L 240 92" class="arr" fill="none" marker-end="url(#arrow)"/>
</svg>`;

  it("draws the boxes and the arrows anyway", () => {
    const { html } = prepareVisual(REAL, SCOPE);
    expect(html).toContain(
      '<rect x="40" y="60" width="150" height="64" rx="8" stroke-width="0.5" fill="var(--viz-surface-2)" stroke="var(--viz-line)"/>',
    );
    expect(html).toContain('class="arr" fill="none" marker-end="url(#arrow-kv1)" stroke="var(--viz-line)"');
    expect(html).toContain('<text class="th" x="115" y="82" fill="var(--viz-ink)">');
  });
});

describe("fitting the column it lands in", () => {
  it("overrides a fixed width and makes a viewBox drawing fluid", () => {
    const { css } = prepareVisual('<svg width="680" viewBox="0 0 680 360"><rect/></svg>', SCOPE);
    expect(css).toContain(".kv1 svg{max-width:100%;height:auto}");
    expect(css).toContain(".kv1 svg[viewBox]{width:100%;min-width:520px}");
  });

  it("holds a legible floor: a wide drawing scrolls rather than shrinking to 6px type", () => {
    const wide = prepareVisual('<svg viewBox="0 0 1200 400"><rect/></svg>', SCOPE);
    expect(wide.css).toContain("min-width:520px");
    // A drawing narrower than the floor never scrolls — its own width is the floor.
    const narrow = prepareVisual('<svg viewBox="0 0 320 200"><rect/></svg>', SCOPE);
    expect(narrow.css).toContain("min-width:320px");
  });

  it("lets the drawing's own rules win over the base sheet", () => {
    const { css } = prepareVisual("<style>svg { max-width: 300px }</style><svg viewBox='0 0 10 10'/>", SCOPE);
    expect(css.indexOf(".kv1 svg{max-width:100%")).toBeLessThan(css.indexOf(".kv1 svg{max-width: 300px}"));
  });

  it("leaves a query that is really about the window alone", () => {
    expect(scopeCss("@media (prefers-reduced-motion: reduce) { .a { animation: none } }", SCOPE)).toContain("@media");
    expect(scopeCss("@media print { .a { color: #000 } }", SCOPE)).toContain("@media");
  });
});

describe("an arrowhead that follows its line", () => {
  it("resolves context-stroke, which WebKit does not implement", () => {
    // Left alone, the marker paints with an invalid value — nothing — and every
    // connector stops short of its box with no head on it.
    const { html } = prepareVisual(
      '<marker id="a"><path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke"/></marker>',
      SCOPE,
    );
    expect(html).toContain('stroke="var(--viz-line)"');
    expect(html).not.toContain("context-stroke");
  });

  it("resolves it in a fill and inside a rule too", () => {
    expect(prepareVisual('<path fill="context-fill" d="M0 0"/>', SCOPE).html).toContain('fill="var(--viz-line)"');
    expect(prepareVisual("<style>.head { fill: context-fill }</style>", SCOPE).css).toContain("fill: var(--viz-line)");
  });
});
