import { describe, expect, it } from "vitest";
import { disabledToolsFor } from "./tools";

describe("disabledToolsFor", () => {
  const overrides = {
    "goal.write_file": false,
    "plan.grep": false,
    "goal.grep": true,
    web_fetch: false,
  };

  it("keeps a mode-prefixed toggle to its own mode and a bare one to every mode", () => {
    expect(disabledToolsFor("goal", overrides).sort()).toEqual(["web_fetch", "write_file"]);
    expect(disabledToolsFor("plan", overrides).sort()).toEqual(["grep", "web_fetch"]);
    expect(disabledToolsFor("chat", overrides)).toEqual(["web_fetch"]);
  });

  it("turns nothing off without overrides", () => {
    expect(disabledToolsFor("goal", undefined)).toEqual([]);
  });
});
