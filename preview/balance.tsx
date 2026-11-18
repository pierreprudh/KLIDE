// The Balance block with every hosted provider and a few top-ups; no native calls.
import { createRoot } from "react-dom/client";
import "../src/styles/tokens.css";
import { ProviderBalanceBlock } from "../src/components/settings/apiKeys";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "klide-light";
for (const id of ["anthropic", "deepseek", "openai", "openrouter"]) localStorage.setItem(`klide.budget.${id}`, "10");
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke: async () => null };
createRoot(document.getElementById("root")!).render(
  <div style={{ padding: 24, maxWidth: Number(params.get("w") ?? 900), background: "var(--bg)", minHeight: "100vh" }}>
    <ProviderBalanceBlock />
  </div>,
);
