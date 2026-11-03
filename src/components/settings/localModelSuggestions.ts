import type { LlamaSetupInfo } from "../../ipc/aiProviders";

/** Default suggestions are provider-published weights, independently of fit. */
export function localModelSuggestions(info: LlamaSetupInfo) {
  const ordered = [...info.models].sort((a, b) =>
    Number(b.id === info.recommendedModel) - Number(a.id === info.recommendedModel) || a.memoryGb - b.memoryGb);
  const fits = (memory: number) => info.memoryBudgetGb == null || memory <= info.memoryBudgetGb;
  return {
    suggested: ordered.filter((m) => m.providerRelease === true && fits(m.memoryGb)),
    larger: ordered.filter((m) => m.providerRelease === true && !fits(m.memoryGb)),
    other: ordered.filter((m) => m.providerRelease !== true && (m.maker === "klide" || m.id === info.selectedModel)),
  };
}
