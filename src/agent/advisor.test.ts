import { describe, expect, it } from "vitest";
import { advisorDefaultModel, resolveAdvisor } from "./advisor";

describe("advisor selection", () => {
  it("uses Luna for an unconfigured advisor and provider-only OpenRouter settings", () => {
    expect(resolveAdvisor()).toEqual({ provider: "openrouter", model: "openai/gpt-5.6-luna" });
    expect(resolveAdvisor({ advisorProvider: "openrouter", advisorModel: " " })).toEqual(resolveAdvisor());
  });

  it("uses the direct API model ID for an OpenAI advisor", () => {
    expect(resolveAdvisor({ advisorProvider: "openai" })).toEqual({ provider: "openai", model: "gpt-5.6-luna" });
    expect(advisorDefaultModel("openai")).toBe("gpt-5.6-luna");
  });

  it("preserves an explicitly chosen advisor", () => {
    expect(resolveAdvisor({ advisorProvider: "openrouter", advisorModel: " chosen/model " }))
      .toEqual({ provider: "openrouter", model: "chosen/model" });
    expect(resolveAdvisor({ advisorProvider: "ollama", advisorModel: "local-model" }))
      .toEqual({ provider: "ollama", model: "local-model" });
  });

  it("does not send an OpenAI model ID to another provider", () => {
    expect(resolveAdvisor({ advisorProvider: "custom:test" })).toEqual({ provider: "custom:test", model: "" });
    expect(resolveAdvisor({ advisorProvider: "codex" }).model).toBe("default");
  });
});
