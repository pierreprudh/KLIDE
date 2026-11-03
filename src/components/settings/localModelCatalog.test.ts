import { describe, it, expect } from "vitest";
import { matchCatalogHardware, resolveCatalogHardware, THIS_COMPUTER } from "./localModelCatalog";
describe("catalog hardware matching", () => {
  const hardware = [{ id: "m2-96", name: "Apple M2 Max", memoryGb: 96, recipes: [] }];
  it("matches the exact chip and memory", () => expect(matchCatalogHardware(hardware, "Apple M2 Max", 96)).toBe("m2-96"));
  it("does not confuse smaller RAM or a different chip with measured hardware", () => {
    expect(matchCatalogHardware(hardware, "Apple M2 Max", 32)).toBe("");
    expect(matchCatalogHardware(hardware, "Apple M2", 96)).toBe("");
    expect(matchCatalogHardware(hardware, "Apple M2 Max", null)).toBe("");
  });
});

describe("detected computer in the catalog browser", () => {
  // The pinned registry has M5 24/32 GB configurations, but no M5 16 GB.
  const hardware = [
    { id: "apple-m5-24gb", name: "Apple M5", memoryGb: 24, recipes: [] },
    { id: "apple-m5-32gb", name: "Apple M5", memoryGb: 32, recipes: [] },
  ];
  it("shows this M5 16 GB computer even without an exact tested configuration", () => {
    const view = resolveCatalogHardware(hardware, { chip: "Apple M5", memoryGb: 16 }, "");
    expect(view.value).toBe(THIS_COMPUTER);
    expect(view.currentLabel).toContain("Apple M5 · 16 GB RAM");
    expect(view.selected).toBeUndefined();
    expect(view.message).toContain("No tested configuration");
    expect(view.message).not.toContain("Could not detect");
  });
  it("shows exact-match recipes when this machine has a catalog entry", () => {
    const view = resolveCatalogHardware(hardware, { chip: "Apple M5", memoryGb: 24 }, "");
    expect(view.value).toBe(THIS_COMPUTER);
    expect(view.selected?.id).toBe("apple-m5-24gb");
  });
  it("distinguishes browsing a larger machine from a fit recommendation", () => {
    const view = resolveCatalogHardware(hardware, { chip: "Apple M5", memoryGb: 16 }, "apple-m5-32gb");
    expect(view.selected?.id).toBe("apple-m5-32gb");
    expect(view.message).toContain("other hardware");
  });
  it("distinguishes failed detection from missing memory and a missing catalog entry", () => {
    const failed = resolveCatalogHardware(hardware, null, "");
    expect(failed.currentLabel).toBeNull();
    expect(failed.message).toContain("Could not detect");
    const unknownMemory = resolveCatalogHardware(hardware, { chip: "Apple M5", memoryGb: null }, "");
    expect(unknownMemory.currentLabel).toContain("RAM unknown");
    expect(unknownMemory.message).toContain("RAM could not be read");
  });
});
