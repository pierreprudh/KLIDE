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

type LogoProps = { size?: number };

function ImgLogo({ src, themeClass, size }: { src: string; themeClass: string; size: number }) {
  return (
    <img
      className={themeClass}
      src={src}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      style={{ width: size, height: size, objectFit: "contain", flexShrink: 0 }}
    />
  );
}

// LiquidAI's mark is solid black on transparent → invert to white on dark.
export function LiquidAiLogo({ size = 14 }: LogoProps) {
  return <ImgLogo src="/liquidai-logo.png" themeClass="provider-logo-img" size={size} />;
}

// Qwen's mark is purple — keep its colour in both themes.
export function QwenLogo({ size = 14 }: LogoProps) {
  return <ImgLogo src="/qwen-logo.png" themeClass="color-logo-img" size={size} />;
}

// The 🤗 face is full colour — never invert.
export function HuggingFaceLogo({ size = 14 }: LogoProps) {
  return <ImgLogo src="/huggingface-logo.png" themeClass="color-logo-img" size={size} />;
}

// Mistral's orange mark — keep colour.
export function MistralLogo({ size = 14 }: LogoProps) {
  return <ImgLogo src="/mistral-logo.png" themeClass="color-logo-img" size={size} />;
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
  { pattern: /mistral|mixtral|codestral|ministral|magistral|devstral/i, brand: { name: "Mistral AI", href: "https://mistral.ai/", Logo: MistralLogo } },
];

// Resolve a model name to its maker brand + a homepage link. Models pulled
// from Hugging Face (`hf.co/<org>/<repo>`) whose maker isn't otherwise
// recognised fall back to the Hugging Face mark, linking to the repo page.
export function modelBrand(model: string | null | undefined): ModelBrand | null {
  if (!model) return null;
  const hit = BRAND_RULES.find((r) => r.pattern.test(model));
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
