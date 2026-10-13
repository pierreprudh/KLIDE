import { describe, expect, it } from "vitest";
import { harnessModelSourceGroups } from "./harnessModelSources";
import { PROVIDER_GROUPS } from "./providers";

describe("shared harness intelligence catalog", () => {
  it("uses the base picker subscription catalog", () => {
    const groups = harnessModelSourceGroups([]);
    expect(groups.find((g) => g.label === "Subscription")?.items)
      .toEqual(PROVIDER_GROUPS.find((g) => g.label === "Subscription")?.items);
    expect(groups.find((g) => g.label === "API")?.items)
      .toEqual(PROVIDER_GROUPS.find((g) => g.label === "API")?.items);
  });
  it("includes user endpoints and CLI agents without inventing model providers", () => {
    const groups = harnessModelSourceGroups([{ id: "custom:lab", label: "Lab" }], [{ id: "cli:work", label: "Work" }]);
    expect(groups.find((g) => g.label === "Self-hosted")?.items.map((p) => p.id)).toEqual(["custom:lab"]);
    expect(groups.find((g) => g.label === "Subscription")?.items.some((p) => p.id === "cli:work")).toBe(true);
  });
});
