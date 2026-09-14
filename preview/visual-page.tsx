// Throwaway page for the *document* case of the inline visualizer: what a model
// writes when it answers with a whole HTML page rather than a diagram.
//
// Two blocks, because they fail differently. The first is a page that styled
// itself — a doctype, a dark body, a hero sized in `vw`, sections sized in
// `vh`. The second styled nothing at all, which is the case where the block's
// own document defaults are the only thing standing between a model's markup
// and a wall of UA-default Times.
//
//   npx vite --port 1421   →  http://localhost:1421/preview/visual-page.html
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

const STYLED_PAGE = `Here is the page you asked for:

\`\`\`html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Klide · Project Schemas</title>
  <style>
    body { margin: 0; padding: 72px 56px; background: #0b0b0b; color: #f2f2f2;
           font-family: system-ui, sans-serif; font-size: 17px; line-height: 1.6; }
    .eyebrow { font-size: 11px; letter-spacing: .14em; text-transform: uppercase;
               color: #8a8a8a; margin-bottom: 28px; }
    h1 { font-size: clamp(2.2rem, 5.5vw, 4rem); line-height: 1.08;
         letter-spacing: -.02em; margin: 0 0 28px; font-weight: 400; }
    p { max-width: 62ch; margin: 0 0 20px; }
    .callout { border-left: 2px solid #3f6f9f; padding: 18px 22px;
               background: #151515; margin: 32px 0; }
    section { min-height: 100vh; padding: 8vh 0; border-top: 1px solid #222; }
    .label { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: #8a8a8a; }
  </style>
</head>
<body>
  <div class="eyebrow">Klide · Project Schemas</div>
  <h1>An IDE that looks like a 2026 design tool, runs like a code editor, and treats agents as a first-class surface.</h1>
  <p>Six diagrams explain the load-bearing ideas behind Klide. Each one is a single
     decision the codebase commits to — change the diagram and you change the architecture.</p>
  <div class="callout">
    <strong>The mental model:</strong> one Rust agent loop drives every surface. The frontend
    is a pure view that renders its event stream; everything durable lives behind typed seams.
  </div>
  <section>
    <div class="label">Schema 1</div>
    <p>One agent loop, three surfaces. Welcome, Focus and the Workbench read the same runs.</p>
  </section>
</body>
</html>
\`\`\`
`;

const BARE_PAGE = `And the same answer with no stylesheet at all — the block's own document
defaults are all that is holding it up:

\`\`\`html
<!doctype html>
<html>
<body>
  <h1>Durable missions</h1>
  <p>A Mission Task owns zero or more Run attempts and one accepted attempt.
     Task id and Run id are never the same lifecycle object.</p>
  <h2>What Rust owns</h2>
  <ul>
    <li><code>.klide/missions/&lt;id&gt;/mission.md</code></li>
    <li><code>tasks/*.md</code>, one per task</li>
    <li>append-only <code>events.jsonl</code></li>
  </ul>
  <blockquote>Dependency readiness gates on an accepted attempt, never on process exit.</blockquote>
  <h2>Attempt states</h2>
  <table>
    <tr><th>State</th><th>Set by</th></tr>
    <tr><td>attempt_started</td><td>the supervisor</td></tr>
    <tr><td>attempt_interrupted</td><td>restart validation</td></tr>
    <tr><td>accepted</td><td>the operator</td></tr>
  </table>
  <hr>
  <p><small>Approval freezes the worker kind, provider, model and diff-review policy.</small></p>
</body>
</html>
\`\`\`
`;

const DRAWING = `A diagram is untouched by any of it — no frame, no page:

\`\`\`svg
<svg viewBox="0 0 520 88">
  <rect x="0" y="20" width="150" height="48" rx="8"/>
  <text x="75" y="49" text-anchor="middle" font-size="12">AiPanel</text>
  <path d="M158 44 L 206 44" marker-end="url(#a)"/>
  <rect x="214" y="20" width="150" height="48" rx="8"/>
  <text x="289" y="49" text-anchor="middle" font-size="12">run_agent_loop</text>
</svg>
\`\`\`
`;

function Page() {
  const [width, setWidth] = useState(880);
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
          width: 880,
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
        {renderMarkdown(STYLED_PAGE)}
        {renderMarkdown(BARE_PAGE)}
        {renderMarkdown(DRAWING)}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Page />);
