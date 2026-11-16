import { describe, expect, it } from "vitest";
import { harnessModelSourceGroups, intelligenceSourceGroups } from "./harnessModelSources";
import { PROVIDER_GROUPS } from "./providers";

describe("shared harness intelligence catalog", () => {
  it("uses the base picker subscription catalog", () => {
    const groups = harnessModelSourceGroups([]);
    expect(groups.find((g) => g.label === "Subscription")?.items)
      .toEqual(PROVIDER_GROUPS.find((g) => g.label === "Subscription")?.items);
    expect(groups.find((g) => g.label === "API")?.items)
      .toEqual(PROVIDER_GROUPS.find((g) => g.label === "API")?.items);
  });
  it("includes user endpoints without inventing model providers", () => {
    const groups = harnessModelSourceGroups([{ id: "custom:lab", label: "Lab" }]);
    expect(groups.find((g) => g.label === "Self-hosted")?.items.map((p) => p.id)).toEqual(["custom:lab"]);
  });
  it("never offers a user CLI agent (a harness, often a Remote shell) as a source", () => {
    const ids = harnessModelSourceGroups([]).flatMap((g) => g.items.map((p) => String(p.id)));
    expect(ids.some((id) => id.startsWith("cli:"))).toBe(false);
  });
});

describe("subscription intelligence sources", () => {
  it("adds Nous as an inference source while preserving the existing CLI catalog", () => {
    const subscriptions = intelligenceSourceGroups([]).find((g) => g.label === "Subscription")!.items;
    expect(subscriptions.some((p) => p.id === "claude-code")).toBe(true);
    expect(subscriptions.filter((p) => String(p.id) === "hermes-subscription:nous").map((p) => p.name)).toEqual(["Nous Portal"]);
  });
});
