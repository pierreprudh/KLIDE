import type { CSSProperties, ReactElement } from "react";
import {
  DeepSeekLogo,
  LiquidAiLogo,
  LlamaLogo,
  MistralLogo,
  QwenLogo,
  modelBrand,
} from "./modelBrand";
import { BrandImage, ProviderLogo, TwoToneMark } from "./components/ai/icons";
import { isDelegateProvider, providerDefinition, providerName } from "./agent/providers";
import type { ProviderId } from "./agent/types";

type LogoProps = { size?: number };
type LogoComponent = (props: LogoProps) => ReactElement;

export type ModelIdentity = {
  name: string;
  Logo: LogoComponent;
};

function MiniMaxLogo({ size = 14 }: LogoProps) {
  return <BrandImage src="/minimax-logo.png" size={size} />;
}

function KimiLogo({ size = 14 }: LogoProps) {
  return <TwoToneMark light="/kimi-logo-light.svg" dark="/kimi-logo-dark.svg" size={size} />;
}

function ZaiLogo({ size = 14 }: LogoProps) {
  return <BrandImage className="white-logo-img" src="/zai-logo.png" size={size} />;
}

function AnthropicLogo({ size = 14 }: LogoProps) {
  return <ProviderLogo id="anthropic" size={size} />;
}

function CodexLogo({ size = 14 }: LogoProps) {
  return <ProviderLogo id="codex" size={size} />;
}

function OpenAiLogo({ size = 14 }: LogoProps) {
  return <ProviderLogo id="openai" size={size} />;
}

function GoogleLogo({ size = 14 }: LogoProps) {
  return <ProviderLogo id="gemini" size={size} />;
}

function XaiLogo({ size = 14 }: LogoProps) {
  return <ProviderLogo id="xai" size={size} />;
}

const MINIMAX: ModelIdentity = { name: "MiniMax", Logo: MiniMaxLogo };
const KIMI: ModelIdentity = { name: "Kimi", Logo: KimiLogo };
const ANTHROPIC: ModelIdentity = { name: "Anthropic", Logo: AnthropicLogo };
const OPENAI: ModelIdentity = { name: "OpenAI", Logo: OpenAiLogo };
const ZAI: ModelIdentity = { name: "Z.AI", Logo: ZaiLogo };
const GOOGLE: ModelIdentity = { name: "Google", Logo: GoogleLogo };
const XAI: ModelIdentity = { name: "xAI", Logo: XaiLogo };
const DEEPSEEK: ModelIdentity = { name: "DeepSeek", Logo: DeepSeekLogo };
const QWEN: ModelIdentity = { name: "Qwen", Logo: QwenLogo };
const MISTRAL: ModelIdentity = { name: "Mistral AI", Logo: MistralLogo };
const LLAMA: ModelIdentity = { name: "Llama", Logo: LlamaLogo };
const LIQUID_AI: ModelIdentity = { name: "LiquidAI", Logo: LiquidAiLogo };

const MODEL_IDENTITY_RULES: { pattern: RegExp; identity: ModelIdentity }[] = [
  { pattern: /minimax/i, identity: MINIMAX },
  { pattern: /kimi|moonshot/i, identity: KIMI },
  { pattern: /claude|sonnet|opus|haiku/i, identity: ANTHROPIC },
  { pattern: /codex/i, identity: { name: "Codex", Logo: CodexLogo } },
  { pattern: /(?:^|\/)gpt-|(?:^|\/)o[134](?:\b|-)/i, identity: OPENAI },
  { pattern: /glm|z-?ai/i, identity: ZAI },
  { pattern: /gemini|gemma/i, identity: GOOGLE },
  { pattern: /grok/i, identity: XAI },
];

/**
 * The maker named by a namespaced model id's *vendor* segment.
 *
 * A gateway id says who made the model before it says which one: OpenRouter
 * serves `openai/chatgpt-4o-latest` and `anthropic/claude-next`, and the rules
 * above — which read the model half — see nothing in either. That is how a
 * conversation ended up wearing no mark at all: the maker was written down, in
 * the half nothing was reading.
 *
 * An allowlist, not a heuristic, so an unrecognised org (`nousresearch/…`) or a
 * local namespace (`mlx-community/…`, `pierreprudh/…`) still resolves to
 * nothing here and falls through to the runner's own mark. `openrouter` is
 * deliberately absent: it routes models, it does not make them, so
 * `openrouter/auto` has no maker to name.
 */
const MAKER_BY_VENDOR: Record<string, ModelIdentity> = {
  openai: OPENAI,
  anthropic: ANTHROPIC,
  google: GOOGLE,
  "google-vertex": GOOGLE,
  xai: XAI,
  "x-ai": XAI,
  moonshot: KIMI,
  moonshotai: KIMI,
  zai: ZAI,
  "z-ai": ZAI,
  minimax: MINIMAX,
  minimaxai: MINIMAX,
  deepseek: DEEPSEEK,
  "deepseek-ai": DEEPSEEK,
  qwen: QWEN,
  alibaba: QWEN,
  mistral: MISTRAL,
  mistralai: MISTRAL,
  meta: LLAMA,
  "meta-llama": LLAMA,
  liquid: LIQUID_AI,
  liquidai: LIQUID_AI,
};

/** The vendor segment of a namespaced id, or null for a bare model name. The
 *  leading punctuation strip is for OpenRouter's variant prefixes (a saved id
 *  can read `~deepseek/deepseek-v4-flash-latest`). */
function vendorSegment(model: string): string | null {
  if (!model.includes("/")) return null;
  const vendor = model.split("/")[0].replace(/^[^a-z0-9]+/i, "").toLowerCase();
  return vendor || null;
}

const NON_MODEL_LABEL = /^(auto|default|none|null|unknown)$/i;

/**
 * Resolve only identities that can be inferred confidently from the saved
 * model id — its own text, in three passes: a maker brand, then the model-name
 * rules, then the vendor segment of a namespaced id.
 *
 * This deliberately has no provider/runtime fallback: an unknown Ollama, MLX,
 * OpenRouter, or custom model stays unbranded *here*, and callers that want the
 * runner's mark as a floor ask `conversationMark` for it.
 */
export function modelIdentity(model: string | null | undefined): ModelIdentity | null {
  const normalized = model?.trim();
  if (!normalized || NON_MODEL_LABEL.test(normalized)) return null;

  const brand = modelBrand(normalized);
  if (brand) return { name: brand.name, Logo: brand.Logo };

  const byModel = MODEL_IDENTITY_RULES.find(({ pattern }) => pattern.test(normalized))?.identity;
  if (byModel) return byModel;

  // Last, and only for a namespaced id: the vendor segment. The model half is
  // the more specific evidence, so it is read first — `nvidia/llama-3.3-…` is a
  // Llama, not an unknown.
  const vendor = vendorSegment(normalized);
  return (vendor ? MAKER_BY_VENDOR[vendor] : undefined) ?? null;
}

/** On-device families with no maker mark of their own. They still ran locally,
 *  so the local-runtime glyph is the honest answer — better than the generic
 *  fallback, which reads as "unknown model". */
const LOCAL_FAMILY_WITHOUT_MARK = /phi-?\d|nomic|mxbai|granite|smollm|starcoder/i;

export function resolveModelLogo(
  model: string | null | undefined,
  size = 14,
): ReactElement | null {
  const identity = modelIdentity(model);
  if (identity) {
    const Logo = identity.Logo;
    return <Logo size={size} />;
  }
  // Mission Control used to add this arm in a local function *also* called
  // `resolveModelLogo`, importing this one aliased as `resolveKnownModelLogo` to
  // make room — two names for one concept in one file. The arm belongs here,
  // with the rest of model → mark.
  if (model && LOCAL_FAMILY_WITHOUT_MARK.test(model)) {
    return <ProviderLogo id="ollama" size={size} />;
  }
  return null;
}

/* ─────────────────────── provider + model, as one mark ───────────────────── */

/** The pair splits one slot between two marks, so below this neither half is
 *  legible and one of them has to stand alone — `soloMark` decides which. */
const PAIR_MIN_SIZE = 22;

/**
 * Delegates whose whole catalogue is one house. For these the maker is a fact
 * about the *CLI*, not only about the model id: Claude Code cannot run
 * anything but Anthropic's models, and Codex cannot run anything but OpenAI's.
 *
 * Which matters because `default` — "no --model flag, let the CLI choose" — is
 * a perfectly ordinary way to run one, and it names no model. Without this the
 * same agent drew a pair on a turn that pinned a model and a lone runner on the
 * turn beside it that didn't, as though something about the run had changed.
 *
 * OpenCode and Oh My Pi are deliberately absent: their catalogues are other
 * makers' models, so with no model id there is nothing true to draw.
 */
const DELEGATE_HOUSE: Partial<Record<ProviderId, ProviderId>> = {
  "claude-code": "anthropic",
  codex: "openai",
};

/**
 * The one mark to draw when the pair doesn't fit — or when there is no maker to
 * pair with.
 *
 * A delegate whose catalogue is one house names its maker by naming itself, so
 * the CLI leads and nothing is lost. A delegate that runs *other* makers'
 * models is the opposite case: its own mark says where the run lives and
 * nothing about what replied, and in a rail the runner is already written above
 * the row as the group it sits in. So there the maker leads when the saved id
 * names one, and the CLI is the floor — "an OpenCode thread, on something" is
 * still the honest answer for `default`.
 *
 * Everything else keeps the runner — a hosted provider's small mark is about
 * where the run lives, and an unbranded model gives nothing to swap it for.
 */
function soloMark(
  provider: ProviderId,
  model: string | null | undefined,
  size: number,
): ReactElement {
  if (isDelegateProvider(provider) && !DELEGATE_HOUSE[provider]) {
    const maker = resolveModelLogo(model, size);
    if (maker) return maker;
  }
  return <ProviderLogo id={provider} size={size} />;
}

/** The maker's share of the box; the rest goes to the runner. */
const MAKER_SHARE = 0.46;

/** How much of the maker rides *over* the runner's corner. Corner-to-corner the
 *  two boxes would only touch at a point, and every mark keeps padding inside
 *  its own box, so a pair that merely abuts reads as two strays with a hole
 *  between them. The maker tucks into the runner instead — and nothing is drawn
 *  around it to make the tuck work: no disc, no ring, no tile. */
const OVERLAP = 0.35;

/**
 * A conversation's runner and its model drawn as one mark.
 *
 * "An OpenCode conversation" and "…on Kimi" are two different facts, and every
 * surface that shows one of these used to pick a side and drop the other:
 * Focus's resume cards showed only the CLI, Mission Control's conversation
 * avatar only the model. So the same run read differently depending on where
 * you looked at it — and for a delegate whose whole catalogue is other makers'
 * models, the CLI-only answer says nothing about what actually replied.
 *
 * The runner leads from the top-left and the maker tucks over its bottom-right
 * corner, bare — a disc-and-hairline cut-out under the small mark would read as
 * the chrome this app doesn't wear, so the overlap carries itself.
 *
 * `size` is the *total* footprint, so a caller's geometry is the same whether
 * the model names a maker or not — an unbranded model simply leaves the
 * provider mark alone, which is still the honest answer.
 */
export function ProviderModelMark({
  provider,
  model,
  size = 24,
}: {
  provider: ProviderId;
  model?: string | null;
  size?: number;
}): ReactElement {
  const makerSize = Math.round(size * MAKER_SHARE);
  const house = DELEGATE_HOUSE[provider];
  const maker =
    resolveModelLogo(model, makerSize) ??
    (house ? <ProviderLogo id={house} size={makerSize} /> : null);
  if (size < PAIR_MIN_SIZE || !maker) return soloMark(provider, model, size);

  const runnerSize = size - makerSize + Math.round(makerSize * OVERLAP);
  const corner: CSSProperties = { position: "absolute", display: "grid", placeItems: "center" };
  return (
    <span
      style={{
        position: "relative",
        display: "inline-block",
        width: size,
        height: size,
        flexShrink: 0,
      }}
    >
      <span style={{ ...corner, top: 0, left: 0, width: runnerSize, height: runnerSize }}>
        <ProviderLogo id={provider} size={runnerSize} />
      </span>
      <span style={{ ...corner, right: 0, bottom: 0, width: makerSize, height: makerSize }}>
        {maker}
      </span>
    </span>
  );
}

/* ───────────────────── what ran a conversation, as one mark ───────────────── */

export type ConversationMark = { node: ReactElement; label: string };

/**
 * The mark for a stored conversation, in the order that answers "what ran
 * this" honestly:
 *
 * 1. A delegate (or a user CLI) — the CLI *is* the identity, and it leads: what
 *    you resumed was "a Claude Code conversation", not "a Sonnet one". When the
 *    saved id also names a maker, that maker rides as a satellite
 *    (`ProviderModelMark`) — OpenCode's whole catalogue is other makers'
 *    models, so the CLI mark alone leaves half the row unsaid.
 * 2. The model's maker, when the saved model id names one confidently.
 * 3. The provider that hosted it — an OpenRouter slug whose vendor this app
 *    doesn't recognise, an unbranded local pull, a self-hosted endpoint: the
 *    thread still ran *somewhere*, and that somewhere has a mark.
 *
 * `null` means neither is known — a conversation saved before the provider was
 * recorded. Callers decide what an unknown runner looks like; the Focus home
 * card and the harness chat wear Klide's own mark, the rail stays quiet.
 *
 * Step 1's precedence deliberately lives here rather than in `modelIdentity`:
 * an unknown Ollama or custom model must stay unbranded *there*, and that rule
 * is the whole point of that function.
 */
export function conversationMark(
  model: string | null | undefined,
  provider: ProviderId | null | undefined,
  size = 24,
): ConversationMark | null {
  if (provider && isDelegateProvider(provider)) {
    const house = DELEGATE_HOUSE[provider];
    const maker =
      modelIdentity(model)?.name ?? (house ? providerName(house) : undefined);
    return {
      node: <ProviderModelMark provider={provider} model={model} size={size} />,
      label: maker ? `${providerName(provider)} · ${maker}` : providerName(provider),
    };
  }
  const modelLogo = resolveModelLogo(model, size);
  if (modelLogo) {
    return { node: modelLogo, label: modelIdentity(model)?.name ?? "Local model" };
  }
  if (provider && providerDefinition(provider)) {
    return { node: <ProviderLogo id={provider} size={size} />, label: providerName(provider) };
  }
  return null;
}
