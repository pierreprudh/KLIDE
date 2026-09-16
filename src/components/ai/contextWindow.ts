// The context window as a setting and as a gauge denominator.
//
// Two facts that used to be conflated:
//
//   * the model's *trained* window — a property of the model, detected once
//     (`ai_context_window`): 128k for llama3.1, 200k for a Claude model;
//   * the window a turn actually *runs in* — for Ollama, the `num_ctx` Rust
//     sizes per request (`adapters::working_num_ctx`): a flat 32k that grows
//     with the conversation up to the trained window, or up to the user's cap.
//
// The gauge divided usage by the first. A 30k conversation in a 32k window
// read as 23% of 128k. Everything here is values in, values out, so the rule
// is testable and the same for the Focus composer, Settings and the panel.

/** Only Ollama exposes a per-request window (`num_ctx`). Every other
 *  provider's window is a fixed property of the model: a hosted API cannot be
 *  asked for a smaller one, and a self-hosted server owns its own. */
export function providerHasContextWindowSetting(provider: string): boolean {
  return provider === "ollama";
}

/** Mirrors `adapters::working_num_ctx` for the moments before a turn has
 *  reported the real number: the window Klide *will* ask for, given the
 *  estimated prompt. Flat default, grow only for large conversations, never
 *  past the ceiling. Keep in step with the Rust constants. */
export const WORKING_WINDOW_DEFAULT = 32_768;
const WORKING_WINDOW_HEADROOM = 4_096;

export function expectedWorkingWindow(estimatedPromptTokens: number, ceiling: number): number {
  const needed = Math.max(0, estimatedPromptTokens) + WORKING_WINDOW_HEADROOM;
  return Math.max(1024, Math.min(ceiling, Math.max(WORKING_WINDOW_DEFAULT, needed)));
}

export type GaugeWindowInput = {
  provider: string;
  /** The trained window detected for this provider+model. */
  detected: number;
  /** The user's cap (Settings → Harness / the Focus picker). Ollama only. */
  override?: number;
  /** What the last settled turn reported it ran in (`usage.contextWindow`).
   *  `null` until a turn has reported one for this conversation. */
  reported: number | null;
  /** Estimated committed prompt tokens, for the pre-turn expectation. */
  estimatedPromptTokens: number;
};

/** The number usage is measured against. */
export function resolveGaugeWindow(input: GaugeWindowInput): number {
  const { provider, detected, override, reported, estimatedPromptTokens } = input;
  if (!providerHasContextWindowSetting(provider)) return detected;
  const ceiling = override && override > 0 ? override : detected;
  if (reported !== null && reported > 0) return reported;
  return expectedWorkingWindow(estimatedPromptTokens, ceiling);
}

/** The cap for Ollama: the override when set, else the trained window. Both
 *  the request's `num_ctx` ceiling and the auto-compaction bound read this. */
export function contextCeiling(detected: number, override?: number): number {
  return override && override > 0 ? override : detected;
}

/** Standard caps a user may pick. `262144` covers the 256k local models. */
const CONTEXT_CAP_SIZES = [8_192, 16_384, 32_768, 65_536, 131_072, 262_144];

export type ContextCapOption = { label: string; value: number | undefined; caption?: string };

/** The cap choices for a model whose trained window is `detected`: Auto, then
 *  every standard size strictly below it. Offering 128k to an 8k model, or
 *  stopping at 128k for a 256k one, were both the old fixed list. */
export function contextCapOptions(detected: number): ContextCapOption[] {
  const auto: ContextCapOption = {
    label: "Auto",
    value: undefined,
    caption:
      detected > 0
        ? `${contextSizeLabel(Math.min(WORKING_WINDOW_DEFAULT, detected))} working window, grows to ${contextSizeLabel(detected)}`
        : "Detected from the model",
  };
  const caps = CONTEXT_CAP_SIZES.filter((size) => detected <= 0 || size < detected).map((size) => ({
    label: contextSizeLabel(size),
    value: size,
  }));
  return [auto, ...caps];
}

/** `131072` → "128K", `200000` → "200K", `1000000` → "1M". Powers of two
 *  divide by 1024; round decimal windows stay decimal so a 200k model does not
 *  read as 195K. */
export function contextSizeLabel(tokens: number): string {
  if (tokens <= 0) return "—";
  if (tokens % 1024 === 0) {
    const k = tokens / 1024;
    return k >= 1024 ? `${k / 1024}M` : `${k}K`;
  }
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`;
  return `${Math.round(tokens / 1000)}K`;
}

/** What the Focus composer shows for the window control: the chosen cap, or
 *  "auto" with the detected size for the label. */
export function contextControlLabel(override: number | undefined, detected: number): string {
  if (override && override > 0) return `${contextSizeLabel(override)} ctx`;
  return detected > 0 ? `${contextSizeLabel(detected)} ctx` : "auto ctx";
}
