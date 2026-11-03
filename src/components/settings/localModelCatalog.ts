export type CatalogHardware = {
  id: string; name: string; memoryGb: number;
  recipes: {
    id: string; model: string; engine: string; context: number | null;
    decodeTps: number | null; prefillTps: number | null; evidence: string;
    date: string | null; source: string; needs: Record<string, unknown> | null;
  }[];
};
export type LocalModelCatalog = { revision: string; hardware: CatalogHardware[] };
export type CatalogMachine = { chip: string; memoryGb: number | null };
export const THIS_COMPUTER = "this-computer";

export function resolveCatalogHardware(hardware: CatalogHardware[], machine: CatalogMachine | null, choice: string) {
  const match = machine ? matchCatalogHardware(hardware, machine.chip, machine.memoryGb) : "";
  const value = choice === THIS_COMPUTER && !machine ? "" : choice || (machine ? THIS_COMPUTER : "");
  const currentLabel = machine
    ? `This computer · ${machine.chip} · ${machine.memoryGb == null ? "RAM unknown" : `${Math.round(machine.memoryGb)} GB RAM`}`
    : null;
  let message: string;
  if (value === THIS_COMPUTER && machine) {
    message = machine.memoryGb == null
      ? "Your chip was detected, but RAM could not be read. Choose tested hardware to explore its configurations."
      : match
        ? "Matches this computer’s chip and memory. Available memory and other requirements still apply."
        : "No tested configuration for this computer yet. Klide’s model suggestions use memory estimates.";
  } else {
    message = value
      ? "Exploring other hardware. These results do not establish a fit for this computer."
      : "Could not detect this computer’s hardware. Retry detection or choose hardware to explore the catalog.";
  }
  return {
    value,
    currentLabel,
    selected: hardware.find((h) => h.id === (value === THIS_COMPUTER ? match : value)),
    message,
  };
}

/** Exact chip and memory only. A larger Mac with the same chip is not evidence
 * that the measured launch fits this one. Other hardware is selected explicitly. */
export function matchCatalogHardware(hardware: CatalogHardware[], chip: string, memoryGb: number | null): string {
  if (memoryGb == null) return "";
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return hardware.find((h) => norm(h.name) === norm(chip) && Math.abs(h.memoryGb - memoryGb) < 1)?.id ?? "";
}
