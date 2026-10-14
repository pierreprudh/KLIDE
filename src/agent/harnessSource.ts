// A routed model string — "this Harness, that intelligence". The CLI a
// Conversation runs in (Claude Code, Codex, OpenCode, Hermes) is its agent;
// where that CLI's tokens come from (an API key, a local server, a self-hosted
// endpoint, Nous Portal) is a separate choice carried *inside* the model
// string, so the Provider never has to change to change the model. Rust reads
// the same prefix (`harness_source.rs` / `hermes_settings.rs`).
import type { ProviderId } from "./types";
import { isDelegateProvider } from "./providers";

export const HARNESS_SOURCE_PREFIX = "harness-source:";
export const HERMES_SOURCE_PREFIX = "hermes-source:";

export type RoutedSelection = { provider: string; model: string };

/** The source and model inside a routed model string; null for a plain id. */
export function routedSelection(model: string | null | undefined): RoutedSelection | null {
  if (!model) return null;
  const prefix = [HARNESS_SOURCE_PREFIX, HERMES_SOURCE_PREFIX].find((p) => model.startsWith(p));
  if (!prefix) return null;
  try {
    const parsed = JSON.parse(model.slice(prefix.length)) as Partial<RoutedSelection> | null;
    return parsed && typeof parsed.provider === "string" && typeof parsed.model === "string"
      ? { provider: parsed.provider, model: parsed.model }
      : null;
  } catch {
    return null;
  }
}

export function routedModelString(harness: ProviderId, source: string, model: string): string {
  return (harness === "hermes" ? HERMES_SOURCE_PREFIX : HARNESS_SOURCE_PREFIX) + JSON.stringify({ provider: source, model });
}

/** What picking `picked` in the agent menu means for a Conversation that
 *  began on `origin`. A thread that started in a Delegate stays in it: an
 *  API / local / self-hosted pick routes that CLI's intelligence, and another
 *  CLI is refused — the thread's history lives in the first CLI's session. A
 *  thread with no origin yet, or one that began on an API Provider, switches
 *  as before. */
export type AgentPick =
  | { kind: "switch" }
  | { kind: "route"; harness: ProviderId }
  | { kind: "refuse"; harness: ProviderId };

export function agentPickForConversation(origin: ProviderId | undefined, picked: ProviderId): AgentPick {
  if (!origin || !isDelegateProvider(origin) || picked === origin) return { kind: "switch" };
  return isDelegateProvider(picked) ? { kind: "refuse", harness: origin } : { kind: "route", harness: origin };
}
