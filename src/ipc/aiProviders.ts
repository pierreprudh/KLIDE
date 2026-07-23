import { invoke } from "@tauri-apps/api/core";

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

export function modelSupportsTools(provider: string, model: string): Promise<boolean> {
  return invoke<boolean>("ai_model_supports_tools", { provider, model });
}

export function modelSupportsReflection(provider: string, model: string): Promise<boolean> {
  return invoke<boolean>("ai_model_supports_reflection", { provider, model });
}

export function modelSupportsVision(provider: string, model: string): Promise<boolean> {
  return invoke<boolean>("ai_model_supports_vision", { provider, model });
}

export function readProviderContextWindow(provider: string, model: string): Promise<number> {
  return invoke<number>("ai_context_window", { provider, model });
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
