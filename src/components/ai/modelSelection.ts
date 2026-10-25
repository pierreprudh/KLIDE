// Which model a live Conversation is on — and, more importantly, what is
// allowed to change it.
//
// The Conversation's `model` is metadata about a Run that already happened:
// the rail draws the maker's mark from it, Mission Control files the row under
// it, and cost is priced from it. So it must only ever move when a human picks
// a model, or when the Provider itself says the current pick does not exist.
// Two host-side echoes used to move it anyway:
//
//   * the `model` prop. It is App's idea of this panel's model, restored from
//     the persisted layout — it can be older than the session (a layout saved
//     before the Provider's model list corrected the pick). Adopting it
//     whenever it *differs* turns every unrelated App re-render into an edit.
//   * a failed model-list fetch. Falling back to this Provider's remembered
//     model treats a network error as a pick, and the remembered value can
//     belong to another Provider entirely.
//
// Both fired on one thread: it ran on `qwen3.8:27b-mlx` (the Rust run summary
// still says so) and was saved as `pierreprudh/lfm2.5-8b-a1b:latest`, so the
// history rail showed a LiquidAI mark for a Qwen conversation.

/** The host's model prop, as last observed by the panel. `undefined` before
 *  the panel has observed one (i.e. on mount). */
export type HostModelSync = {
  hostModel: string;
  /** The previous value of the same prop, or undefined on mount. */
  lastHostModel: string | undefined;
  sessionModel: string;
};

/**
 * The model this panel should adopt from its host, or `null` to keep the
 * session's own. A host prop is a pick only when it *changed*; a prop that has
 * held the same (possibly stale) value since the last render is an echo, and
 * an echo must never overwrite the Conversation the panel is showing.
 */
export function hostModelAdoption({
  hostModel,
  lastHostModel,
  sessionModel,
}: HostModelSync): string | null {
  if (lastHostModel === undefined) return null; // mount: the session owns the pair
  if (hostModel === lastHostModel) return null; // unchanged prop — an echo, not a pick
  if (!hostModel || hostModel === sessionModel) return null;
  return hostModel;
}

/**
 * Which model the picker offers when the Provider's model list can't be read.
 * The session's own model wins: the list failed, so nothing has been learned
 * about whether that model exists. The remembered value only fills a genuinely
 * empty session (a panel that has never resolved a model at all).
 */
export function offlineModelFallback(
  sessionModel: string,
  rememberedModel: string,
): string {
  return sessionModel || rememberedModel;
}

/**
 * Which model to move to when the Provider's list comes back and does *not*
 * contain the session's current pick. `null` means keep the pick.
 *
 * This is the third host-side echo, and the one the two above did not cover: a
 * *successful* list fetch that retires the current model. Retiring it is right
 * — the Provider is the authority on what it serves — but the replacement was
 * "the first starred favourite that is available", and `favModelsFor` returns
 * stars in insertion order. So the replacement was the user's OLDEST star for
 * that Provider, which for a long-lived favourites list is close to random: a
 * model starred once, months ago, outranked the one picked this morning. The
 * Provider's own remembered pick — the value the picker writes on every human
 * choice — was never consulted at all.
 *
 * Order of evidence, strongest first: the Provider's remembered human pick,
 * then its configured default, then the NEWEST star, then the list head. Only
 * the last of those is a guess.
 */
export function unavailableModelFallback({
  available,
  sessionModel,
  rememberedModel,
  providerDefault,
  favourites,
}: {
  available: string[];
  sessionModel: string;
  /** `klide.model.<provider>` — what a human last picked on this Provider. */
  rememberedModel: string;
  providerDefault: string;
  /** Stars for this Provider, oldest first (`favModelsFor`'s order). */
  favourites: string[];
}): string | null {
  if (available.length === 0) return null;
  if (available.includes(sessionModel)) return null;
  const has = (candidate: string) => !!candidate && available.includes(candidate);
  if (has(rememberedModel)) return rememberedModel;
  if (has(providerDefault)) return providerDefault;
  // Newest star first: the far end of the insertion-ordered list.
  const newestStar = [...favourites].reverse().find(has);
  return newestStar ?? available[0];
}

/** Whether the remembered pick should be forgotten: the Provider listed what
 *  this key serves and the pick is not in it. Kept, it seeds every fresh
 *  session on a model the send can reach before the list retires it (Mistral
 *  Large on a plan without it: a 403 on the first message, every time). Only
 *  a real listing judges — an empty or failed one says nothing, and a
 *  Delegate's list is partial by design. */
export function forgetsRememberedModel({ listed, remembered, delegate }: {
  listed: string[];
  remembered: string | null;
  delegate: boolean;
}): boolean {
  return !delegate && listed.length > 0 && !!remembered && !listed.includes(remembered);
}

/**
 * The model a Provider *switch* lands on.
 *
 * "The top favourite for that provider" was the intent, and `favModelsFor`
 * returns stars oldest-first — so the seed was the oldest star, and the
 * Provider's remembered pick was never consulted. Switching to a Provider you
 * use daily handed you a model you starred once and never chose again.
 *
 * A star is a bookmark; the last model you actually ran on a Provider is the
 * stronger statement about what you want next. So: the remembered pick, then
 * the newest star, then the Provider's configured default.
 */
export function providerSwitchModel({
  remembered,
  favourites,
  providerDefault,
}: {
  /** `klide.model.<provider>`, or null when unset (or rejected as another
   *  Provider's id by the caller's guards). */
  remembered: string | null;
  /** Stars for this Provider, oldest first (`favModelsFor`'s order). */
  favourites: string[];
  providerDefault: string;
}): string {
  if (remembered) return remembered;
  return favourites[favourites.length - 1] || providerDefault;
}
