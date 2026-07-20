import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  listProviderModels,
  modelSupportsReflection,
  readProviderKeyStatus,
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
