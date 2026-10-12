// A drawing coming to life piece by piece: the sample svg is fed to the
// renderer a few characters at a time with `streaming: true`, the way a run
// in flight does, then closed. Each element should fade in where it lands,
// nothing already drawn should flicker, and the picture should settle once.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderMarkdown } from "../src/components/markdown";
import "../src/styles/tokens.css";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/monaspace-neon/400.css";
document.documentElement.dataset.theme = "klide-dark";
const svg = `<svg viewBox="0 0 720 360">
  <text x="40" y="40" font-size="14">How a question reaches an agent</text>
  <rect x="200" y="70" width="320" height="56" rx="8"/>
  <text x="360" y="104" text-anchor="middle">User in the chat</text>
  <path d="M360 126 V180" stroke="var(--viz-line)" marker-end="url(#a)"/>
  <defs><marker id="a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0L10 5L0 10" fill="none" stroke="var(--viz-line)"/></marker></defs>
  <rect x="200" y="186" width="320" height="72" rx="8"/>
  <text x="360" y="216" text-anchor="middle">Supervisor</text>
  <text x="360" y="240" text-anchor="middle" font-size="12" opacity="0.6">Picks which agents to call</text>
  <path d="M260 258 V300 M360 258 V300 M460 258 V300" stroke="var(--viz-line)"/>
  <rect x="220" y="304" width="80" height="36" rx="6"/><text x="260" y="327" text-anchor="middle" font-size="12">Search</text>
  <rect x="320" y="304" width="80" height="36" rx="6"/><text x="360" y="327" text-anchor="middle" font-size="12">Code</text>
  <rect x="420" y="304" width="80" height="36" rx="6"/><text x="460" y="327" text-anchor="middle" font-size="12">Review</text>
</svg>`;
const full = "Here is the shape of it:\n\n```svg\n" + svg + "\n```\n\nThe supervisor picks the lane.";
function Page() {
  const [shown, setShown] = useState(0);
  const [run, setRun] = useState(0);
  useEffect(() => {
    setShown(0);
    const id = setInterval(() => setShown(n => {
      if (n >= full.length) { clearInterval(id); return n; }
      return Math.min(full.length, n + 3 + Math.floor(Math.random() * 6));
    }), 35);
    return () => clearInterval(id);
  }, [run]);
  const done = shown >= full.length;
  return <main style={{margin:"32px auto",width:720,color:"var(--fg)",fontFamily:"var(--font-ui)"}}>
    <button onClick={() => setRun(r => r + 1)}>Replay</button>
    <div>{renderMarkdown(full.slice(0, shown), { visuals: true, streaming: !done })}</div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Page/>);
