import { CheckIcon, KlideMark } from "../ai/icons";
import { LlamaLogo, MistralLogo, QwenLogo } from "../../modelBrand";
import type { LlamaSetupInfo } from "../../ipc/aiProviders";

type Props = {
  info: LlamaSetupInfo;
  value: string;
  disabled: boolean;
  onChange: (model: string) => void;
};

export function LlamaModelCards({ info, value, disabled, onChange }: Props) {
  return <fieldset className="klide-llama-models" disabled={disabled}>
    <legend className="klide-llama-label">Choose a model</legend>
    <div className="klide-llama-card-grid">
      {info.models.map((model) => {
        const selected = model.id === value;
        const fits = info.memoryBudgetGb == null ? null : model.memoryGb <= info.memoryBudgetGb;
        const Logo = model.maker === "klide" ? KlideMark : model.maker === "qwen" ? QwenLogo : model.maker === "meta" ? LlamaLogo : MistralLogo;
        return <article key={model.id} className="klide-llama-card" data-selected={selected}>
          <label className="klide-llama-card-choice">
            <input type="radio" name="llamacpp-model" value={model.id} checked={selected}
              onChange={() => onChange(model.id)} />
            <div className="klide-llama-card-art" aria-hidden="true"><Logo size={48} /></div>
            <div className="klide-llama-card-content">
              <div className="klide-llama-card-badges">
                {model.maker === "klide" && <span>Klide default</span>}
                {model.id === info.recommendedModel && <span>Recommended</span>}
              </div>
              <span className="klide-llama-card-title">{model.label}</span>
              <span className="klide-llama-card-description">{model.description}</span>
              <dl className="klide-llama-card-stats">
                <div><dt>Download</dt><dd>{model.downloadGb} GB</dd></div>
                <div><dt>Memory</dt><dd>~{model.memoryGb} GB</dd></div>
              </dl>
              <span className="klide-llama-card-fit">{fits === null ? "Memory fit unknown" : fits ? "Fits memory budget" : "Needs more memory"} · {model.quantization}</span>
            </div>
          </label>
          <div className="klide-llama-card-footer">
            <a href={model.url} target="_blank" rel="noreferrer">{model.maker === "klide" ? "Klide model" : "Model details"}</a>
            <span className="klide-llama-card-selected" aria-hidden="true">{selected && <CheckIcon />}</span>
          </div>
        </article>;
      })}
    </div>
  </fieldset>;
}
