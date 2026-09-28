import { describe, expect, it } from "vitest";
import { configCommand, currentConfigValue, parseConfigUsage, sendableConfigChanges, settleAppliedConfig } from "./cliConfig";

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
    expect(currentConfigValue({ autoCompactEnabled: false, editorMode: "vim" }, "autoCompact")).toBe("false");
    expect(currentConfigValue({ autoCompactEnabled: false, editorMode: "vim" }, "editor")).toBe("vim");
  });
});

describe("settling an Apply", () => {
  it("clears confirmed edits, keeps refused ones, and leaves unsent ones alone", () => {
    const staged = { verbose: "true", tips: "false", editor: "vim", language: "two words" };
    const sent = { verbose: "true", tips: "false", editor: "vim" };
    // verbose confirmed; tips refused (still true); editor stored as editorMode.
    const settings = { verbose: true, tips: true, editorMode: "vim" };
    expect(settleAppliedConfig(staged, sent, settings)).toEqual({
      staged: { tips: "false", language: "two words" },
      assumed: {},
    });
  });
  it("takes an edit the files cannot show as applied", () => {
    expect(settleAppliedConfig({ chrome: "true" }, { chrome: "true" }, {})).toEqual({ staged: {}, assumed: { chrome: "true" } });
  });
  it("keeps an edit changed again after it was sent", () => {
    expect(settleAppliedConfig({ tips: "true" }, { tips: "false" }, { tips: false })).toEqual({ staged: { tips: "true" }, assumed: {} });
  });
});

describe("sendableConfigChanges", () => {
  it("is what configCommand sends", () => {
    expect(sendableConfigChanges({ a: "1", b: " ", c: "x y" })).toEqual({ a: "1" });
  });
});
