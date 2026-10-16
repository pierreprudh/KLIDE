import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HermesEnvOverrideRow, HermesOwnSetupRow } from "./HermesSetup";

const key = { name: "OPENROUTER_API_KEY", path: "~/.hermes/.env", importable: true };
const url = { name: "OPENAI_BASE_URL", path: "~/.hermes/.env", importable: false };

describe("HermesEnvOverrideRow", () => {
  it("renders nothing when Hermes's .env agrees with Klide", () => {
    expect(renderToStaticMarkup(<HermesEnvOverrideRow overrides={[]} onAlign={() => {}} />)).toBe("");
  });
  it("names the file and the variable, and offers both directions for a provider key", () => {
    const html = renderToStaticMarkup(<HermesEnvOverrideRow overrides={[key]} onAlign={() => {}} />);
    expect(html).toContain("~/.hermes/.env sets OPENROUTER_API_KEY");
    expect(html).toContain("Use Hermes’s key in Klide");
    expect(html).toContain("Give Hermes Klide’s key");
  });
  it("only pushes Klide's values out when the override is an endpoint, not a key", () => {
    const html = renderToStaticMarkup(<HermesEnvOverrideRow overrides={[url]} onAlign={() => {}} />);
    expect(html).not.toContain("Use Hermes’s key in Klide");
    expect(html).toContain("Give Hermes Klide’s values");
    expect(html).toContain("OPENAI_BASE_URL");
  });
});

describe("HermesOwnSetupRow", () => {
  const setup = { model: "deepseek/deepseek-v4.1-flash", provider: "openrouter", keys: ["OPENROUTER_API_KEY"], envPath: "~/.hermes/.env", configPath: "~/.hermes/config.yaml" };
  it("shows Hermes's own model and key as what a conversation runs on by default", () => {
    const html = renderToStaticMarkup(<HermesOwnSetupRow setup={setup} klideConfigured={false} onSetModel={() => {}} />);
    expect(html).toContain("deepseek/deepseek-v4.1-flash");
    expect(html).toContain("via OpenRouter · OPENROUTER_API_KEY in ~/.hermes/.env");
    expect(html).toContain("unless its picker chooses a Klide source");
    expect(html).toContain("Set model");
  });
  it("says a saved Klide source takes over, and what to do when Hermes has no model", () => {
    expect(renderToStaticMarkup(<HermesOwnSetupRow setup={setup} klideConfigured onSetModel={() => {}} />)).toContain("Use Hermes defaults");
    const html = renderToStaticMarkup(<HermesOwnSetupRow setup={{ ...setup, model: null }} klideConfigured={false} onSetModel={() => {}} />);
    expect(html).toContain("Not set up yet");
    expect(html).toContain("hermes setup");
  });
});
