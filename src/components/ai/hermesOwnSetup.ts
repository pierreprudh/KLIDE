import type { HermesOwnSetup } from "../../ipc/hermes";

const HERMES_PROVIDER_NAMES: Record<string, string> = {
  openrouter: "OpenRouter", openai: "OpenAI", "openai-api": "OpenAI", anthropic: "Anthropic", deepseek: "DeepSeek",
  nous: "Nous Portal", copilot: "GitHub Copilot", "openai-codex": "Codex subscription", ollama: "Ollama",
};

/** One line under Hermes's own model: who serves it and where its key lives — "via OpenRouter · OPENROUTER_API_KEY in ~/.hermes/.env". */
export function describeOwnSetup(setup: HermesOwnSetup): string {
  const parts: string[] = [];
  if (setup.provider) parts.push(`via ${HERMES_PROVIDER_NAMES[setup.provider] ?? setup.provider}`);
  if (setup.keys.length) parts.push(`${setup.keys.join(", ")} in ${setup.envPath ?? "its .env"}`);
  else parts.push("no key in its .env");
  return parts.join(" · ");
}
