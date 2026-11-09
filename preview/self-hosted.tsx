// Real settings UI with in-memory IPC fixtures; no server or credentials needed.
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "../src/styles/tokens.css";
import type { CustomProvider } from "../src/customProviders";

document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") ?? "klide-light";
let providers: CustomProvider[] = [];
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: { provider: CustomProvider; id: string }) => {
    switch (cmd) {
      case "custom_provider_list": return providers;
      case "custom_provider_upsert":
        providers = [...providers.filter((p) => p.id !== args.provider.id), args.provider];
        return;
      case "custom_provider_remove": providers = providers.filter((p) => p.id !== args.id); return;
      case "custom_provider_probe":
        if (args.provider.baseUrl.includes("offline")) throw "Could not reach the endpoint. Check the server address and network connection.";
        return { models: ["lab-model", "coding-model"], elapsedMs: 42 };
      default: throw `Preview has no stub for ${cmd}`;
    }
  },
};
const { CustomEndpointsBlock } = await import("../src/components/settings/customProviders");
ReactDOM.createRoot(document.getElementById("root")!).render(
  <main style={{ minHeight: "100vh", boxSizing: "border-box", padding: "48px 24px", background: "var(--bg)", color: "var(--fg)", fontFamily: "var(--font-ui)" }}>
    <div style={{ maxWidth: 660, margin: "0 auto" }}>
      <h1 style={{ fontSize: 22, color: "var(--fg-strong)" }}>Self-hosted endpoints</h1>
      <CustomEndpointsBlock />
    </div>
  </main>,
);
