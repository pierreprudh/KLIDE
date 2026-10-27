// Throwaway page for the editor tab strip, without launching Tauri.
//
// The raised TabBar over an editor-coloured surface, with a mix of file
// types, a dirty tab, a nested path and the active tab in the middle.
//
//   npm run dev  →  http://localhost:1420/preview/tab-bar.html
//   ?theme=dark | klide-light | …
import { useState } from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "../src/styles/tokens.css";
import { TabBar } from "../src/components/TabBar";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "klide-light";

const TABS = [
  { path: "/w/README.md", dirty: false },
  { path: "/w/docs/KLIDE_AGENT_HARNESS_IMPLEMENTATION.md", dirty: false },
  { path: "/w/.gitignore", dirty: false },
  { path: "/w/Ideas.md", dirty: true },
  { path: "/w/src-tauri/src/delegate/mod.rs", dirty: false },
];

function App() {
  const [active, setActive] = useState(3);
  return (
    <div style={{ background: "var(--bg)", minHeight: "100vh" }}>
      <TabBar tabs={TABS} activeIdx={active} onSelect={setActive} onClose={() => {}} workspaceRoot="/w" />
      <pre style={{ margin: 0, padding: "12px 20px", fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg)" }}>
        {"1 — [x] Queue system for messages\n2 — [x] Subagent gestion via Klide harness"}
      </pre>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
