import { describe, expect, it } from "vitest";
import { configCommand, currentConfigValue, parseConfigUsage, unconfirmedConfigChanges } from "./cliConfig";

const USAGE = `Usage: /config key=value [key=value ...]
  autoCompact=true|false
  editor=normal|vim
  language=<value>
  model=default|sonnet|opus[1m]
  switchModelsOnFlag=Switch automatically|Ask each time`;

describe("parseConfigUsage", () => {
  it("reads each setting the CLI printed, in its order", () => {
    expect(parseConfigUsage(USAGE)).toEqual([
      { key: "autoCompact", choices: ["true", "false"], settable: true },
      { key: "editor", choices: ["normal", "vim"], settable: true },
      { key: "language", choices: null, settable: true },
      { key: "model", choices: ["default", "sonnet", "opus[1m]"], settable: true },
      { key: "switchModelsOnFlag", choices: ["Switch automatically", "Ask each time"], settable: false },
    ]);
  });
  it("ignores any other answer", () => {
    expect(parseConfigUsage("Set Verbose output to false")).toBeNull();
    expect(parseConfigUsage("Here is how to use Usage: /config key=value")).toBeNull();
  });
});

describe("configCommand", () => {
  it("sends every staged change in one message and drops what cannot be sent", () => {
    expect(configCommand({ autoCompact: "false", editor: "vim", language: "  ", x: "a b" })).toBe("/config autoCompact=false editor=vim");
    expect(configCommand({})).toBeNull();
  });
});

describe("current values", () => {
  it("spells stored values the way the CLI does", () => {
    expect(currentConfigValue({ verbose: false, theme: "dark", projects: {} }, "verbose")).toBe("false");
    expect(currentConfigValue({ theme: "dark" }, "theme")).toBe("dark");
    expect(currentConfigValue({ projects: {} }, "projects")).toBeNull();
  });
});

describe("confirming applied settings", () => {
  it("keeps failed and unsent edits pending after a partial apply", () => {
    const edits = { autoCompact: "false", editor: "vim", language: "two words" };
    expect(configCommand(edits)).toBe("/config autoCompact=false editor=vim");
    expect(unconfirmedConfigChanges(edits, { autoCompact: false, editor: "normal", language: "en" }))
      .toEqual({ editor: "vim", language: "two words" });
    expect(unconfirmedConfigChanges(edits, {})).toEqual(edits);
  });
  it("clears only confirmed values, including CLI whitespace normalization", () => {
    expect(unconfirmedConfigChanges({ language: " en ", verbose: "false" }, { language: "en", verbose: false })).toEqual({});
  });
});
