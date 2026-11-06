// Review-only launcher. Every frame renders the production components from
// this checkout; it neither opens the installed app nor starts model Runs.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "../src/styles/tokens.css";

const views = [
  { id: "library", name: "Library focus", path: "library.html", query: "&tab=none", hint: "Open Library. Tab and Shift+Tab stay inside; Escape closes it and returns to Library. Try Skills and Foundations too." },
  { id: "questions", name: "Answer buttons", path: "live-question.html", query: "", hint: "Focus an answer. Tab visits the buttons; ↑/↓ and Home/End move between them. Enter chooses. Letters still work; typing in the answer box stays text." },
  { id: "rail", name: "Sidebar resize", path: "rail.html", query: "", hint: "Tab to Resize the sidebar. ←/→ adjust 10 pixels, Home/End reach its limits, Enter folds/restores it. Timestamps now use readable secondary ink." },
  { id: "runs", name: "Run tabs", path: "mission-control.html", query: "", hint: "Compare the enabled Scheduled tab with Runs. The unselected tab is readable. Run actions and layout have not been redesigned." },
] as const;

function Review() {
  const [view, setView] = useState<(typeof views)[number]>(views[0]);
  const [theme, setTheme] = useState("klide-light");
  return <main style={{ fontFamily: "var(--font-ui)", color: "var(--fg-strong)", background: "var(--bg)", minHeight: "100vh", display: "flex", flexDirection: "column" }}>
    <header style={{ padding: "18px 24px 14px", borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 18, margin: 0 }}>Focus, keyboard & contrast fixes</h1>
        <label style={{ marginLeft: "auto", fontSize: 13 }}>Theme{" "}<select value={theme} onChange={event => setTheme(event.target.value)} style={{ font: "inherit", color: "var(--fg-strong)", background: "var(--bg-elevated)", padding: 5 }}>
          <option value="klide-light">Klide Light</option><option value="sage-garden-dark">Sage Garden Dark</option>
        </select></label>
      </div>
      <p style={{ color: "var(--fg-subtle)", fontSize: 13, margin: "8px 0 12px" }}>Production components from the source checkout. Preview data only; no model requests.</p>
      <nav aria-label="Changes to inspect" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{views.map(item => <button type="button" key={item.id} className="klide-button" aria-pressed={view.id === item.id} onClick={() => setView(item)} style={{ background: item.id === view.id ? "var(--bg-selected)" : "transparent" }}>{item.name}</button>)}</nav>
      <p style={{ fontSize: 13, margin: "12px 0 0", lineHeight: 1.5 }}>{view.hint}{" "}<a href={`/preview/${view.path}?theme=${theme}${view.query}`} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>Open separately ↗</a></p>
    </header>
    <iframe key={`${view.id}:${theme}`} title={view.name} src={`/preview/${view.path}?theme=${theme}${view.query}`} style={{ width: "100%", height: "calc(100vh - 190px)", minHeight: 700, border: 0, background: "var(--bg)" }} />
  </main>;
}

createRoot(document.getElementById("root")!).render(<Review />);
