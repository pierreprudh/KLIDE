// Full production Settings shell with synthetic, read-only native responses.
import { createRoot } from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "../src/styles/tokens.css";
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "klide-light";
document.body.style.background = "var(--bg-panel)";
Object.assign(window, { __TAURI_INTERNALS__: {
  transformCallback: (callback: unknown) => callback,
  unregisterCallback: () => {},
  invoke: async (command: string, args: Record<string, string> = {}) => {
    switch (command) {
      case "custom_cli_list": case "custom_provider_list": case "connectors_list": case "connectors_discover":
      case "cli_versions": case "ai_provider_models": case "ai_provider_model_meta": case "app_storage_dirs":
      case "app_storage_conversations": case "machines_list": return [];
      case "app_user_info": return { username: "Alex", hostname: "MacBook" };
      case "accounts_list": return { present: true, accounts: [{ name: "Personal", active: true, savedMs: 0, identity: { email: "alex@example.com" } }] };
      case "github_current_user": return { login: "alex-dev", avatarUrl: "" };
      case "ai_provider_key_status": return { hasKey: false, source: "none" };
      case "ai_subscription_status": return { provider: args.provider, installed: true, connected: true, detail: "Connected", loginOptions: [] };
      case "ollama_account_status": return { running: false, signedIn: false, detail: "Not signed in" };
      case "delegate_daemon_status": return { enabled: false, running: false };
      case "ai_provider_credits": return null;
      case "ai_local_server_status": return false;
      case "ai_local_server_details": return { ready: false, owned: false };
      case "ai_local_setup_progress": return { phase: "idle", downloadedBytes: 0, totalBytes: null, error: null };
      case "ai_llamacpp_setup_info": return {
        machine: { chip: "Apple M5", memoryGb: 16, cpuCores: 10, acceleration: "Metal" },
        memoryBudgetGb: 10.4, recommendedModel: "qwen", selectedModel: null, runtimeInstalled: true,
        models: [{ id: "qwen", label: "Qwen3 8B", maker: "qwen", memoryGb: 8, providerRelease: true, publisher: "qwen", description: "A local model.", downloadGb: 2, quantization: "Q4", url: "https://example.com/model" }],
      };
      case "plugin:event|listen": return 1;
      case "plugin:event|unlisten": return;
      default: throw new Error(`Preview has no response for ${command}`);
    }
  },
} });
const { SettingsPanel } = await import("../src/components/SettingsPanel");
const noop = () => {};
createRoot(document.getElementById("root")!).render(<SettingsPanel
  aiVisible terminalVisible explorerVisible explorerFloating={false}
  onAiVisibleChange={noop} onTerminalVisibleChange={noop} onExplorerVisibleChange={noop} onExplorerFloatingChange={noop}
  panelLayout={{}} onPanelWidthChange={noop} onPanelHeightChange={noop} availableAiModels={[]} customLayouts={[]}
  onCustomLayoutsChange={noop} onApplyLayout={noop} initialSection={params.get("section") ?? "general"}
  workspaceRoot="/Users/alex/app" onBack={noop}
/>);
