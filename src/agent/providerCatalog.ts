// The Provider catalog — what the Rust registry (`src-tauri/src/providers.rs`)
// publishes about each Provider, read here and restated nowhere.
//
// The rows come from `providerCatalog.generated.ts`, a mirror the Rust test
// `provider_catalog_mirror_is_current` writes from the registry and fails the
// build on when it is stale — so the picker has every fact synchronously at
// first paint, without an IPC round trip, and without a hand-kept copy. The
// same rows come back live from `ai_list_providers` (`src/ipc/aiProviders.ts`
// `listProviders`); `verifyProviderCatalog` compares the two in dev.
//
// Two kinds of id are deliberately not rows: `auto` (the router, not a
// Provider — `AUTO_PROVIDER` in ./providers.ts) and the runtime-minted
// `custom:*` / `cli:*` ids, whose facts live in their own stores
// (src/customProviders.ts, src/customCli.ts). Every accessor here answers for
// them explicitly rather than falling through to a builtin's value.

import { PROVIDER_ROWS } from "./providerCatalog.generated";

export type ProviderGroupKey = "local" | "hosted" | "subscription";
export type ProviderWire = "ollama" | "anthropic" | "openai" | "delegate";

/** The run-loop quirks the Rust Harness reads off the row (`ProviderCaps`).
 *  The renderer reads the one it shares: `minimalChatContext` picks the bare
 *  Chat prompt. */
export type ProviderCaps = {
  structuredReplay: boolean;
  minimalChatContext: boolean;
  appendTodoUpdates: boolean;
};

/** One published registry row — the serde shape of Rust `ProviderRow`. */
export type ProviderRow = {
  id: string;
  label: string;
  shortLabel: string | null;
  group: ProviderGroupKey;
  wire: ProviderWire;
  /** The env var a hosted key may come from; `null` for local / subscription. */
  keyEnv: string | null;
  keyEnvLegacy: string | null;
  keyPlaceholder: string | null;
  /** `null` on a subscription row: the CLI's own default wins. */
  defaultModel: string | null;
  presets: readonly string[];
  /** A stable key `components/ai/icons.tsx` maps to a logo + colour. */
  brand: string;
  hasCredits: boolean;
  isLocalServer: boolean;
  hasNumCtx: boolean;
  caps: ProviderCaps;
  contextWindow: number | null;
};

// The mirror is `as const` so ids and brands are literal types; this line is
// where it is checked against the wire shape.
const ROWS: readonly ProviderRow[] = PROVIDER_ROWS;

/** The ids the Rust registry holds — the builtin half of `ProviderId`. */
export type BuiltinProviderId = (typeof PROVIDER_ROWS)[number]["id"];
/** The brand keys the registry's rows use. */
export type ProviderBrand = (typeof PROVIDER_ROWS)[number]["brand"];

/** Every builtin row, in registry order. */
export const PROVIDER_CATALOG_ROWS: readonly ProviderRow[] = ROWS;

const BY_ID: ReadonlyMap<string, ProviderRow> = new Map(ROWS.map((row) => [row.id, row]));

export function providerRow(id: string): ProviderRow | undefined {
  return BY_ID.get(id);
}

export function isBuiltinProviderId(id: string): id is BuiltinProviderId {
  return BY_ID.has(id);
}

/** The rows of one group, in registry order. */
export function providerRowsIn(group: ProviderGroupKey): ProviderRow[] {
  return ROWS.filter((row) => row.group === group);
}

/** The hosted rows — the ones a key unlocks. `keyEnv` is set on every one
 *  (`every_row_is_a_whole_provider` pins that in Rust). */
export function hostedProviderRows(): (ProviderRow & { keyEnv: string })[] {
  return providerRowsIn("hosted").filter(
    (row): row is ProviderRow & { keyEnv: string } => row.keyEnv !== null,
  );
}

export function providerLabel(id: string): string | undefined {
  return BY_ID.get(id)?.label;
}

/** `null` for an id that is not a builtin row (`auto`, `custom:*`, `cli:*`). */
export function providerGroup(id: string): ProviderGroupKey | null {
  return BY_ID.get(id)?.group ?? null;
}

export function providerDefaultModel(id: string): string | null {
  return BY_ID.get(id)?.defaultModel ?? null;
}

/** Models the picker offers for this Provider before they are installed or
 *  listed. Empty for anything without a row. */
export function providerPresets(id: string): readonly string[] {
  return BY_ID.get(id)?.presets ?? [];
}

export function providerKeyEnv(id: string): string | null {
  return BY_ID.get(id)?.keyEnv ?? null;
}

/** The brand key a logo hangs on. A builtin answers with its row; anything
 *  else (a custom endpoint, a maker mark like `gemini`) is its own key. */
export function providerBrand(id: string): string {
  return BY_ID.get(id)?.brand ?? id;
}

const HOSTED_CAPS: ProviderCaps = {
  structuredReplay: true,
  minimalChatContext: false,
  appendTodoUpdates: false,
};

/** The row's quirks; the hosted posture for an id without a row — the same
 *  fallback Rust `ProviderCaps::for_provider` uses for a `custom:*` endpoint. */
export function providerCaps(id: string): ProviderCaps {
  return BY_ID.get(id)?.caps ?? HOSTED_CAPS;
}

/** Whether a request on this Provider may size its own window (`num_ctx`). */
export function providerHasNumCtx(id: string): boolean {
  return BY_ID.get(id)?.hasNumCtx ?? false;
}

/** A localhost server Klide itself starts and stops. */
export function isLocalServerProvider(id: string): boolean {
  return BY_ID.get(id)?.isLocalServer ?? false;
}

export function providerHasCredits(id: string): boolean {
  return BY_ID.get(id)?.hasCredits ?? false;
}

/** Compare the mirror with what Rust serves right now. A mismatch means the
 *  generated file was not regenerated after a registry change — the Rust test
 *  catches that in CI; this is the same check for a dev build that skipped
 *  `cargo test`. Resolves to the differing ids (empty when they agree). */
export async function verifyProviderCatalog(
  fetchRows: () => Promise<ProviderRow[]>,
): Promise<string[]> {
  const live = await fetchRows();
  const differing: string[] = [];
  const liveById = new Map(live.map((row) => [row.id, row]));
  for (const row of ROWS) {
    const theirs = liveById.get(row.id);
    if (!theirs || JSON.stringify(theirs) !== JSON.stringify(row)) differing.push(row.id);
  }
  for (const row of live) if (!BY_ID.has(row.id)) differing.push(row.id);
  return differing;
}
