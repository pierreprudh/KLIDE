// Focus composer foot — model picker + reasoning effort + context; no native calls.
import { createRoot } from "react-dom/client";
import "../src/styles/tokens.css";
import { ModelPicker } from "../src/components/ai/ModelPicker";
import { EffortBars, InlineMenu } from "../src/components/FocusMode";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "klide-light";
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke: async () => [] };
const rows: [string, string, number][] = [["deepseek", "deepseek-v4.1-flash", 0], ["anthropic", "claude-opus-4-7", 3], ["openai", "gpt-5.5", 5]];
createRoot(document.getElementById("root")!).render(
  <div style={{ padding: 24, background: "var(--bg)", minHeight: "100vh", display: "grid", gap: 14 }}>
    {rows.map(([provider, model, level]) => (
      <div key={model} style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 2, width: 520, padding: 10, border: "1px solid var(--border)", borderRadius: 20, background: "var(--bg-elevated)" }}>
        <ModelPicker provider={provider as never} model={model} availableModels={[model]} disabled={false} onChange={() => {}} />
        <InlineMenu label="Reasoning effort" display={level ? ["", "low", "medium", "high", "xhigh", "max"][level] : "default"} leading={<EffortBars level={level} size={13} />} options={[]} selected={undefined} onSelect={() => {}} />
        <span style={{ fontSize: 11, color: "var(--fg-dim)", padding: "0 6px" }}>1M ctx</span>
      </div>
    ))}
  </div>,
);
