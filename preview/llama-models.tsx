import { useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "../src/styles/tokens.css";
import "../src/components/settings/llamaServerSetup.css";
import { LlamaModelCards } from "../src/components/settings/llamaModelCards";
import { CommunityModelConfigurations, LocalModelCatalogBrowser } from "../src/components/settings/localModelCatalogBrowser";
import { Row, StatusText } from "../src/components/settings/controls";
import { ChevronDown, ProviderLogo } from "../src/components/ai/icons";
import type { LlamaSetupInfo } from "../src/ipc/aiProviders";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "cursor-dark";
const info: LlamaSetupInfo = {
  machine: { chip: "Apple M5", memoryGb: 16, cpuCores: 10, acceleration: "Metal" },
  recommendedModel: "Qwen/Qwen3-8B-GGUF:Q4_K_M", selectedModel: null,
  memoryBudgetGb: 10.4, runtimeInstalled: true,
  models: [
    { id: "pierreprudh/klide-8b", label: "Klide 8B", maker: "klide", description: "Tuned for Klide’s tools and file edits.", url: "https://ollama.com/pierreprudh/klide-8b", quantization: "Q8_0", downloadGb: 9.01, memoryGb: 12.5 },
    { id: "Qwen/Qwen3-8B-GGUF:Q4_K_M", label: "Qwen3 8B", maker: "qwen", description: "Reasoning, coding and everyday tasks.", url: "https://huggingface.co/Qwen/Qwen3-8B-GGUF", quantization: "Q4_K_M", downloadGb: 5, memoryGb: 8 },
    { id: "bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M", label: "Llama 3.2 3B", maker: "meta", description: "A light option for everyday conversation.", url: "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF", quantization: "Q4_K_M", downloadGb: 2.02, memoryGb: 4 },
    { id: "mistralai/Ministral-3-3B-Instruct-2512-GGUF:Q4_K_M", label: "Ministral 3 3B", maker: "mistral", description: "Compact, multilingual instruction following.", url: "https://huggingface.co/mistralai/Ministral-3-3B-Instruct-2512-GGUF", quantization: "Q4_K_M", downloadGb: 2.15, memoryGb: 4.5 },
  ],
};
function Preview() {
  const [model, setModel] = useState(info.recommendedModel!);
  const [hardware, setHardware] = useState("");
  return <main style={{ maxWidth: 900, margin: "24px auto", padding: 24, color: "var(--fg)", fontFamily: "var(--font-ui)" }}>
    <h2 className="klide-settings-heading">Local servers</h2>
    <Row leading={<ProviderLogo id="ollama" size={24} />} title="Ollama" description="Server is reachable on localhost."
      control={<StatusText tone="ok">Running</StatusText>} />
    <Row leading={<ProviderLogo id="mlx" size={24} />} title="MLX (Apple Silicon)" description="Server is not running. Start it to enable chat."
      control={<StatusText tone="idle">Stopped</StatusText>} />
    <section aria-label="Local model recommendations">
    <Row leading={<ProviderLogo id="llamacpp" size={24} />} title="llama.cpp" description="Apple M5 · 16 GB RAM"
      control={<StatusText tone="idle">Installed</StatusText>} />
    <div className="klide-llama-body">
    <LlamaModelCards info={info} value={model} onChange={setModel} disabled={false} />
    <div className="klide-llama-controls"><button className="klide-button klide-button-secondary">Start {info.models.find((m) => m.id === model)?.label}</button><span className="klide-llama-hint">Downloads on first start</span></div>
    {params.has("integration") ? <LocalModelCatalogBrowser machine={info.machine} /> : <details className="klide-llama-details klide-local-catalog"><summary><span aria-hidden="true"><ChevronDown /></span>Community benchmarks</summary><div>
      <p className="klide-llama-hint">Measured configurations from the Local AI registry. These are separate from Klide’s estimated model suggestions.</p>
      <CommunityModelConfigurations catalog={{ revision: "873bb2f8", hardware: [{ id: "m5-24", name: "Apple M5", memoryGb: 24, recipes: [] }] }} machine={info.machine} hardware={hardware} onHardwareChange={setHardware} />
    </div></details>}
    </div>
    </section>
  </main>;
}
document.body.style.background = "var(--bg)";
for (const element of [document.documentElement, document.body, document.getElementById("root")!]) {
  element.style.height = "auto";
  element.style.overflow = "visible";
}
createRoot(document.getElementById("root")!).render(<Preview />);
