import { describe, expect, it } from "vitest";
import { choiceLabel } from "./QuestionCard";

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
