// Throwaway page for the inline approval card, kind by kind, at the two
// widths it lives at (Focus column, workbench panel). Not part of the app.
//
//   npx vite --port 1421      →  http://localhost:1421/preview/command-card.html
//   ?theme=dark | klide-light | …
//
// The cards are live: ⏎ approves and esc denies the first one (the one the
// run is blocked on) — the toast line under it says what you pressed.
import { useState } from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "@fontsource/monaspace-neon/700.css";
import "../src/styles/tokens.css";
import { InlineCommandReview } from "../src/components/InlineCommandReview";

const THEME = new URLSearchParams(location.search).get("theme") ?? "dark";
document.documentElement.dataset.theme = THEME;

function Stage({ width, children, label }: { width: number; children: React.ReactNode; label: string }) {
  return (
    <section style={{ display: "grid", gap: 6 }}>
      <div style={{ fontSize: 11, color: "var(--fg-dim)", fontFamily: "var(--font-ui)" }}>{label}</div>
      <div style={{ width, border: "1px dashed var(--border)", borderRadius: 12, padding: "16px 0 8px" }}>{children}</div>
    </section>
  );
}

function App() {
  const [said, setSaid] = useState("—");
  const say = (s: string) => () => setSaid(s);
  const cards = (
    <>
      <InlineCommandReview
        hotkeys
        command="git remote -v"
        detail="The agent wants to run a shell command in the workspace."
        pattern="git *"
        onReject={say("denied")}
        onApproveOnce={say("ran once")}
        onApproveForRun={say("approved for run")}
        onApproveForProject={say("approved for project")}
        onApprovePattern={(p) => setSaid(`pattern ${p}`)}
      />
      <InlineCommandReview
        command={"python3 - <<'PY'\nfrom pathlib import Path\np=Path('src-tauri/src/local_inference_bench.rs');s=p.read_text().replace('\"ollama\" | \"llamacpp\"','\"ollama\" | \"llamacpp\" | \"mlx\"');p.write_text(s)\nPY"}
        detail="The agent wants to run a shell command in the workspace."
        pattern="python3 *"
        interpreter={{ path: "/Users/pierre/Documents/Private/KIDE/.venv/bin/python3", version: "3.12.4", venv: ".venv" }}
        onReject={say("denied")}
        onApproveOnce={say("ran once")}
        onApproveForRun={say("approved for run")}
        onApproveForProject={say("approved for project")}
        onApprovePattern={(p) => setSaid(`pattern ${p}`)}
      />
      <InlineCommandReview
        kind="network"
        command="https://api.github.com"
        detail="The agent wants to reach a network target."
        onReject={say("denied")}
        onApproveOnce={say("allowed once")}
        onApproveForRun={say("run")}
        onApproveForProject={say("project")}
      />
      <InlineCommandReview
        kind="message"
        peer="Research thread"
        command="The spec says the journal is folded forward; I'm done with my half."
        detail="answer · read by this conversation at its next turn once approved"
        onReject={say("declined")}
        onApproveOnce={say("accepted")}
      />
      <InlineCommandReview
        kind="worker"
        peer="Claude Code implementer"
        worker="claude-code"
        command="Port the retry rule into the Rust supervisor and add a test."
        onReject={say("cancelled")}
        onApproveOnce={say("dispatched")}
      />
    </>
  );
  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--fg)", fontFamily: "var(--font-ui)", padding: 32, display: "grid", gap: 28, alignContent: "start" }}>
      <div style={{ fontSize: 12, color: "var(--fg-subtle)" }}>last action: <b style={{ color: "var(--fg-strong)" }}>{said}</b></div>
      <Stage width={820} label="Focus column">{cards}</Stage>
      <Stage width={380} label="Workbench panel">{cards}</Stage>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
