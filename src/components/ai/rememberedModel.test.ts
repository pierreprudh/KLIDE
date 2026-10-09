import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStorage } from "../../testStorage";
import { toggleFavModel } from "../../favModels";
import { defaultModelForProvider } from "../../agent/providers";
import {
  rememberedModelForProvider,
  storedModelForProvider,
  switchModelForProvider,
} from "./rememberedModel";

describe("switchModelForProvider — what a provider switch lands on", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });

  it("falls back to the Provider's configured default when nothing is remembered", () => {
    expect(switchModelForProvider("openrouter")).toBe(defaultModelForProvider("openrouter"));
  });

  it("lands on the last human pick, not the row's default (the Focus hero used to reset)", () => {
    localStorage.setItem("klide.model.openrouter", "anthropic/claude-sonnet-5");
    expect(switchModelForProvider("openrouter")).toBe("anthropic/claude-sonnet-5");
  });

  it("prefers the newest star over the default when nothing was picked yet", () => {
    toggleFavModel("openrouter", "old/star");
    toggleFavModel("openrouter", "new/star");
    expect(switchModelForProvider("openrouter")).toBe("new/star");
  });

  it("rejects another Provider's id that leaked into a delegate's slot", () => {
    localStorage.setItem("klide.model.claude-code", "pierreprudh/lfm2.5-8b-a1b:latest");
    expect(rememberedModelForProvider("claude-code")).toBeNull();
    expect(storedModelForProvider("claude-code")).toBe(defaultModelForProvider("claude-code"));
  });
});
