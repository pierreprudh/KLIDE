// Throwaway page: the Settings "Advisor model" row near the top of the window,
// with the real ModelPicker. Only the IPC is faked.
//   npx vite --port 1421  →  http://localhost:1421/preview/advisor-picker.html
//   ?dir=up   →  the composer's default preference; must still open downward here
import { useState } from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "../src/styles/tokens.css";
import { ModelPicker } from "../src/components/ai/ModelPicker";
import type { ProviderId } from "../src/agent/types";

document.documentElement.dataset.theme = "klide-light";
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  transformCallback: (cb: unknown) => cb,
  unregisterCallback: () => {},
  invoke: async (cmd: string) => {
    if (cmd === "ai_provider_model_meta") return [];
    if (cmd === "ai_provider_models") return ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"];
    return [];
  },
};

function Page() {
  const [model, setModel] = useState("claude-sonnet-4-6");
  return (
    <div style={{ height: "100vh", overflow: "auto", background: "var(--bg)", color: "var(--fg)" }}>
      <div style={{ padding: "40px 24px", display: "flex", justifyContent: "flex-end" }}>
        <div style={{ width: 160 }}>
          <ModelPicker
            provider={"anthropic" as ProviderId}
            model={model}
            availableModels={["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"]}
            direction={(new URLSearchParams(location.search).get("dir") as "up"|"down") ?? "up"}
            onChange={(m) => { setModel(m); (window as any).__picked = m; }}
          />
        </div>
      </div>
      <div style={{ height: 2000 }} />
    </div>
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(<Page />);
