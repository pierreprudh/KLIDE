// Custom (self-hosted) providers — the frontend data layer over the Rust
// custom-provider store (`custom_provider_*` commands, persisted to
// ~/.klide/custom_providers.json). Config (label, base URL, default model)
// is non-secret and lives here; the bearer token rides the keychain via
// the existing ai_set_provider_key path, keyed by the same id.
//
// A small module-level cache lets synchronous helpers (e.g. providerName in
// agent/providers.ts) resolve a custom id's label without an await. React
// components keep their own state and call refreshCustomProviders() to stay
// in sync after a mutation.

import { invoke } from "@tauri-apps/api/core";
import type { ProviderId } from "./agent/types";

export const CUSTOM_ID_PREFIX = "custom:";

export type CustomProvider = {
  /** `custom:<slug>` — unique id, also the keychain key. */
  id: string;
  /** Display name, e.g. "My Gateway". */
  label: string;
  /** OpenAI-compatible base URL, e.g. https://llm.example.com/v1 */
  baseUrl: string;
  /** Model pre-selected when this provider is first chosen. */
  defaultModel: string;
  /**
   * Optional `${VAR}` reference, resolved from the environment or
   * `~/.klide/.env` instead of the keychain. Non-secret, so it persists in
   * plain config; the value lives in the user's `.env`. Absent for endpoints
   * that use a keychain token (or no auth).
   */
  tokenRef?: string;
};

let cache: CustomProvider[] = [];

/** Mint a `custom:` id from a free-text label (lowercased, slugified). */
export function customIdFromLabel(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
  return `${CUSTOM_ID_PREFIX}${slug || "endpoint"}`;
}

/** True for a self-hosted provider id. */
export function isCustomProvider(id: string): boolean {
  return id.startsWith(CUSTOM_ID_PREFIX);
}

/** Last-loaded list, synchronously. Empty until refreshCustomProviders runs. */
export function getCustomProvidersSync(): CustomProvider[] {
  return cache;
}

/** Look up one cached custom provider by id. */
export function customProviderSync(id: string): CustomProvider | undefined {
  return cache.find((p) => p.id === id);
}

/** Load from the Rust store and update the cache. Call on app start and
 *  after any mutation. */
export async function refreshCustomProviders(): Promise<CustomProvider[]> {
  cache = await invoke<CustomProvider[]>("custom_provider_list");
  return cache;
}

/** Create or update a custom provider, then refresh the cache. */
export async function upsertCustomProvider(provider: CustomProvider): Promise<void> {
  await invoke("custom_provider_upsert", { provider });
  await refreshCustomProviders();
}

/** Remove a custom provider (and its keychain token), then refresh. */
export async function removeCustomProvider(id: string): Promise<void> {
  await invoke("custom_provider_remove", { id });
  await refreshCustomProviders();
}

/** The default model for a (possibly custom) provider, or "" if unknown. */
export function customDefaultModel(id: ProviderId): string {
  return customProviderSync(id)?.defaultModel ?? "";
}
