// Throwaway page for the Focus start stage's direction cards. Not part of
// the app: it renders the real HomeCard against the real tokens, in both
// states the stage has — the four starters on a new project, and resume
// cards wearing provider marks.
//
//   npx vite --port 1421      →  http://localhost:1421/preview/home-cards.html
//   ?theme=dark | klide-light | …
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "../src/styles/tokens.css";
import { HomeCard, STARTERS } from "../src/components/FocusMode";

const THEME = new URLSearchParams(location.search).get("theme") ?? "dark";
document.documentElement.dataset.theme = THEME;

const RESUMES = [
  { title: "Wire the ptyd reattach", sub: "3 hours ago", model: "claude-sonnet-4-6", provider: "claude-code" },
  { title: "Explain the routing gate", sub: "yesterday", model: "llama3.1:8b", provider: "ollama" },
  { title: "Untitled conversation", sub: "4 days ago", model: null, provider: null },
] as const;

function Page() {
  return (
    <div style={{ padding: "48px 40px", background: "var(--bg)", minHeight: "100vh", color: "var(--fg)" }}>
      <section className="klide-focus-hero" style={{ margin: 0, maxWidth: 1600 }}>
        <div className="klide-focus-card-area">
          <div className="klide-focus-card-label">Start with a direction</div>
          <div className="klide-focus-card-grid">
            {STARTERS.map((s, i) => (
              <HomeCard key={s.title} title={s.title} sub={s.sub} kind={s.kind} index={i} onClick={() => {}} />
            ))}
          </div>
        </div>
        <div className="klide-focus-card-area" style={{ marginTop: 40 }}>
          <div className="klide-focus-card-label">Continue where you left off</div>
          <div className="klide-focus-card-grid">
            {RESUMES.map((c, i) => (
              <HomeCard key={c.title} title={c.title} sub={c.sub} kind="resume" model={c.model} provider={c.provider} index={i} onClick={() => {}} />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Page />);
