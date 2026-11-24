import { useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "../src/styles/tokens.css";
import { NativePermissionSelector } from "../src/components/ai/NativePermissionSelector";
import { DELEGATES } from "../src/delegates";

document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") ?? "klide-light";
function Preview() {
  const [choices, setChoices] = useState<Record<string, string | undefined>>({});
  return <main style={{ minHeight: "100vh", padding: 32, background: "var(--bg)", color: "var(--fg)", fontFamily: "var(--font-ui)" }}>
    <h1 style={{ fontSize: 20 }}>Native agent permissions</h1>
    <p>Each agent keeps its own vocabulary and brand mark.</p>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 24, marginTop: "min(50vh, 440px)" }}>
      {DELEGATES.map(agent => <div key={agent.id}><p>{agent.label}</p>
        <NativePermissionSelector provider={agent.id} value={choices[agent.id]} onChange={choice => setChoices(previous => ({ ...previous, [agent.id]: choice }))} />
      </div>)}
    </div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
