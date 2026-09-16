import { describe, expect, it } from "vitest";
import { choiceLabel, dispatchAnswer, dispatchModelRows } from "./QuestionCard";

describe("dispatchModelRows", () => {
  it("leads a Delegate with its own default and two of its models", () => {
    expect(dispatchModelRows("codex", ["gpt-5.4", "gpt-5.5-codex", "o5"])).toEqual(["default", "gpt-5.4", "gpt-5.5-codex"]);
    expect(dispatchModelRows("claude-code", [])).toEqual(["default"]);
  });

  it("leads with the model the call named when the list does not already hold it", () => {
    expect(dispatchModelRows("codex", ["gpt-5.4", "gpt-5.5-codex"], "o5-pro")).toEqual(["o5-pro", "default", "gpt-5.4", "gpt-5.5-codex"]);
    expect(dispatchModelRows("codex", ["gpt-5.4", "gpt-5.5-codex"], "gpt-5.4")).toEqual(["default", "gpt-5.4", "gpt-5.5-codex"]);
  });

  it("gives an API provider its first three, with no default to fall back on", () => {
    expect(dispatchModelRows("anthropic", ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5", "x"])).toEqual([
      "claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5",
    ]);
  });
});

describe("dispatchAnswer", () => {
  it("sends the agent and the model as one object the harness reads back", () => {
    expect(JSON.parse(dispatchAnswer("codex", "default"))).toEqual({ worker: "codex", model: "default" });
  });
});

describe("choiceLabel", () => {
  it("gives the CLI's default sentinel a sentence when the question is which model", () => {
    const choices = { options: ["default", "claude-opus-4-6"], moreModelsFrom: "claude-code" as const };
    expect(choiceLabel("default", choices)).toEqual({ label: "Let Claude Code choose", note: "default" });
    expect(choiceLabel("claude-opus-4-6", choices)).toEqual({ label: "claude-opus-4-6" });
  });

  it("reads a provider id as its name, for a which-worker question", () => {
    expect(choiceLabel("codex", { options: ["claude-code", "codex", "anthropic"] })).toEqual({ label: "Codex" });
    expect(choiceLabel("anthropic", { options: ["claude-code", "codex", "anthropic"] })).toEqual({ label: "Anthropic" });
  });

  it("leaves a plain question's choices as they were written", () => {
    expect(choiceLabel("default", { options: ["default", "custom"] })).toEqual({ label: "default" });
  });
});
