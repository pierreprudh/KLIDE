// Throwaway page for Settings › Self-hosted endpoints: one endpoint row with
// the model list ontraak-llm-api really served on 2026-10-30, tagged the way
// its /v1/models now tags rows (bge-m3 embedding, glm-ocr OCR). IPC is faked.
//
//   http://localhost:1420/preview/endpoint-models.html   (?open=1 opens it)
//   ?theme=dark | klide-light | …
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "../src/styles/tokens.css";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "klide-light";

const MODELS = [
  "ontraak/lfm3-1.7b-mlx:128k",
  "lfm3:1.7b-mlx-bf16",
  "ontraak/qwen3.8-27b-mlx:128k",
  "ontraak/lfm2.5-8b-a1b:128k",
  "qwen3.8:27b-mlx",
  "klide-8b:latest",
  "bge-m3:latest",
  "pierreprudh/gemma4-12b-mtp:latest",
  "glm-ocr:latest",
  "hf.co/LiquidAI/LFM2.5-8B-A1B-GGUF:BF16",
  "gpt-oss:20b",
];
const TASK: Record<string, string> = { "bge-m3:latest": "embedding", "glm-ocr:latest": "ocr" };

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  transformCallback: (cb: unknown) => cb,
  unregisterCallback: () => {},
  invoke: async (cmd: string) => {
    switch (cmd) {
      case "ai_provider_key_status":
        return { hasKey: true, source: "reference" };
      case "ai_provider_models":
        await new Promise((r) => setTimeout(r, 200));
        return MODELS;
      case "ai_provider_model_meta":
        return MODELS.map((id) => ({ id, task: TASK[id] ?? "chat" }));
      default:
        throw `preview: no stub for ${cmd}`;
    }
  },
};

const { CustomEndpointRow } = await import("../src/components/settings/customProviders");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--fg)", fontFamily: "var(--font-ui)", padding: "32px 0" }}>
    <div style={{ maxWidth: 720, margin: "0 auto" }}>
      <CustomEndpointRow
        endpoint={{
          id: "custom:ontraak-prod",
          label: "Prod",
          baseUrl: "https://prod.taild41375.ts.net:3004/v1",
          defaultModel: "ontraak/qwen3.8-27b-mlx:128k",
        } as never}
        busy={false}
        onEdit={() => {}}
        onRemove={() => {}}
        onSetDefault={() => {}}
      />
    </div>
  </div>,
);

if (params.get("open")) setTimeout(() => (document.querySelector(".klide-settings-row") as HTMLElement)?.click(), 300);
