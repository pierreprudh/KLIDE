import type { AgentMode, ProviderId } from "./types";
import { customProviderSync } from "../customProviders";
import { customCliSync, isCustomCli } from "../customCli";
import { isDelegateId } from "../delegates";

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
      { id: "omp", name: "Omp", available: true },
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

export const MLX_MODEL_PRESETS = [
  "mlx-community/Llama-3.1-8B-Instruct-4bit",
  "Qwen/Qwen3-4B-MLX-4bit",
  "mlx-community/gemma-2-9b-it-4bit",
  "mlx-community/gemma-4-E4B-it-qat-4bit",
  "mlx-community/gemma-4-12B-it-qat-4bit",
] as const;

/** Curated Ollama models offered in the picker even before they're pulled.
 *  `pierreprudh/klide-8b` is Klide's own LoRA fine-tune (trained on agent
 *  traces to run this harness's tool/edit contract). Pull it with
 *  `ollama pull pierreprudh/klide-8b` — https://ollama.com/pierreprudh/klide-8b */
export const OLLAMA_MODEL_PRESETS = ["pierreprudh/klide-8b"] as const;

/** Sentinel model for delegate CLIs meaning "no model picked" — the Rust
 *  side (delegate::CLI_DEFAULT_MODEL) omits the model flag when it sees this,
 *  so the CLI opens on whatever default its own settings choose. Forcing a
 *  hardcoded model here made every Claude Code session open on Sonnet. */
export const CLI_DEFAULT_MODEL = "default";

export const DEFAULT_MODELS: Record<ProviderId, string> = {
  ollama: "llama3.1:8b",
  mlx: MLX_MODEL_PRESETS[0],
  lmstudio: "local-model",
  llamacpp: "local-model",
  vllm: "local-model",
  "claude-code": CLI_DEFAULT_MODEL,
  codex: CLI_DEFAULT_MODEL,
  opencode: CLI_DEFAULT_MODEL,
  omp: CLI_DEFAULT_MODEL,
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
  const builtin = ALL_PROVIDERS.find((p) => p.id === id)?.name;
  if (builtin) return builtin;
  // Self-hosted providers aren't in the static list — resolve their label
  // from the custom-provider cache, falling back to a humanised id so we
  // never mislabel a custom endpoint as "Ollama".
  if (id.startsWith("custom:")) {
    return customProviderSync(id)?.label ?? (id.slice("custom:".length) || "Custom");
  }
  if (id.startsWith("cli:")) {
    return customCliSync(id)?.label ?? (id.slice("cli:".length) || "Custom CLI");
  }
  return "Ollama";
}

/** PROVIDER_GROUPS plus a dynamic "Self-hosted" group built from the
 *  caller-supplied custom providers. Used by the AI panel's provider
 *  dropdown so user-added endpoints appear alongside the built-ins. */
export function providerGroupsWithCustom(
  custom: { id: string; label: string }[],
  customCli: { id: string; label: string }[] = []
): ProviderGroup[] {
  const groups = [...PROVIDER_GROUPS];
  if (customCli.length > 0) {
    groups.splice(2, 0, {
      label: "Custom CLIs",
      items: customCli.map((c) => ({
        id: c.id as ProviderId,
        name: c.label,
        available: true,
      })),
    });
  }
  if (custom.length > 0) {
    groups.push({
      label: "Self-hosted",
      items: custom.map((c) => ({
        id: c.id as ProviderId,
        name: c.label,
        available: true,
      })),
    });
  }
  return groups;
}

export function isDelegateProvider(id: ProviderId): boolean {
  return isDelegateId(id) || isCustomCli(id);
}

export function normalizeAgentMode(value: string | null): AgentMode {
  if (value === "build" || value === "goal") return "goal";
  if (value === "plan") return "plan";
  return "chat";
}
