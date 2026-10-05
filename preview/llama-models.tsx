import { useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "../src/styles/tokens.css";
import "../src/components/settings/llamaServerSetup.css";
import { LlamaModelCards } from "../src/components/settings/llamaModelCards";
import { Row, StatusText } from "../src/components/settings/controls";
import { ProviderLogo } from "../src/components/ai/icons";
import type { LlamaSetupInfo } from "../src/ipc/aiProviders";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "cursor-dark";
const info: LlamaSetupInfo = {
  machine: { chip: "Apple M5", memoryGb: 16, cpuCores: 10, acceleration: "Metal" },
  recommendedModel: "Qwen/Qwen3-8B-GGUF:Q4_K_M", selectedModel: null,
  memoryBudgetGb: 10.4, runtimeInstalled: true,
  models: [
    { id: "pierreprudh/klide-8b", label: "Klide 8B", maker: "klide", description: "Tuned for Klide’s tools and file edits.", url: "https://ollama.com/pierreprudh/klide-8b", quantization: "Q8_0", downloadGb: 9.01, memoryGb: 12 },
    { id: "Qwen/Qwen3-8B-GGUF:Q4_K_M", label: "Qwen3 8B", maker: "qwen", description: "Reasoning, coding and everyday tasks.", url: "https://huggingface.co/Qwen/Qwen3-8B-GGUF", quantization: "Q4_K_M", downloadGb: 5, memoryGb: 7.5 },
    { id: "bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M", label: "Llama 3.2 3B", maker: "meta", description: "A light option for everyday conversation.", url: "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF", quantization: "Q4_K_M", downloadGb: 2.02, memoryGb: 3.5 },
    { id: "mistralai/Ministral-3-3B-Instruct-2512-GGUF:Q4_K_M", label: "Ministral 3 3B", maker: "mistral", description: "Compact, multilingual instruction following.", url: "https://huggingface.co/mistralai/Ministral-3-3B-Instruct-2512-GGUF", quantization: "Q4_K_M", downloadGb: 2.15, memoryGb: 4 },
  ],
};
function Preview() {
  const [model, setModel] = useState(info.recommendedModel!);
  return <main style={{ maxWidth: 1000, margin: "48px auto", padding: 24, color: "var(--fg)", fontFamily: "var(--font-ui)" }}>
    <h2 style={{ fontSize: 18 }}>Local Servers</h2>
    <Row leading={<ProviderLogo id="ollama" size={24} />} title="Ollama" description="Server is reachable on localhost."
      control={<StatusText tone="ok">Running</StatusText>} />
    <Row leading={<ProviderLogo id="mlx" size={24} />} title="MLX (Apple Silicon)" description="Server is not running. Start it to enable chat."
      control={<StatusText tone="idle">Stopped</StatusText>} />
    <Row leading={<ProviderLogo id="llamacpp" size={24} />} title="llama.cpp" description="Apple M5 · 16 GB RAM"
      control={<StatusText tone="idle">Installed</StatusText>} />
    <div style={{ marginTop: 24 }}>
    <LlamaModelCards info={info} value={model} onChange={setModel} disabled={false} />
    <div className="klide-llama-controls" style={{ marginTop: 24 }}><button className="klide-button klide-button-secondary">Start {info.models.find((m) => m.id === model)?.label}</button><span className="klide-llama-hint">Downloads on first start</span></div>
    </div>
  </main>;
}
document.body.style.background = "var(--bg)";
createRoot(document.getElementById("root")!).render(<Preview />);
