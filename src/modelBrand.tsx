// Single source of truth for mapping a model name → its maker's brand mark
// and homepage. Used by Mission Control (run avatars) and the AI panel
// (clickable maker link by the model selector).
//
// Most marks are official logo images in /public. The theme class controls
// dark-mode behaviour: `color-logo-img` keeps brand colour untouched;
// `provider-logo-img` is a dark mark that inverts to white on dark themes
// (see tokens.css). Llama has no supplied asset, so it stays an inline
// `currentColor` glyph.

import type { ReactElement } from "react";
import { BrandImage } from "./components/ai/icons";

type LogoProps = { size?: number };

function ImgLogo({ src, themeClass, size }: { src: string; themeClass: string; size: number }) {
  return <BrandImage className={themeClass} src={src} size={size} />;
}

// LiquidAI's mark is solid black on transparent → invert to white on dark.
export function LiquidAiLogo({ size = 14 }: LogoProps) {
  return <ImgLogo src="/liquidai-logo.png" themeClass="provider-logo-img" size={size} />;
}

// Qwen's mark is brand blue — keep its colour in both themes.
export function QwenLogo({ size = 14 }: LogoProps) {
  return <ImgLogo src="/qwen-logo.png" themeClass="color-logo-img" size={size} />;
}

// The 🤗 face is full colour — never invert.
export function HuggingFaceLogo({ size = 14 }: LogoProps) {
  return <ImgLogo src="/huggingface-logo.png" themeClass="color-logo-img" size={size} />;
}

// Mistral's pixel M (yellow→red gradient) — keep colour.
export function MistralLogo({ size = 14 }: LogoProps) {
  return <ImgLogo src="/mistral-logo.png" themeClass="color-logo-img" size={size} />;
}

// Mistral gives each model family its own pixel-art icon (mistral.ai/brand).
// Ordered — `codestral-embed` before `codestral`, `embed` after both. A
// Mistral model no row names falls back to the M.
const MISTRAL_FAMILY_ICONS: [RegExp, string][] = [
  [/codestral-embed/i, "codestral-embed"],
  [/codestral/i, "codestral"],
  [/devstral/i, "devstral"],
  [/magistral/i, "magistral"],
  [/ministral/i, "ministral"],
  [/pixtral/i, "pixtral"],
  [/voxtral/i, "voxtral"],
  [/leanstral/i, "leanstral"],
  [/mistral-ocr|(?:^|[-/])ocr/i, "ocr"],
  [/moderation/i, "moderation"],
  [/mistral-embed|(?:^|[-/])embed/i, "embed"],
  [/mistral-large/i, "large"],
  [/mistral-medium/i, "medium"],
  [/mistral-small/i, "small"],
  [/mistral-7b|open-mistral(?!-nemo)/i, "mistral-7b"],
];

// One component per icon, made once — a fresh function per call would be a new
// component type on every render and remount the <img>.
const mistralFamilyLogos = new Map<string, (props: LogoProps) => ReactElement>();

function mistralModelLogo(model: string): (props: LogoProps) => ReactElement {
  const icon = MISTRAL_FAMILY_ICONS.find(([pattern]) => pattern.test(model))?.[1];
  if (!icon) return MistralLogo;
  let Logo = mistralFamilyLogos.get(icon);
  if (!Logo) {
    Logo = function MistralModelLogo({ size = 14 }: LogoProps) {
      return <ImgLogo src={`/mistral-models/${icon}.svg`} themeClass="color-logo-img" size={size} />;
    };
    mistralFamilyLogos.set(icon, Logo);
  }
  return Logo;
}

// DeepSeek's whale is brand blue — keep colour.
export function DeepSeekLogo({ size = 14 }: LogoProps) {
  return <ImgLogo src="/deepseek-logo.png" themeClass="color-logo-img" size={size} />;
}

// Sakana AI's mark is brand red (#E10600) — keep its colour in both themes.
export function SakanaLogo({ size = 14 }: LogoProps) {
  return <ImgLogo src="/sakana-logo.svg" themeClass="color-logo-img" size={size} />;
}

// Llama models are Meta's — wear the Meta infinity mark (blue, keep colour).
export function LlamaLogo({ size = 14 }: LogoProps) {
  return <ImgLogo src="/meta-logo.png" themeClass="color-logo-img" size={size} />;
}

export type ModelBrand = {
  name: string;
  href: string;
  Logo: (props: LogoProps) => ReactElement;
};

// Ordered — first match wins, so specific makers come before generic ones.
const BRAND_RULES: { pattern: RegExp; brand: ModelBrand }[] = [
  { pattern: /lfm|liquid/i, brand: { name: "LiquidAI", href: "https://www.liquid.ai/", Logo: LiquidAiLogo } },
  { pattern: /qwen/i, brand: { name: "Qwen", href: "https://qwen.ai/", Logo: QwenLogo } },
  { pattern: /llama/i, brand: { name: "Llama", href: "https://www.llama.com/", Logo: LlamaLogo } },
  { pattern: /mistral|mixtral|codestral|ministral|magistral|devstral|pixtral|voxtral|leanstral/i, brand: { name: "Mistral AI", href: "https://mistral.ai/", Logo: MistralLogo } },
  // Covers the hosted ids (deepseek-chat / deepseek-reasoner), the Ollama pulls
  // (deepseek-r1:8b, deepseek-coder:6.7b) and OpenRouter's `deepseek/…` slugs.
  { pattern: /deepseek/i, brand: { name: "DeepSeek", href: "https://www.deepseek.com/", Logo: DeepSeekLogo } },
  // OpenRouter serves these as `sakana/<model>`, and the model half names no
  // maker (`fugu-ultra`) — the vendor segment is the whole evidence, and a
  // substring rule reads it without a second table.
  { pattern: /sakana/i, brand: { name: "Sakana AI", href: "https://sakana.ai/", Logo: SakanaLogo } },
];

// Resolve a model name to its maker brand + a homepage link. Models pulled
// from Hugging Face (`hf.co/<org>/<repo>`) whose maker isn't otherwise
// recognised fall back to the Hugging Face mark, linking to the repo page.
export function modelBrand(model: string | null | undefined): ModelBrand | null {
  if (!model) return null;
  const hit = BRAND_RULES.find((r) => r.pattern.test(model));
  if (hit?.brand.Logo === MistralLogo) return { ...hit.brand, Logo: mistralModelLogo(model) };
  if (hit) return hit.brand;
  if (/^hf\.co\//i.test(model) || /huggingface/i.test(model)) {
    const repo = model.replace(/^hf\.co\//i, "").split(":")[0];
    return {
      name: "Hugging Face",
      href: repo ? `https://huggingface.co/${repo}` : "https://huggingface.co/",
      Logo: HuggingFaceLogo,
    };
  }
  return null;
}
