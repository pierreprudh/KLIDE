import { describe, it, expect } from "vitest";
import { matchCatalogHardware } from "./localModelCatalog";
describe("catalog hardware matching", () => {
  const hardware = [{ id: "m2-96", name: "Apple M2 Max", memoryGb: 96, recipes: [] }];
  it("matches the exact chip and memory", () => expect(matchCatalogHardware(hardware, "Apple M2 Max", 96)).toBe("m2-96"));
  it("does not confuse smaller RAM or a different chip with measured hardware", () => {
    expect(matchCatalogHardware(hardware, "Apple M2 Max", 32)).toBe("");
    expect(matchCatalogHardware(hardware, "Apple M2", 96)).toBe("");
    expect(matchCatalogHardware(hardware, "Apple M2 Max", null)).toBe("");
  });
});
