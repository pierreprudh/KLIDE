// The model a Provider lands on when a human switches to it — read from
// `klide.model.<provider>`, the value the panel writes on every human pick.
//
// This used to be private to AiPanel, so only the panel's own provider menu
// honoured the remembered pick: the Focus hero reset to the Provider's
// configured default on every switch, which is how OpenRouter opened on
// `openai/gpt-4o` no matter what was chosen the day before. Every provider
// switch, whichever surface hosts it, goes through `switchModelForProvider`.

import type { ProviderId } from "../../agent/types";
import { defaultModelForProvider } from "../../agent/providers";
import { favModelsFor } from "../../favModels";
import { providerSwitchModel } from "./modelSelection";

/** `klide.model.<provider>`, or the Provider's default when unset — with the
 *  guards that reject another Provider's id that leaked in. */
/** Whether `model` plainly belongs to some other Provider than `id`. Claude
 *  Code and Codex take bare model names ("opus", "gpt-5.3-codex"), so a value
 *  with a repo prefix or a tag (`deepseek/deepseek-v4.1-flash`,
 *  `pierreprudh/lfm2.5-8b-a1b:latest`) leaked in from another Provider and
 *  must never be handed to the CLI. OpenCode and omp legitimately use
 *  provider/model ids, so they are exempt — as is every API Provider, whose
 *  model lists are the only judge of their own ids. */
export function isForeignModelFor(id: ProviderId, model: string): boolean {
  return (id === "claude-code" || id === "codex") && (model.includes("/") || model.includes(":"));
}

export function storedModelForProvider(id: ProviderId): string {
  const stored = localStorage.getItem(`klide.model.${id}`);
  if (id === "mlx" && stored) {
    // MLX expects Hugging Face-style ids or local paths. Ignore stale
    // Ollama-style tags such as `gemma4:12b-mlx` from earlier shared-model UI.
    const looksLikeMlx = stored.includes("/") || stored.startsWith(".");
    if (!looksLikeMlx || stored.includes(":")) return defaultModelForProvider(id);
  }
  if (stored && isForeignModelFor(id, stored)) return defaultModelForProvider(id);
  return stored || defaultModelForProvider(id);
}

/** `klide.model.<provider>` when it holds a value this Provider can actually
 *  use — the guards in `storedModelForProvider` reject another Provider's id
 *  that leaked in, and a rejected value is no evidence of a pick. */
export function rememberedModelForProvider(id: ProviderId): string | null {
  const raw = localStorage.getItem(`klide.model.${id}`);
  if (!raw) return null;
  return storedModelForProvider(id) === raw ? raw : null;
}

/** The model a provider SWITCH lands on — see `providerSwitchModel` for why the
 *  remembered pick outranks the stars. Continuing an existing conversation still
 *  restores that conversation's own model; this only seeds fresh provider picks.
 *  If the seed turns out not to be served, the panel's models-load effect
 *  corrects it through `unavailableModelFallback`. */
export function switchModelForProvider(id: ProviderId): string {
  return providerSwitchModel({
    remembered: rememberedModelForProvider(id),
    favourites: favModelsFor(id),
    providerDefault: defaultModelForProvider(id),
  });
}
