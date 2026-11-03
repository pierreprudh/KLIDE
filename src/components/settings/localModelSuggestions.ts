import type { LlamaSetupInfo } from "../../ipc/aiProviders";

/** Memory-fit suggestions are independent of upstream benchmark coverage. */
export function localModelSuggestions(info: LlamaSetupInfo) {
  const ordered = [...info.models].sort((a, b) =>
    Number(b.id === info.recommendedModel) - Number(a.id === info.recommendedModel) || a.memoryGb - b.memoryGb);
  const fits = (memory: number) => info.memoryBudgetGb == null || memory <= info.memoryBudgetGb;
  return {
    suggested: ordered.filter((m) => fits(m.memoryGb)),
    larger: ordered.filter((m) => !fits(m.memoryGb)),
  };
}
