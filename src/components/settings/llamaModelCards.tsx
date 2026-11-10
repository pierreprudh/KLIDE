import { CheckIcon, KlideMark } from "../ai/icons";
import { HuggingFaceLogo, LiquidAiLogo, LlamaLogo, MistralLogo, QwenLogo } from "../../modelBrand";
import type { LlamaSetupInfo } from "../../ipc/aiProviders";
import { useId } from "react";
import { localModelSuggestions } from "./localModelSuggestions";

type Props = {
  info: LlamaSetupInfo;
  value: string;
  disabled: boolean;
  onChange: (model: string) => void;
};

export function LlamaModelCards({ info, value, disabled, onChange }: Props) {
  const name = useId();
  const { suggested, larger, other } = localModelSuggestions(info);
  function card(model: LlamaSetupInfo["models"][number]) {
    const selected = model.id === value;
    const fits = info.memoryBudgetGb == null ? null : model.memoryGb <= info.memoryBudgetGb;
    const Logo = model.maker === "klide" ? KlideMark : model.maker === "qwen" ? QwenLogo : model.maker === "meta" ? LlamaLogo : model.maker === "mistral" ? MistralLogo : model.maker === "liquid" ? LiquidAiLogo : HuggingFaceLogo;
    return <article key={model.id} className="klide-llama-card" data-selected={selected}>
      <label className="klide-llama-card-choice">
        <input type="radio" name={name} value={model.id} checked={selected} onChange={() => onChange(model.id)} />
        <div className="klide-llama-card-heading">
          <span aria-hidden="true" className="klide-llama-card-art"><Logo size={28} /></span>
          <span className="klide-llama-card-title">{model.label}</span>
          <span className="klide-llama-card-selected" aria-hidden="true">{selected && <CheckIcon />}</span>
        </div>
        <span className="klide-llama-hint">{model.providerRelease ? `Published by ${model.publisher} · Provider release` : model.maker === "klide" ? "Published by Klide · Klide model" : `Published by ${model.publisher ?? "unknown publisher"} · Community conversion`}</span>
        <span className="klide-llama-card-description">{model.description}</span>
        <dl className="klide-llama-card-stats">
          <div><dt>Memory estimate</dt><dd>{model.memoryGb.toFixed(1)} GiB</dd></div>
          <div><dt>Download</dt><dd>{model.downloadGb.toFixed(2)} GB</dd></div>
        </dl>
        <span className="klide-llama-card-fit">{fits === null ? "Memory fit unknown" : fits ? "Estimated to fit" : "Above this computer’s memory budget"} · {model.quantization}</span>
      </label>
      {model.registrySource && <p className="klide-llama-hint">Registry candidate · 16k estimate · not tested on this Mac. <a className="klide-community-source" href={model.registrySource} target="_blank" rel="noreferrer">Source recipe</a></p>}
      <div className="klide-llama-card-footer">
        <a href={model.url} target="_blank" rel="noreferrer">Model details</a>
        {model.id === info.recommendedModel && <span className="klide-llama-recommended">Recommended</span>}
      </div>
    </article>;
  }
  return <fieldset className="klide-llama-models" disabled={disabled}>
    <legend className="klide-llama-label">Models for this computer</legend>
    <p className="klide-llama-hint klide-llama-model-intro">{info.memoryBudgetGb == null
      ? "Memory fit is unknown. Choose a small model to start."
      : `Memory estimates use a 16k context and a ${info.memoryBudgetGb.toFixed(1)} GiB model budget.`} Provider releases are shown first. Coding performance has not been verified.</p>
    <div className="klide-llama-card-grid">
      {suggested.map(card)}
    </div>
    {suggested.length === 0 && <p className="klide-llama-hint">No provider release fits the estimated budget. You can use a self-hosted endpoint or explore the larger models below.</p>}
    {larger.length > 0 && <details className="klide-llama-details klide-llama-larger" open={larger.some((m) => m.id === value) || undefined}>
      <summary>Models needing more memory ({larger.length})</summary>
      <div className="klide-llama-card-grid">{larger.map(card)}</div>
    </details>}
    {other.length > 0 && <details className="klide-llama-details klide-llama-larger" open={other.some((m) => m.id === value) || undefined}>
      <summary>Klide and previously selected models ({other.length})</summary>
      <div className="klide-llama-card-grid">{other.map(card)}</div>
    </details>}
  </fieldset>;
}
