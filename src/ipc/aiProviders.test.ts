import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  LOCAL_MODEL_CHANGED_EVENT,
  selectLlamaModel,
  listProviderModels,
  modelReflectionLevels,
  modelSupportsReflection,
  readProviderKeyStatus,
  readModelCapabilities,
  readModelPricing,
  readProviderContextWindow,
  startLocalProvider,
} from "./aiProviders";

describe("AI Provider IPC Adapter", () => {
  beforeEach(() => invokeMock.mockReset());

  it("owns the model-list wire contract", async () => {
    invokeMock.mockResolvedValue(["model-a"]);

    await expect(listProviderModels("openai")).resolves.toEqual(["model-a"]);
    expect(invokeMock).toHaveBeenCalledWith("ai_provider_models", {
      provider: "openai",
    });
  });

  it("owns key-status and capability argument names", async () => {
    invokeMock
      .mockResolvedValueOnce({ hasKey: true, source: "env" })
      .mockResolvedValueOnce(true);

    await readProviderKeyStatus("anthropic");
    await modelSupportsReflection("anthropic", "claude-sonnet-4-6");

    expect(invokeMock).toHaveBeenNthCalledWith(1, "ai_provider_key_status", {
      provider: "anthropic",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "ai_model_supports_reflection", {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
  });

  it("asks Rust which efforts a pair accepts, rather than assuming a set", async () => {
    invokeMock.mockResolvedValue(["low", "medium", "high", "xhigh", "max", "ultra"]);

    await expect(modelReflectionLevels("codex", "gpt-6-astra")).resolves.toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(invokeMock).toHaveBeenCalledWith("ai_model_reflection_levels", {
      provider: "codex",
      model: "gpt-6-astra",
    });
  });

  it("keeps capability inspection passive when requested and preserves unknown windows", async () => {
    const caps = { contextWindow: null, supportsTools: true, supportsVision: false,
      reasoningLevels: [], priceClass: { kind: "unknown" }, maker: null };
    invokeMock.mockResolvedValueOnce(caps).mockResolvedValueOnce(null);
    await expect(readModelCapabilities("ollama", "unknown", false)).resolves.toEqual(caps);
    expect(invokeMock).toHaveBeenNthCalledWith(1, "ai_model_capabilities", {
      provider: "ollama", model: "unknown", allowActivationProbe: false,
    });
    await expect(readProviderContextWindow("ollama", "unknown")).resolves.toBeNull();
  });

  it("includes the provider when asking the price of the same model", async () => {
    invokeMock.mockResolvedValueOnce(null).mockResolvedValueOnce({ inputPerMillion: 3, outputPerMillion: 15 });
    await expect(readModelPricing("ollama", "claude-sonnet-4-6")).resolves.toBeNull();
    await expect(readModelPricing("anthropic", "claude-sonnet-4-6")).resolves.toEqual({ inputPerMillion: 3, outputPerMillion: 15 });
    expect(invokeMock).toHaveBeenNthCalledWith(1, "ai_model_pricing", { provider: "ollama", model: "claude-sonnet-4-6" });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "ai_model_pricing", { provider: "anthropic", model: "claude-sonnet-4-6" });
  });

  it("preserves optional local-server concurrency on the wire", async () => {
    invokeMock.mockResolvedValue(true);

    await startLocalProvider({ provider: "mlx", model: "model-a", concurrency: 3 });

    expect(invokeMock).toHaveBeenCalledWith("ai_local_server_start", {
      provider: "mlx",
      model: "model-a",
      concurrency: 3,
    });
  });
});

describe("llama.cpp selection", () => {
  it("publishes the selected model only after Rust saves it", async () => {
    const setItem = vi.fn();
    const dispatchEvent = vi.fn();
    vi.stubGlobal("localStorage", { setItem });
    vi.stubGlobal("window", { dispatchEvent });
    vi.stubGlobal("CustomEvent", class { constructor(public type: string, public options: unknown) {} });
    try {
      invokeMock.mockReset().mockRejectedValueOnce(new Error("Disk full"));
      await expect(selectLlamaModel("Qwen/Qwen3-8B-GGUF:Q4_K_M")).rejects.toThrow("Disk full");
      expect(setItem).not.toHaveBeenCalled();
      expect(dispatchEvent).not.toHaveBeenCalled();
      invokeMock.mockResolvedValueOnce(undefined);
      await selectLlamaModel("Qwen/Qwen3-8B-GGUF:Q4_K_M");
      expect(setItem).toHaveBeenCalledWith("klide.model.llamacpp", "Qwen/Qwen3-8B-GGUF:Q4_K_M");
      expect(dispatchEvent.mock.calls[0][0].type).toBe(LOCAL_MODEL_CHANGED_EVENT);
    } finally { vi.unstubAllGlobals(); }
  });
});
