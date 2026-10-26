import { describe, expect, it } from "vitest";
import { sideQuestionContext, sideQuestionDirective, sideQuestionModel } from "./sideQuestions";

describe("side questions", () => {
  it("recognizes only the /btw command and preserves a multiline question", () => {
    expect(sideQuestionDirective(" /btw why this approach?\nWhat about errors? ")).toBe("why this approach?\nWhat about errors?");
    expect(sideQuestionDirective("/btw")).toBe("");
    expect(sideQuestionDirective("/btwhatever")).toBeNull();
    expect(sideQuestionDirective("explain /btw please")).toBeNull();
  });

  it("uses a native inference source, never a delegate whose tools cannot be restricted", () => {
    expect(sideQuestionModel("ollama", "local-model")).toEqual({ provider: "ollama", model: "local-model" });
    expect(sideQuestionModel("codex", "default")).toEqual({ provider: "auto", model: "auto" });
    expect(sideQuestionModel("codex", 'harness-source:{"provider":"openai","model":"chosen"}')).toEqual({ provider: "openai", model: "chosen" });
    expect(sideQuestionModel("hermes", 'hermes-source:{"provider":"hermes-subscription:nous","model":"chosen"}')).toEqual({ provider: "auto", model: "auto" });
  });

  it("captures public sent context without private reasoning or queued prompts", () => {
    const context = sideQuestionContext([
      { role: "user", content: "original question" },
      { role: "assistant", content: "current answer", thinking: "private reasoning" },
      { role: "user", content: "unsent next task", queueState: "queued" },
      { role: "assistant", content: "raw terminal bytes", delegateConsole: true },
    ]);
    expect(context).toContain("original question");
    expect(context).toContain("current answer");
    expect(context).not.toMatch(/private reasoning|unsent next task|raw terminal bytes/);
  });

  it("keeps a valid recent row when quoted text expands during JSON encoding", () => {
    const context = sideQuestionContext([{ role: "assistant", content: '"\\'.repeat(1000) + "recent" }], 800);
    const row = context.split("\n")[1];
    expect(JSON.parse(row).content).toContain("recent");
    expect(context.length).toBeLessThan(1000);
  });

  it("bounds large history and keeps the recent text with an omission notice", () => {
    const context = sideQuestionContext([
      { role: "user", content: "old history".repeat(100_000) },
      { role: "assistant", content: "recent answer".repeat(100_000) },
    ], 800);
    expect(context.length).toBeLessThan(1_000);
    expect(context).toContain("older text omitted");
    expect(context).toContain("recent answer");
  });
});
