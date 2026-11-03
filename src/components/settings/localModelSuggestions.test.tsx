import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { LlamaSetupInfo } from "../../ipc/aiProviders";
import { localModelSuggestions } from "./localModelSuggestions";
import { LlamaModelCards } from "./llamaModelCards";
import { CommunityModelConfigurations } from "./localModelCatalogBrowser";

const info: LlamaSetupInfo = {
  machine: { chip: "Apple M5", memoryGb: 16, cpuCores: 10, acceleration: "Metal" },
  memoryBudgetGb: 10.4, recommendedModel: "qwen", selectedModel: null, runtimeInstalled: true,
  models: [
    { id: "klide", label: "Klide 8B", maker: "klide", memoryGb: 12.5 },
    { id: "qwen", label: "Qwen3 8B", maker: "qwen", memoryGb: 8 },
    { id: "llama", label: "Llama 3.2 3B", maker: "meta", memoryGb: 4 },
    { id: "ministral", label: "Ministral 3 3B", maker: "mistral", memoryGb: 4.5 },
  ].map((m) => ({ ...m, providerRelease: ["qwen", "mistral"].includes(m.maker), publisher: m.maker, description: "A local model.", downloadGb: 2, quantization: "Q4", url: "https://example.com/model" })),
};
describe("useful local suggestions without community evidence", () => {
  it("offers fitting models first, with the backend recommendation leading", () => {
    const { suggested, larger } = localModelSuggestions(info);
    expect(suggested.map((m) => m.id)).toEqual(["qwen", "ministral"]);
    expect(larger).toEqual([]);
    expect(localModelSuggestions(info).other.map((m) => m.id)).toEqual(["klide"]);
    expect(info.models[0].id).toBe("klide");
  });
  it("offers registry candidates while keeping provenance and unverified status visible", () => {
    const candidate = { ...info.models[1], id: "registry:verified", label: "Qwen3.5 9B", memoryGb: 9.3, registrySource: "https://github.com/example/recipe" };
    const discovered = { ...info, models: [...info.models, candidate] };
    expect(localModelSuggestions(discovered).suggested).toContain(candidate);
    const html = renderToStaticMarkup(<LlamaModelCards info={discovered} value={candidate.id} disabled={false} onChange={() => {}} />);
    expect(html).toContain("9.3 GiB");
    expect(html).toContain("Registry candidate");
    expect(html).toContain("not tested on this Mac");
    expect(html).toContain('checked="" value="registry:verified"');
  });
  it("does not suggest community conversions or infer official status from model names", () => {
    const community = { ...info.models[1], id: "unsloth/Qwen3.5-9B-GGUF", publisher: "unsloth", providerRelease: false, registrySource: "https://example.com/recipe" };
    const suggestions = localModelSuggestions({ ...info, models: [...info.models, community] });
    expect(suggestions.suggested).not.toContain(community);
    expect(suggestions.other).not.toContain(community);
    const selected = { ...info, models: [...info.models, community], selectedModel: community.id };
    const html = renderToStaticMarkup(<LlamaModelCards info={selected} value={community.id} disabled={false} onChange={() => {}} />);
    expect(html).toContain("Published by unsloth · Community conversion");
    expect(html.indexOf("Published by qwen · Provider release")).toBeLessThan(html.indexOf("Community conversion"));
  });
  it("does not invent fit when RAM is unknown", () => {
    const unknown = { ...info, memoryBudgetGb: null };
    expect(localModelSuggestions(unknown).suggested).toHaveLength(2);
    const html = renderToStaticMarkup(<LlamaModelCards info={unknown} value="qwen" disabled={false} onChange={() => {}} />);
    expect(html).toContain("Memory fit unknown");
    expect(html).not.toContain("Estimated to fit");
  });
  it("keeps M5/16 GB choices usable and larger models in a closed disclosure", () => {
    const html = renderToStaticMarkup(<LlamaModelCards info={info} value="qwen" disabled={false} onChange={() => {}} />);
    expect(html).toContain("Models for this computer");
    expect(html).toContain("Estimated to fit");
    expect(html.indexOf("Qwen3 8B")).toBeLessThan(html.indexOf("Klide and previously selected models"));
    expect(html.indexOf("Klide and previously selected models")).toBeLessThan(html.indexOf("Klide 8B"));
    expect(html).not.toMatch(/<details[^>]*\bopen/);
    expect(html).toContain('type="radio"');
  });
  it("keeps an already selected larger model visible and respects a busy setup", () => {
    const html = renderToStaticMarkup(<LlamaModelCards info={info} value="klide" disabled onChange={() => {}} />);
    expect(html).toMatch(/<details[^>]*\bopen/);
    expect(html).toMatch(/<fieldset[^>]*\bdisabled/);
  });
  it("does not replace recommendations with benchmark results from a larger Mac", () => {
    const html = renderToStaticMarkup(<CommunityModelConfigurations
      catalog={{ revision: "pinned", hardware: [{ id: "m5-24", name: "Apple M5", memoryGb: 24, recipes: [] }] }}
      machine={info.machine} hardware="" onHardwareChange={() => {}} />);
    expect(html).toContain("No tested configuration");
    expect(html).toContain("memory estimates");
    expect(html).toContain("Apple M5 · 16 GB RAM");
    expect(html).not.toContain("Catalog revision");
  });
});
