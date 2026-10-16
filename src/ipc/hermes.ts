import { invoke } from "@tauri-apps/api/core";
export type HermesSettings = { provider: string; model: string };
export function readHermesSettings(): Promise<HermesSettings | null> {
  return invoke("hermes_read_settings");
}
export function saveHermesSettings(settings: HermesSettings, key?: string): Promise<void> {
  return invoke("hermes_save_settings", { settings, key: key ?? null });
}
export function clearHermesSettings(): Promise<void> {
  return invoke("hermes_clear_settings");
}

/** A variable Hermes's own `.env` sets differently from what Klide would pass for a source. */
export type HermesEnvOverride = { name: string; path: string; importable: boolean };
export function readHermesEnvOverrides(provider: string): Promise<HermesEnvOverride[]> {
  return invoke("hermes_env_overrides", { provider });
}
/** `hermes` keeps Hermes's key (Klide imports it); `klide` rewrites Hermes's `.env` with Klide's values. */
export function alignHermesEnv(provider: string, keep: "hermes" | "klide"): Promise<HermesEnvOverride[]> {
  return invoke("hermes_env_align", { provider, keep });
}

/** What Hermes runs on by itself — its own config's model/provider and the credential names its `.env` sets (never values). */
export type HermesOwnSetup = { model: string | null; provider: string | null; keys: string[]; envPath: string | null; configPath: string | null };
export function readHermesOwnSetup(): Promise<HermesOwnSetup> {
  return invoke("hermes_own_setup");
}
/** Changes Hermes's own default model through `hermes config set`, so the file stays Hermes's. */
export function setHermesOwnModel(model: string): Promise<HermesOwnSetup> {
  return invoke("hermes_set_own_model", { model });
}

export type HermesSourceSupport = { supported: boolean; reason: string | null };
export function readHermesSourceSupport(provider: string): Promise<HermesSourceSupport> {
  return invoke("hermes_source_support", { provider });
}

export const NOUS_SOURCE = "hermes-subscription:nous";
export function readHarnessSourceSupport(harness: string, provider: string): Promise<HermesSourceSupport> {
  return invoke("harness_source_support", { harness, provider });
}
export function listHarnessSourceModels(harness: string, provider: string): Promise<string[]> {
  return invoke("harness_source_models", { harness, provider });
}
export function loginNousPortal(): Promise<void> {
  return invoke("harness_nous_login");
}
