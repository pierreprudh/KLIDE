import type { AgentMode, ProviderId } from "./types";

export type ProviderGroup = {
  label: string;
  items: { id: ProviderId; name: string; available: boolean }[];
};

export const PROVIDER_GROUPS: ProviderGroup[] = [
  {
    label: "Local",
    items: [
      { id: "ollama", name: "Ollama", available: true },
      { id: "mlx", name: "MLX (Apple Silicon)", available: true },
      { id: "lmstudio", name: "LM Studio", available: false },
      { id: "llamacpp", name: "llama.cpp", available: false },
      { id: "vllm", name: "vLLM", available: false },
    ],
  },
  {
    label: "Subscription",
    items: [
      { id: "claude-code", name: "Claude Code", available: true },
      { id: "codex", name: "Codex", available: true },
      { id: "opencode", name: "OpenCode", available: true },
    ],
  },
  {
    label: "API",
    items: [
      { id: "anthropic", name: "Anthropic", available: true },
      { id: "openai", name: "OpenAI", available: true },
      { id: "gemini", name: "Google Gemini", available: false },
      { id: "mistral", name: "Mistral", available: true },
      { id: "xai", name: "xAI Grok", available: true },
      { id: "openrouter", name: "OpenRouter", available: true },
    ],
  },
];

export const ALL_PROVIDERS = PROVIDER_GROUPS.flatMap((g) => g.items);

export const DEFAULT_MODELS: Record<ProviderId, string> = {
  ollama: "llama3.1:8b",
  mlx: "mlx-community/Meta-Llama-3.1-8B-Instruct-4bit",
  lmstudio: "local-model",
  llamacpp: "local-model",
  vllm: "local-model",
  "claude-code": "claude-sonnet-4-6",
  codex: "gpt-5",
  opencode: "opencode",
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4.1",
  gemini: "gemini-2.5-pro",
  mistral: "mistral-large-latest",
  xai: "grok-4",
  openrouter: "openai/gpt-4o",
};

export const MODE_OPTIONS: { id: AgentMode; label: string; title: string }[] = [
  { id: "chat", label: "Chat", title: "Answer without tools." },
  { id: "plan", label: "Plan", title: "Read files and propose a plan." },
  { id: "goal", label: "Goal", title: "Use tools and propose diff-reviewed edits." },
];

export function providerName(id: ProviderId): string {
  return ALL_PROVIDERS.find((p) => p.id === id)?.name ?? "Ollama";
}

export function isDelegateProvider(id: ProviderId): boolean {
  return id === "claude-code" || id === "codex" || id === "opencode";
}

export function normalizeAgentMode(value: string | null): AgentMode {
  if (value === "build" || value === "goal") return "goal";
  if (value === "plan") return "plan";
  return "chat";
}

