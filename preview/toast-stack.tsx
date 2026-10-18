// Throwaway page for the toast stack: the real ToastHost against the real
// tokens, fed from buttons instead of app events.
//
//   npx vite --port 1421      →  http://localhost:1421/preview/toast-stack.html
//   ?theme=dark | klide-light | sage-garden | …
//
// Push three or four, then point at the corner to fan them out.
// ?demo pushes three on load (kept until dismissed); ?demo&open also fans
// them out, for a headless screenshot that can't hover; add &still there.
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "../src/styles/tokens.css";
import ToastHost from "../src/components/ToastHost";
import { notify } from "../src/toast";

const THEME = new URLSearchParams(location.search).get("theme") ?? "klide-light";
document.documentElement.dataset.theme = THEME;

const SAMPLES: [string, Parameters<typeof notify>[1]][] = [
  ["Saved src/App.tsx", undefined],
  ["Worktree ready — feat/toast-stack checked out beside main", undefined],
  ["Couldn't reach Ollama — is the server running on :11434?", { action: { label: "Start", run: () => notify("Starting Ollama…") } }],
  ["File changed on disk — reload to see the new version", { action: { label: "Reload", run: () => {} } }],
  ["Claude Code needs you — waiting on a permission", undefined],
];

function Page() {
  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--fg)", fontFamily: "var(--font-ui)", padding: 32, display: "flex", flexWrap: "wrap", gap: 8, alignContent: "flex-start", ["--size-status-bar" as string]: "24px" }}>
      {SAMPLES.map(([msg, opts]) => (
        <button key={msg} onClick={() => notify(msg, opts)} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-elevated)", color: "var(--fg)" }}>
          {msg.split(" — ")[0]}
        </button>
      ))}
      <button onClick={() => SAMPLES.slice(0, 3).forEach(([m, o], i) => setTimeout(() => notify(m, o), i * 350))} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-hover)", color: "var(--fg)" }}>
        Burst of three
      </button>
      <ToastHost />
    </div>
  );
}

const params = new URLSearchParams(location.search);
if (params.has("still")) {
  // Headless Chrome's virtual clock doesn't run CSS transitions to the end.
  const still = document.createElement("style");
  still.textContent = "* { transition: none !important; }";
  document.head.append(still);
}
if (params.has("demo")) {
  setTimeout(() => {
    SAMPLES.slice(0, 3).forEach(([m, o]) => notify(m, { ...o, duration: 0 }));
    if (params.has("open")) {
      setTimeout(() => {
        document.querySelector('[aria-label="Notifications"]')
          ?.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
      }, 600);
    }
  }, 100);
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Page />);
