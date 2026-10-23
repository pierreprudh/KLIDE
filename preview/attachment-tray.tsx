// Browser-only fixture for the composer's staged-attachment cards: a photo,
// a Markdown note, code, and a long name. Hover a card for its ✕.
// `?theme=light|dark`.
import { createRoot } from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "../src/styles/tokens.css";
import { AttachmentTray } from "../src/components/ai/AttachmentTray";

const q = new URLSearchParams(location.search);
const photo = `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#9fb8c8"/><path d="M0 55 L25 25 L45 45 L80 15 L80 80 L0 80Z" fill="#4d6b4f"/><rect y="62" width="80" height="18" fill="#5c7f93"/></svg>`)}`;

const attachments = [
  { path: "cover-shot.png", content: "", mime: "image/png", dataUri: photo },
  { path: "docs/brand-guidelines.md", content: "# Brand\n".repeat(30_000) },
  { path: "src/main.rs", content: "fn main() {}\n".repeat(400) },
  { path: "notes.txt", content: "two\nlines" },
  { path: "a-very-long-file-name-for-the-quarterly-forecast.csv", content: "a,b\n".repeat(80_000) },
];

function Preview() {
  return (
    <main style={{ width: 620, margin: "24px auto", fontFamily: "var(--font-ui)", color: "var(--fg)" }}>
      {/* Inside the composer's own surface, so the card's fill is judged
          against the surface it actually sits on. */}
      <div className="klide-composer-surface" style={{ paddingBottom: 40 }}>
        <AttachmentTray attachments={attachments} onRemove={() => {}} />
      </div>
    </main>
  );
}

document.documentElement.dataset.theme = q.get("theme") ?? "light";
createRoot(document.getElementById("root")!).render(<Preview />);

// `?hover` — show the first card the way a pointer over it does.
if (q.has("hover")) setTimeout(() => {
  // Headless capture can land mid-fade; show the settled state.
  document.head.append(Object.assign(document.createElement("style"), { textContent: "* { transition: none !important }" }));
  document.querySelector("main [title]")?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
}, 200);
