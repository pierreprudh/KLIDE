import { invoke } from "@tauri-apps/api/core";
import type { ProviderRow } from "../agent/providerCatalog";

/** The Rust registry, one published row per Provider — the same rows the
 *  generated mirror (`src/agent/providerCatalog.generated.ts`) holds for
 *  first paint. Read live to verify the mirror, not to drive the picker. */
export function listProviders(): Promise<ProviderRow[]> {
  return invoke<ProviderRow[]>("ai_list_providers");
}

export type ProviderKeyStatus = {
  hasKey: boolean;
  source: "keychain" | "env" | "reference" | "none";
};

export type ProviderModelMetadata = {
  id: string;
  contextLength?: number | null;
  supportsTools?: boolean | null;
  inputPerMillion?: number | null;
  outputPerMillion?: number | null;
};

/** What a run on this pair costs the user — the Provider's call, never the
 *  model name's (`model_capabilities::PriceClass`). */
export type ModelPriceClass =
  | { kind: "subscription" }
  | { kind: "local" }
  | { kind: "priced"; inputPerMillion: number; outputPerMillion: number }
  | { kind: "unknown" };

export type ModelMaker =
  | "anthropic"
  | "open-ai"
  | "google"
  | "meta"
  | "mistral"
  | "deep-seek"
  | "qwen"
  | "xai"
  | "liquid-ai"
  | "microsoft"
  | "mini-max"
  | "moonshot"
  | "zai"
  | "sakana";

/** The one answer to "what can this model do" (`model_capabilities.rs`).
 *  `contextWindow` is `null` when nobody published one — the gauge reads
 *  "—" rather than a made-up number. `reasoningLevels` empty means no dial. */
export type ModelCapabilities = {
  contextWindow: number | null;
  supportsTools: boolean;
  supportsVision: boolean;
  reasoningLevels: string[];
  priceClass: ModelPriceClass;
  maker: ModelMaker | null;
};

export type StartLocalProviderInput = {
  provider: string;
  model: string;
  concurrency?: number;
};

/** Typed frontend Adapter for the `ai_*` Provider command family.
 * Components ask Provider-shaped questions and no longer repeat Rust command
 * names, argument keys, or wire response types throughout the UI. */
export function listProviderModels(provider: string): Promise<string[]> {
  return invoke<string[]>("ai_provider_models", { provider });
}

export function readProviderKeyStatus(provider: string): Promise<ProviderKeyStatus> {
  return invoke<ProviderKeyStatus>("ai_provider_key_status", { provider });
}

export function listProviderModelMetadata(
  provider: string,
): Promise<ProviderModelMetadata[]> {
  return invoke<ProviderModelMetadata[]>("ai_provider_model_meta", { provider });
}

/** Every fact about a pair in one round-trip, memoised in Rust. Pass
 *  `allowActivationProbe: false` to stay passive: Ollama's reasoning check can
 *  issue a tiny chat that loads a cold model, and a resumed transcript must
 *  not do that until its first send. */
export function readModelCapabilities(
  provider: string,
  model: string,
  allowActivationProbe = true,
): Promise<ModelCapabilities> {
  return invoke<ModelCapabilities>("ai_model_capabilities", {
    provider,
    model,
    allowActivationProbe,
  });
}

/** The pair's list price per million tokens, or `null` unless the Provider
 *  bills per token and the model is in the table. */
export function readModelPricing(
  provider: string,
  model: string,
): Promise<{ inputPerMillion: number; outputPerMillion: number } | null> {
  return invoke<{ inputPerMillion: number; outputPerMillion: number } | null>("ai_model_pricing", {
    provider,
    model,
  });
}

export function modelSupportsTools(provider: string, model: string): Promise<boolean> {
  return invoke<boolean>("ai_model_supports_tools", { provider, model });
}

export function modelSupportsReflection(provider: string, model: string): Promise<boolean> {
  return invoke<boolean>("ai_model_supports_reflection", { provider, model });
}

/** The reasoning efforts this pair actually accepts, weakest first. Empty
 *  means no dial — Rust reads the Codex CLI's model manifest for a Codex run,
 *  so the picker offers that model's set rather than a guess. */
export function modelReflectionLevels(provider: string, model: string): Promise<string[]> {
  return invoke<string[]>("ai_model_reflection_levels", { provider, model });
}

export function modelSupportsVision(provider: string, model: string): Promise<boolean> {
  return invoke<boolean>("ai_model_supports_vision", { provider, model });
}

/** The model's trained window, or `null` when nobody published one. */
export function readProviderContextWindow(
  provider: string,
  model: string,
): Promise<number | null> {
  return invoke<number | null>("ai_context_window", { provider, model });
}

export function readLocalProviderStatus(provider: string): Promise<boolean> {
  return invoke<boolean>("ai_local_server_status", { provider });
}

export function startLocalProvider({
  provider,
  model,
  concurrency,
}: StartLocalProviderInput): Promise<boolean> {
  return invoke<boolean>("ai_local_server_start", { provider, model, concurrency });
}

export async function stopLocalProvider(provider: string): Promise<void> {
  await invoke("ai_local_server_stop", { provider });
}
