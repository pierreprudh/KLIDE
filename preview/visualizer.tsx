// Throwaway page for the inline visualizer without launching Tauri.
//
// It renders the real markdown renderer over the kind of message a model
// actually writes — an SVG mechanism diagram — plus one deliberately hostile
// block, so the containment rules can be seen rather than argued about.
//
//   npx vite --port 1421   →  http://localhost:1421/preview/visualizer.html
//   ?theme=dark | klide-light | sage-garden | cursor-dark | …
import { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "@fontsource/monaspace-neon/700.css";
import "../src/styles/tokens.css";
import { renderMarkdown } from "../src/components/markdown";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "klide-light";

const DIAGRAM = `**0 — regenerated on the palette**, the way the prompt now asks: surfaces and
hairlines from the visual palette, one verdict color, mono for paths. Measured
against its own grounds — every pairing clears WCAG on bone and on near-black:

\`\`\`visualizer
<style>
  .title { font-family:var(--font-ui); font-size:13px; font-weight:600; fill:var(--viz-ink); }
  .name  { font-family:var(--font-ui); font-size:12px; fill:var(--viz-ink); }
  .meta  { font-family:var(--font-mono); font-size:10px; fill:var(--viz-ink-dim); }
  .box   { fill:var(--viz-surface-2); stroke:var(--viz-line); stroke-width:1; }
  .bad   { fill:color-mix(in srgb, var(--viz-danger) 12%, var(--viz-surface)); stroke:var(--viz-danger); stroke-width:1; }
  .arr   { stroke:var(--viz-line); stroke-width:1; fill:none; }
</style>
<svg width="100%" viewBox="0 0 660 100">
  <defs>
    <marker id="a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M2 1L8 5L2 9" fill="none" stroke="var(--viz-line)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </marker>
  </defs>
  <text class="title" x="0" y="12">How a corrupt file erases the whole store</text>
  <rect class="box" x="0" y="32" width="168" height="58" rx="8"/>
  <text class="name" x="84" y="56" text-anchor="middle">connectors.json</text>
  <text class="meta" x="84" y="74" text-anchor="middle">3 connectors</text>
  <path class="arr" d="M174 61 L 222 61" marker-end="url(#a)"/>
  <text class="meta" x="198" y="50" text-anchor="middle">one bad byte</text>
  <rect class="box" x="238" y="32" width="168" height="58" rx="8"/>
  <text class="name" x="322" y="56" text-anchor="middle">list()</text>
  <text class="meta" x="322" y="74" text-anchor="middle">parse fails, returns []</text>
  <path class="arr" d="M412 61 L 460 61" marker-end="url(#a)"/>
  <text class="meta" x="436" y="50" text-anchor="middle">any write</text>
  <rect class="bad" x="476" y="32" width="184" height="58" rx="8"/>
  <text class="name" x="568" y="56" text-anchor="middle">store overwritten</text>
  <text class="meta" x="568" y="74" text-anchor="middle">3 connectors gone</text>
</svg>
\`\`\`

**1 — a model hardcodes its surfaces.** Bone boxes and a themed label: half the
drawing from the model's world, half from the theme's. Every literal is now read
for its *role* — box, hairline, label — and re-expressed in the visual palette,
so the whole drawing follows one ground:

\`\`\`visualizer
<style>
  .th { font-family:var(--font-sans); font-size:12px; font-weight:600; fill:var(--fg-strong); }
  .ts { font-family:var(--font-mono); font-size:10px; fill:var(--fg-dim); }
  .box { fill:#e9e5dc; stroke:#d6d1c6; stroke-width:0.5; }
  .bad { fill:#f0dcd9; stroke:#c98f88; stroke-width:0.5; }
  .arr { stroke:#8a857c; stroke-width:1; }
</style>
<svg width="100%" viewBox="0 0 660 118">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </marker>
  </defs>
  <text x="0" y="14" class="th" style="font-size:14px">How a corrupt file erases the whole store</text>
  <rect class="box" x="0" y="34" width="150" height="58" rx="8"/>
  <text class="th" x="75" y="58" text-anchor="middle">connectors.json</text>
  <text class="ts" x="75" y="76" text-anchor="middle">3 connectors</text>
  <path d="M156 63 L 206 63" class="arr" marker-end="url(#arrow)"/>
  <text class="ts" x="181" y="53" text-anchor="middle">one bad byte</text>
  <rect class="box" x="212" y="34" width="160" height="58" rx="8"/>
  <text class="th" x="292" y="58" text-anchor="middle">list() :88</text>
  <text class="ts" x="292" y="76" text-anchor="middle">parse fails → vec![]</text>
  <path d="M378 63 L 428 63" class="arr" marker-end="url(#arrow)"/>
  <text class="ts" x="403" y="53" text-anchor="middle">any write</text>
  <rect class="bad" x="434" y="34" width="176" height="58" rx="8"/>
  <text class="th" x="522" y="58" text-anchor="middle">overwritten</text>
  <text class="ts" x="522" y="76" text-anchor="middle">3 connectors gone</text>
</svg>
\`\`\`

**2 — a model guesses token names.** \`--surface\`, \`--text-muted\`, \`--border-color\`:
none exist here, and an unresolved fill paints black. Each lands on its nearest
Klide token instead, and the drawing follows the theme:

\`\`\`svg
<svg width="100%" viewBox="0 0 660 74">
  <rect x="0" y="8" width="200" height="58" rx="8" fill="var(--surface)" stroke="var(--border-color)" stroke-width="0.5"/>
  <text x="100" y="33" text-anchor="middle" font-family="var(--font-sans)" font-size="12" font-weight="600" fill="var(--heading)">Harness Run</text>
  <text x="100" y="51" text-anchor="middle" font-family="var(--font-mono)" font-size="10" fill="var(--text-muted)">owns the loop</text>
  <rect x="230" y="8" width="200" height="58" rx="8" fill="var(--surface-2)" stroke="var(--border-color)" stroke-width="0.5"/>
  <text x="330" y="33" text-anchor="middle" font-family="var(--font-sans)" font-size="12" font-weight="600" fill="var(--heading)">Delegate CLI</text>
  <text x="330" y="51" text-anchor="middle" font-family="var(--font-mono)" font-size="10" fill="var(--text-muted)">owns its own</text>
  <rect x="460" y="8" width="200" height="58" rx="8" fill="var(--accent-bg)" stroke="var(--primary)" stroke-width="0.5"/>
  <text x="560" y="33" text-anchor="middle" font-family="var(--font-sans)" font-size="12" font-weight="600" fill="var(--primary)">one journal</text>
  <text x="560" y="51" text-anchor="middle" font-family="var(--font-mono)" font-size="10" fill="var(--text-muted)">events.jsonl</text>
</svg>
\`\`\`

**3 — the findings, on the palette the prompt names** — monochrome by default,
one accent, a verdict color only where a verdict is earned, no pills:

\`\`\`html
<style>
  .f { display:grid; grid-template-columns:96px 1fr; gap:14px; padding:10px 0; border-top:1px solid var(--viz-line-soft); align-items:baseline; }
  .f:first-of-type { border-top:none; }
  .sev { font-family:var(--font-mono); font-size:10px; letter-spacing:0.06em; text-transform:uppercase; color:var(--viz-ink-dim); }
  .sev.now { color:var(--viz-danger); }
  .sev.soon { color:var(--viz-warning); }
  .what { color:var(--viz-ink); }
  .what b { font-weight:600; color:var(--viz-ink); }
  code { font-family:var(--font-mono); font-size:12px; color:var(--viz-accent); }
  .why { color:var(--viz-ink-dim); }
</style>
<div class="f"><div class="sev now">Real issue</div><div class="what"><b>A corrupt store reads as empty</b> — the next write overwrites it. <span class="why"><code>connectors.rs:88</code> · every connector gone, no error shown</span></div></div>
<div class="f"><div class="sev soon">Worth a glance</div><div class="what"><b>The TOML reader is order-dependent</b> <span class="why">a sub-table header can land env keys on the wrong server</span></div></div>
<div class="f"><div class="sev">Minor</div><div class="what"><b><code>unquote</code> mangles escaped strings</b> <span class="why">read-only path, rare input</span></div></div>
<div class="f"><div class="sev">Minor</div><div class="what"><b><code>parseEnv</code> trims trailing whitespace</b> <span class="why">silently, from every value</span></div></div>
<div class="f"><div class="sev">Hygiene</div><div class="what"><b>Untracked files in the tree</b> <span class="why"><code>preview-connectors.*</code>, <code>q3-demo/</code> — ignore or delete before the commit</span></div></div>
\`\`\`

**4 — the hostile one** — a script, a global style, a beacon, a full-screen overlay,
a \`javascript:\` link. Nothing below should escape the block or fire:

\`\`\`html
<style>body { background: #c00 !important } .ts { color: #c00 !important }</style>
<script>document.title = "pwned"; window.__pwned = true;</script>
<img src="https://tracker.example/beacon.gif" onerror="window.__pwned2 = true">
<div style="position:fixed; inset:0; background:url(https://tracker.example/bg.png) #c00; z-index:99999">overlay</div>
<a href="javascript:window.__pwned3 = true">a link</a>
<iframe src="https://example.com"></iframe>
<p>What survives: this paragraph, and the link's text.</p>
\`\`\`

**5 —** a plain \`ts\` fence still renders as source, untouched:

\`\`\`ts
const scope = \`kv\${useId()}\`;
\`\`\`
`;

function Page() {
  // Drag the right edge: the drawings are fluid down to a legible floor, then
  // the block scrolls rather than shrinking its type to nothing.
  const [width, setWidth] = useState(720);
  const column = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = column.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.round(el.getBoundingClientRect().width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div style={{ background: "var(--bg)", minHeight: "100vh", padding: "40px 0" }}>
      <div
        ref={column}
        style={{
          width: 720,
          maxWidth: "100%",
          margin: "0 auto",
          resize: "horizontal",
          overflow: "auto",
          paddingRight: 12,
          borderRight: "1px dashed var(--border-strong)",
          fontFamily: "var(--font-ui)",
          fontSize: "var(--fs-base)",
          lineHeight: 1.6,
          color: "var(--fg)",
        }}
      >
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-dim)", marginBottom: 20 }}>
          column {width}px — drag the dashed edge
        </div>
        {renderMarkdown(DIAGRAM)}
        <div id="verdict" style={{ marginTop: 24, fontFamily: "var(--font-mono)", fontSize: 11 }} />
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Page />);

// Say out loud whether anything escaped.
setTimeout(() => {
  const w = window as unknown as Record<string, unknown>;
  const escaped = [
    w.__pwned && "script ran",
    w.__pwned2 && "onerror ran",
    w.__pwned3 && "javascript: link",
    document.title !== "Klide — Inline visualizer" && "title rewritten",
    getComputedStyle(document.body).backgroundColor === "rgb(204, 0, 0)" && "body restyled",
    document.querySelector("iframe") && "iframe alive",
  ].filter(Boolean);
  const el = document.getElementById("verdict");
  if (el) {
    el.textContent = escaped.length ? `ESCAPED: ${escaped.join(", ")}` : "contained — nothing escaped the block";
    el.style.color = escaped.length ? "var(--danger)" : "var(--success)";
  }
}, 600);
