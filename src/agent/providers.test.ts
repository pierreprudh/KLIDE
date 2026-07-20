import { describe, expect, it } from "vitest";
import {
  ALL_PROVIDERS,
  DEFAULT_MODELS,
  PROVIDER_CATALOG,
  PROVIDER_GROUPS,
  defaultModelForProvider,
  isDelegateProvider,
  isManagedLocalProvider,
  isProviderId,
  providerName,
  selectableProviders,
} from "./providers";

describe("Provider catalog", () => {
  it("exposes the wired LM Studio Provider to frontend pickers", () => {
    expect(ALL_PROVIDERS.find((provider) => provider.id === "lmstudio")).toMatchObject({
      name: "LM Studio",
      available: true,
    });
  });

  it("derives picker rows and defaults from one unique row per builtin", () => {
    const ids = PROVIDER_CATALOG.map((provider) => provider.id);
    const groupedIds = PROVIDER_GROUPS.flatMap((group) => group.items.map((item) => item.id));

    expect(new Set(ids).size).toBe(ids.length);
    expect(ALL_PROVIDERS.map((provider) => provider.id)).toEqual(ids);
    expect(groupedIds).toEqual(ids);
    for (const provider of PROVIDER_CATALOG) {
      expect(DEFAULT_MODELS[provider.id]).toBe(provider.defaultModel);
      expect(defaultModelForProvider(provider.id)).toBe(provider.defaultModel);
    }
  });

  it("keeps unavailable and delegate capabilities out of headless race picks", () => {
    const selectable = selectableProviders({ includeDelegates: false });

    expect(selectable.every((provider) => provider.available)).toBe(true);
    expect(selectable.every((provider) => !isDelegateProvider(provider.id))).toBe(true);
    expect(selectable.some((provider) => provider.id === "llamacpp")).toBe(false);
    expect(selectable.some((provider) => provider.id === "gemini")).toBe(false);
  });

  it("classifies only app-managed local servers as managed local", () => {
    expect(isManagedLocalProvider("ollama")).toBe(true);
    expect(isManagedLocalProvider("mlx")).toBe(true);
    expect(isManagedLocalProvider("lmstudio")).toBe(false);
    expect(isManagedLocalProvider("openai")).toBe(false);
  });

  it("recognises persisted custom providers and custom CLIs", () => {
    expect(isProviderId("custom:gateway")).toBe(true);
    expect(isProviderId("cli:cursor-agent")).toBe(true);
    expect(isProviderId("not-a-provider")).toBe(false);
  });

  it("does not silently label an unknown provider as Ollama", () => {
    expect(providerName("not-a-provider" as never)).toBe("Unknown Provider");
  });
});
