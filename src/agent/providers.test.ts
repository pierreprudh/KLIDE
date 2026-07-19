import { describe, expect, it } from "vitest";
import { ALL_PROVIDERS } from "./providers";

describe("Provider catalog", () => {
  it("exposes the wired LM Studio Provider to frontend pickers", () => {
    expect(ALL_PROVIDERS.find((provider) => provider.id === "lmstudio")).toMatchObject({
      name: "LM Studio",
      available: true,
    });
  });
});
