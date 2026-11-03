export type CatalogHardware = {
  id: string; name: string; memoryGb: number;
  recipes: {
    id: string; model: string; engine: string; context: number | null;
    decodeTps: number | null; prefillTps: number | null; evidence: string;
    date: string | null; source: string; needs: Record<string, unknown> | null;
  }[];
};
export type LocalModelCatalog = { revision: string; hardware: CatalogHardware[] };

/** Exact chip and memory only. A larger Mac with the same chip is not evidence
 * that the measured launch fits this one. Other hardware is selected explicitly. */
export function matchCatalogHardware(hardware: CatalogHardware[], chip: string, memoryGb: number | null): string {
  if (memoryGb == null) return "";
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return hardware.find((h) => norm(h.name) === norm(chip) && Math.abs(h.memoryGb - memoryGb) < 1)?.id ?? "";
}
