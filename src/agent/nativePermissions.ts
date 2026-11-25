import catalog from "./nativePermissionModes.json";
import { isDelegateId } from "../delegates";

export type NativePermissionMode = { id: string; label: string; description: string };

const DEFAULTS: Record<keyof typeof catalog, string> = {
  "claude-code": "Accept edits",
  codex: "Workspace access",
  opencode: "Auto approve",
  omp: "Auto approve",
  amp: "Native permissions",
  cursor: "Configured permissions",
  factory: "Read only",
  copilot: "Pre-approved tools",
  hermes: "Configured permissions",
  vibe: "Configured agent",
};

/** The runner and menu share one catalog. An empty id preserves the existing
 * adapter invocation; explicit overrides are validated for their agent. */
export function nativePermissionModes(provider: string): NativePermissionMode[] {
  if (!isDelegateId(provider)) return [];
  return [{ id: "", label: `Default · ${DEFAULTS[provider]}`, description: provider === "amp"
    ? "Amp manages its own native permissions. This integration has no per-turn permission override."
    : "Use KLIDE’s existing launch settings for this agent. No global agent settings are changed." }, ...catalog[provider]];
}

export function nativePermissionMode(provider: string, selected: string | undefined): string | undefined {
  return selected && nativePermissionModes(provider).some(mode => mode.id === selected) ? selected : undefined;
}

/** Persist only modes that still exist for the agent that owns them. */
export function normalizeNativePermissions(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([provider, mode]) =>
    typeof mode === "string" && nativePermissionMode(provider, mode) !== undefined));
}
