import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HermesEnvOverrideRow } from "./HermesSetup";

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
