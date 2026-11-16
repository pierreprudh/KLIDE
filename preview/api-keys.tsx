// The API keys page with every hosted provider; synthetic statuses, no native calls.
import { createRoot } from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/monaspace-neon/400.css";
import "../src/styles/tokens.css";
import { API_KEY_PROVIDERS, ApiKeyIntro, ApiKeyRow } from "../src/components/settings/apiKeys";
import { Panel } from "../src/components/settings/controls";
import { providerEndpointVars } from "../src/agent/providerCatalog";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "klide-light";
const keyed = new Set(["anthropic", "openai", "groq", "azure"]);
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: async (command: string, args: Record<string, string>) => {
    switch (command) {
      case "ai_provider_key_status":
        if (args.provider === "google-vertex") return { hasKey: true, source: "command" };
        return keyed.has(args.provider) ? { hasKey: true, source: "keychain" } : { hasKey: false, source: "none" };
      case "provider_keys_list": return { keys: [], main: null };
      case "ai_provider_endpoint_status":
        return providerEndpointVars(args.provider).map((name) =>
          name === "AZURE_RESOURCE_NAME" ? { name, value: "klide-east", source: "settings" }
          : name === "AWS_REGION" ? { name, value: "us-east-1", source: "env" }
          : { name, value: null, source: "none" });
      default: return null;
    }
  },
};
const only = params.get("only")?.split(",");
function Page() {
  return <main className="klide-settings-content" style={{ maxWidth: 920, margin: "0 auto", color: "var(--fg)", fontFamily: "var(--font-ui)" }}>
    <ApiKeyIntro />
    <Panel>
      {API_KEY_PROVIDERS.filter((p) => !only || only.includes(p.id)).map((p) => (
        <ApiKeyRow key={p.id} id={p.id} title={p.title} envVar={p.envVar} placeholder={p.placeholder} />
      ))}
    </Panel>
  </main>;
}
document.body.style.background = "var(--bg)";
createRoot(document.getElementById("root")!).render(<Page />);
