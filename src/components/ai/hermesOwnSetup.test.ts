import { describe, expect, it } from "vitest";
import { describeOwnSetup } from "./hermesOwnSetup";

describe("describeOwnSetup", () => {
  it("names the provider and where the key lives, never a value", () => {
    expect(describeOwnSetup({ model: "deepseek/deepseek-v4.1-flash", provider: "openrouter", keys: ["OPENROUTER_API_KEY"], envPath: "~/.hermes/.env", configPath: "~/.hermes/config.yaml" }))
      .toBe("via OpenRouter · OPENROUTER_API_KEY in ~/.hermes/.env");
  });
  it("says when nothing backs the model", () => {
    expect(describeOwnSetup({ model: "x/y", provider: null, keys: [], envPath: "~/.hermes/.env", configPath: null })).toBe("no key in its .env");
    expect(describeOwnSetup({ model: "x/y", provider: "somewhere", keys: ["HF_TOKEN"], envPath: null, configPath: null })).toBe("via somewhere · HF_TOKEN in its .env");
  });
});
