import { describe, expect, it } from "vitest";
import {
  forgetsRememberedModel,
  hostModelAdoption,
  hostPairAdoption,
  offlineModelFallback,
  providerSwitchModel,
  unavailableModelFallback,
} from "./modelSelection";

describe("hostModelAdoption", () => {
  it("leaves the pair alone on mount — the restored Conversation owns it", () => {
    expect(
      hostModelAdoption({
        hostModel: "pierreprudh/lfm2.5-8b-a1b:latest",
        lastHostModel: undefined,
        sessionModel: "qwen3.8:27b-mlx",
      }),
    ).toBeNull();
  });

  it("ignores an unchanged host prop, however stale it is", () => {
    // The reported defect: App re-renders for unrelated reasons (a git status
    // refresh, a run event) with a layout model saved before the Provider's
    // model list corrected the pick. Nothing was picked, so nothing changes.
    expect(
      hostModelAdoption({
        hostModel: "pierreprudh/lfm2.5-8b-a1b:latest",
        lastHostModel: "pierreprudh/lfm2.5-8b-a1b:latest",
        sessionModel: "qwen3.8:27b-mlx",
      }),
    ).toBeNull();
  });

  it("adopts a host model that actually changed — the hero/host pick", () => {
    expect(
      hostModelAdoption({
        hostModel: "claude-sonnet-5",
        lastHostModel: "qwen3.8:27b-mlx",
        sessionModel: "qwen3.8:27b-mlx",
      }),
    ).toBe("claude-sonnet-5");
  });

  it("is a no-op when the changed host prop already matches the session", () => {
    // The mount push-up comes back as a prop change; adopting it would be a
    // pointless transition (and a pointless re-persist of the Conversation).
    expect(
      hostModelAdoption({
        hostModel: "qwen3.8:27b-mlx",
        lastHostModel: "pierreprudh/lfm2.5-8b-a1b:latest",
        sessionModel: "qwen3.8:27b-mlx",
      }),
    ).toBeNull();
  });

  it("never adopts an empty host model", () => {
    expect(
      hostModelAdoption({
        hostModel: "",
        lastHostModel: "qwen3.8:27b-mlx",
        sessionModel: "qwen3.8:27b-mlx",
      }),
    ).toBeNull();
  });
});

describe("offlineModelFallback", () => {
  it("keeps the session's model when the Provider's list can't be read", () => {
    expect(
      offlineModelFallback("qwen3.8:27b-mlx", "pierreprudh/lfm2.5-8b-a1b:latest"),
    ).toBe("qwen3.8:27b-mlx");
  });

  it("falls back to the remembered model only for a panel with none", () => {
    expect(offlineModelFallback("", "pierreprudh/lfm2.5-8b-a1b:latest")).toBe(
      "pierreprudh/lfm2.5-8b-a1b:latest",
    );
  });
});

describe("unavailableModelFallback", () => {
  // Pierre's own store, which is where this was found: seventeen OpenRouter
  // stars, `sakana/fugu-ultra` the oldest and the DeepSeek pair the newest,
  // with `klide.model.openrouter` holding the real last pick.
  const favourites = ["sakana/fugu-ultra", "z-ai/glm-5.2", "deepseek/deepseek-v4-pro"];
  const available = [
    "sakana/fugu-ultra",
    "z-ai/glm-5.2",
    "deepseek/deepseek-v4-pro",
    "deepseek/deepseek-v4-flash",
    "openai/gpt-4o",
  ];

  it("keeps a pick the Provider still serves", () => {
    expect(
      unavailableModelFallback({
        available,
        sessionModel: "deepseek/deepseek-v4-flash",
        rememberedModel: "deepseek/deepseek-v4-flash",
        providerDefault: "openai/gpt-4o",
        favourites,
      }),
    ).toBeNull();
  });

  it("returns to the Provider's remembered pick, not its oldest star", () => {
    expect(
      unavailableModelFallback({
        // A foreign model crossed in — an Ollama tag on an OpenRouter panel.
        available,
        sessionModel: "pierreprudh/lfm2.5-8b-a1b:latest",
        rememberedModel: "deepseek/deepseek-v4-flash",
        providerDefault: "openai/gpt-4o",
        favourites,
      }),
    ).toBe("deepseek/deepseek-v4-flash");
  });

  it("falls to the configured default when the remembered pick is gone too", () => {
    expect(
      unavailableModelFallback({
        available,
        sessionModel: "gone/model",
        rememberedModel: "also-gone/model",
        providerDefault: "openai/gpt-4o",
        favourites,
      }),
    ).toBe("openai/gpt-4o");
  });

  it("prefers the newest star over the oldest", () => {
    expect(
      unavailableModelFallback({
        available,
        sessionModel: "gone/model",
        rememberedModel: "",
        providerDefault: "not-served/model",
        favourites,
      }),
    ).toBe("deepseek/deepseek-v4-pro");
  });

  it("takes the list head only when nothing else is evidenced", () => {
    expect(
      unavailableModelFallback({
        available: ["only/model"],
        sessionModel: "gone/model",
        rememberedModel: "",
        providerDefault: "",
        favourites: [],
      }),
    ).toBe("only/model");
  });

  it("changes nothing when the list is empty — it said nothing", () => {
    expect(
      unavailableModelFallback({
        available: [],
        sessionModel: "anything",
        rememberedModel: "x",
        providerDefault: "y",
        favourites,
      }),
    ).toBeNull();
  });
});

describe("providerSwitchModel", () => {
  const favourites = ["sakana/fugu-ultra", "z-ai/glm-5.2", "deepseek/deepseek-v4-pro"];

  it("lands on the Provider's remembered pick, not a star", () => {
    expect(
      providerSwitchModel({
        remembered: "deepseek/deepseek-v4-flash",
        favourites,
        providerDefault: "openai/gpt-4o",
      }),
    ).toBe("deepseek/deepseek-v4-flash");
  });

  it("uses the newest star when nothing is remembered", () => {
    expect(
      providerSwitchModel({ remembered: null, favourites, providerDefault: "openai/gpt-4o" }),
    ).toBe("deepseek/deepseek-v4-pro");
  });

  it("falls back to the configured default with no stars either", () => {
    expect(
      providerSwitchModel({ remembered: null, favourites: [], providerDefault: "openai/gpt-4o" }),
    ).toBe("openai/gpt-4o");
  });
});

describe("forgetsRememberedModel", () => {
  it("forgets a pick the key's listing does not serve", () => {
    expect(forgetsRememberedModel({ listed: ["mistral-medium-latest", "mistral-small-latest"], remembered: "mistral-large-latest", delegate: false })).toBe(true);
  });
  it("keeps a served pick, and judges nothing from an empty listing or a Delegate's", () => {
    expect(forgetsRememberedModel({ listed: ["mistral-large-latest"], remembered: "mistral-large-latest", delegate: false })).toBe(false);
    expect(forgetsRememberedModel({ listed: [], remembered: "mistral-large-latest", delegate: false })).toBe(false);
    expect(forgetsRememberedModel({ listed: ["default", "sonnet"], remembered: "opus", delegate: true })).toBe(false);
    expect(forgetsRememberedModel({ listed: ["a"], remembered: null, delegate: false })).toBe(false);
  });
});

describe("hostPairAdoption", () => {
  it("brings the host's Provider along when a fresh session is on another one", () => {
    // The reported run: the hero showed OpenRouter, the session was on
    // Anthropic, and the DeepSeek pick went out to Anthropic as a 404.
    expect(hostPairAdoption({ adoptedModel: "deepseek/deepseek-v4.1-flash-1017", hostProvider: "openrouter", sessionProvider: "anthropic", hasMessages: false }))
      .toEqual({ provider: "openrouter", model: "deepseek/deepseek-v4.1-flash-1017" });
  });

  it("adopts the model alone when the Providers already agree", () => {
    expect(hostPairAdoption({ adoptedModel: "claude-sonnet-5", hostProvider: "anthropic", sessionProvider: "anthropic", hasMessages: true }))
      .toEqual({ model: "claude-sonnet-5" });
    expect(hostPairAdoption({ adoptedModel: "claude-sonnet-5", hostProvider: undefined, sessionProvider: "anthropic", hasMessages: true }))
      .toEqual({ model: "claude-sonnet-5" });
  });

  it("never moves a Conversation that already ran, and never lands a foreign model on it", () => {
    expect(hostPairAdoption({ adoptedModel: "deepseek/deepseek-v4.1-flash-1017", hostProvider: "openrouter", sessionProvider: "claude-code", hasMessages: true }))
      .toBeNull();
  });
});
