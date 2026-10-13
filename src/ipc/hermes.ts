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

export type HermesSourceSupport = { supported: boolean; reason: string | null };
export function readHermesSourceSupport(provider: string): Promise<HermesSourceSupport> {
  return invoke("hermes_source_support", { provider });
}
