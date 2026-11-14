// Throwaway page for the restricted-folder banner, in a workbench column and
// on the Focus canvas (where the floating Git island moves down for it).
//
//   npx vite --port 1421  →  http://localhost:1421/preview/restricted-banner.html?theme=dark
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "../src/styles/tokens.css";
import { RestrictedFolderBanner } from "../src/components/RestrictedFolderBanner";

const THEME = new URLSearchParams(location.search).get("theme") ?? "dark";
document.documentElement.dataset.theme = THEME;

const trust = () => new Promise<void>((resolve) => setTimeout(resolve, 400));

function Label({ children }: { children: string }) {
  return <div style={{ fontSize: 11, color: "var(--fg-dim)", fontFamily: "var(--font-ui)", margin: "14px 16px 6px" }}>{children}</div>;
}

function App() {
  return (
    <div style={{ background: "var(--bg)", minHeight: "100vh", fontFamily: "var(--font-ui)", paddingBottom: 16 }}>
      <Label>Workbench — Git works, hooks off</Label>
      <div style={{ margin: "0 16px", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden", background: "var(--bg-elevated)" }}>
        <div style={{ height: 28, background: "var(--bg)" }} />
        <RestrictedFolderBanner gitPaused={false} onTrust={trust} />
        <div style={{ height: 34, borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", padding: "0 14px", fontSize: 12, color: "var(--fg)" }}>main.rs</div>
        <pre style={{ margin: 0, padding: 14, fontSize: 12, color: "var(--fg-subtle)", height: 70 }}>fn main() {"{"}{"\n"}    println!("hello");{"\n"}{"}"}</pre>
      </div>
      <Label>Focus — Git paused, island below the line</Label>
      <div style={{ margin: "0 16px", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden", height: 220, display: "flex" }}>
        <main className="klide-focus-main" style={{ position: "relative" }}>
          <RestrictedFolderBanner gitPaused onTrust={trust} />
          <div className="klide-focus-git-island" style={{ height: 64, border: "1px solid var(--border)", borderRadius: 20, background: "var(--bg-elevated)", fontSize: 12, color: "var(--fg-subtle)", padding: 12, boxSizing: "border-box" }}>Git island</div>
          <div style={{ margin: "auto", fontSize: 18, color: "var(--fg-strong)" }}>What should we build?</div>
        </main>
      </div>
      <Label>Narrow</Label>
      <div style={{ margin: "0 16px", width: 420, border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
        <RestrictedFolderBanner gitPaused onTrust={trust} />
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
