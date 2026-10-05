import { describe, expect, it } from "vitest";
import {
  ALL_PROVIDERS,
  AUTO_PROVIDER,
  CLI_DEFAULT_MODEL,
  DEFAULT_MODELS,
  PROVIDER_CATALOG,
  PROVIDER_GROUPS,
  defaultModelForProvider,
  isDelegateProvider,
  isManagedLocalProvider,
  isKnownProvider,
  isProviderId,
  providerName,
  providerShortName,
  selectableProviders,
} from "./providers";
import { PROVIDER_CATALOG_ROWS, providerRow } from "./providerCatalog";
import { DELEGATE_IDS } from "../delegates";
import { SOURCE_LABEL } from "../runs";

describe("Provider catalog", () => {
  it("exposes the wired LM Studio Provider to frontend pickers", () => {
    expect(ALL_PROVIDERS.find((provider) => provider.id === "lmstudio")).toMatchObject({
      name: "LM Studio",
      available: true,
    });
  });

  it("offers DeepSeek as a hosted API Provider, not a delegate", () => {
    expect(PROVIDER_CATALOG.find((provider) => provider.id === "deepseek")).toMatchObject({
      name: "DeepSeek",
      group: "hosted",
      runtime: "hosted",
      available: true,
      defaultModel: "deepseek-chat",
    });
    expect(isDelegateProvider("deepseek")).toBe(false);
    expect(selectableProviders({ includeDelegates: false }).some((p) => p.id === "deepseek")).toBe(
      true,
    );
  });

  it("derives picker rows and defaults from one unique row per builtin", () => {
    const ids = PROVIDER_CATALOG.map((provider) => provider.id);
    const groupedIds = PROVIDER_GROUPS.flatMap((group) => group.items.map((item) => item.id));

    expect(new Set(ids).size).toBe(ids.length);
    expect(ALL_PROVIDERS.map((provider) => provider.id)).toEqual(ids);
    // Grouping loses no row and invents none. The picker orders its groups
    // (Local, Subscription, API) independently of the registry's row order.
    expect([...groupedIds].sort()).toEqual([...ids].sort());
    for (const provider of PROVIDER_CATALOG) {
      expect(DEFAULT_MODELS[provider.id]).toBe(provider.defaultModel);
      expect(defaultModelForProvider(provider.id)).toBe(provider.defaultModel);
    }
  });

  it("keeps unavailable and delegate capabilities out of headless race picks", () => {
    const selectable = selectableProviders({ includeDelegates: false });

    expect(selectable.every((provider) => provider.available)).toBe(true);
    expect(selectable.every((provider) => !isDelegateProvider(provider.id))).toBe(true);
    // The placeholder rows an older catalog carried as `available: false`
    // (`llamacpp`, `vllm`, `gemini`) are gone with the hand-kept table: the
    // registry publishes only what Klide can actually dispatch to.
    expect(selectable.map((provider) => provider.id)).toEqual(
      PROVIDER_CATALOG.filter((p) => p.runtime !== "delegate").map((p) => p.id),
    );
  });

  it("offers llama.cpp as an available local provider in the chat picker", () => {
    const local = PROVIDER_GROUPS.find((group) => group.label === "Local");
    expect(local?.items).toContainEqual({ id: "llamacpp", name: "llama.cpp", available: true });
    expect(selectableProviders().some((provider) => provider.id === "llamacpp")).toBe(true);
  });

  it("classifies only app-managed local servers as managed local", () => {
    expect(isManagedLocalProvider("ollama")).toBe(true);
    expect(isManagedLocalProvider("mlx")).toBe(true);
    expect(isManagedLocalProvider("llamacpp")).toBe(true);
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

describe("one answer per provider name", () => {
  it("gives every catalog provider a name and a short name", () => {
    // Mission Control had grown a second `PROVIDER_LABEL` table that disagreed
    // with the catalog on four ids — `gemini`, `xai`, `mlx` and `omp`, the last
    // of which was simply wrong (the product is Oh My Pi). The board wanting a
    // terser word than the picker is a real requirement; two hand-kept tables
    // was the wrong way to serve it.
    for (const p of PROVIDER_CATALOG) {
      expect(p.name.trim()).not.toBe("");
      expect(providerName(p.id)).toBe(p.name);
      expect(providerShortName(p.id).trim()).not.toBe("");
    }
  });

  it("falls back to the full name when no short name is needed", () => {
    expect(providerShortName("anthropic")).toBe(providerName("anthropic"));
    expect(providerShortName("openai")).toBe(providerName("openai"));
  });

  it("shortens only where the catalog says to", () => {
    expect(providerShortName("mlx")).toBe("MLX");
    expect(providerName("mlx")).toBe("MLX (Apple Silicon)");
    expect(providerShortName("xai")).toBe("xAI");
  });

  it("agrees with the run board's source labels for every delegate", () => {
    // A delegate is both a Run source and a Provider, so its two names have to
    // match or the same agent reads differently in two columns.
    for (const id of DELEGATE_IDS) {
      expect(providerName(id)).toBe(SOURCE_LABEL[id]);
    }
  });

  it("recognises catalog ids and rejects everything else", () => {
    expect(isKnownProvider("anthropic")).toBe(true);
    expect(isKnownProvider("custom:my-box")).toBe(false);
    expect(isKnownProvider("retired-provider")).toBe(false);
  });
});

describe("the catalog is derived from the Rust registry", () => {
  it("restates no fact the published row did not supply", () => {
    // Every builtin picker row is one published registry row, transformed:
    // name, short name, group and default model are read off it, never typed
    // here. The only additions are `auto` (the router) and the runtime word,
    // which is a function of two row facts (group + isLocalServer).
    const builtin = PROVIDER_CATALOG.filter((p) => p.id !== AUTO_PROVIDER);
    expect(builtin.map((p) => p.id)).toEqual(PROVIDER_CATALOG_ROWS.map((row) => row.id));
    for (const p of builtin) {
      const row = providerRow(p.id);
      expect(row, p.id).toBeDefined();
      expect(p.name).toBe(row!.label);
      expect(p.shortName).toBe(row!.shortLabel ?? undefined);
      expect(p.group).toBe(row!.group);
      expect(p.available).toBe(true);
      if (row!.group === "subscription") {
        expect(p.runtime).toBe("delegate");
        expect(p.defaultModel).toBe(CLI_DEFAULT_MODEL);
      } else {
        expect(p.defaultModel).toBe(row!.defaultModel);
        expect(p.runtime).toBe(
          row!.group === "hosted" ? "hosted" : row!.isLocalServer ? "managed-local" : "external-local",
        );
      }
    }
  });

  it("keeps the router as the one row the registry does not publish", () => {
    expect(PROVIDER_CATALOG[0]).toMatchObject({ id: AUTO_PROVIDER, group: "routed", runtime: "router" });
    expect(providerRow(AUTO_PROVIDER)).toBeUndefined();
  });
});
