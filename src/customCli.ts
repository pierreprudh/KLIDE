import { invoke } from "@tauri-apps/api/core";
import type { ProviderId } from "./agent/types";

export const CUSTOM_CLI_ID_PREFIX = "cli:";

export type CustomCli = {
  /** `cli:<slug>` — unique runtime provider id. */
  id: string;
  /** Display name, e.g. "Cursor Agent". */
  label: string;
  /** Shell command template. Supports `{task}`, `{model}`, and `{resume}`. */
  commandTemplate: string;
  /** Model pre-selected when this provider is first chosen. */
  defaultModel: string;
  /** Optional model choices shown in the model picker. */
  models?: string[];
  /** Optional command shown in Settings when auth/setup is needed. */
  loginCommand?: string;
};

let cache: CustomCli[] = [];

export function customCliIdFromLabel(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
  return `${CUSTOM_CLI_ID_PREFIX}${slug || "agent"}`;
}

export function isCustomCli(id: string): boolean {
  return id.startsWith(CUSTOM_CLI_ID_PREFIX);
}

export function getCustomCliSync(): CustomCli[] {
  return cache;
}

export function customCliSync(id: string): CustomCli | undefined {
  return cache.find((p) => p.id === id);
}

export async function refreshCustomCli(): Promise<CustomCli[]> {
  cache = await invoke<CustomCli[]>("custom_cli_list");
  return cache;
}

export async function upsertCustomCli(provider: CustomCli): Promise<void> {
  await invoke("custom_cli_upsert", { provider });
  await refreshCustomCli();
}

export async function removeCustomCli(id: string): Promise<void> {
  await invoke("custom_cli_remove", { id });
  await refreshCustomCli();
}

export function customCliDefaultModel(id: ProviderId): string {
  return customCliSync(id)?.defaultModel ?? "";
}
