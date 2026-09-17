import { describe, expect, it } from "vitest";
import { enabledFirst, enabledSkillsPrompt } from "./skills";

describe("enabledFirst", () => {
  it("moves the enabled skills ahead and keeps each side's own order", () => {
    const s = (id: string, enabled: boolean) => ({ id, name: id, description: "", instructions: "", tools: [], enabled });
    const out = enabledFirst([s("a", false), s("b", true), s("c", false), s("d", true)]);
    expect(out.map((x) => x.id)).toEqual(["b", "d", "a", "c"]);
  });
});

describe("enabledSkillsPrompt", () => {
  it("names each enabled skill's command and explains the convention", () => {
    const prompt = enabledSkillsPrompt([
      { id: "v", name: "visualise", description: "Draw it.", instructions: "Use svg.", tools: [], enabled: true },
      { id: "off", name: "Handoff", description: "", instructions: "x", tools: [], enabled: false },
    ]);
    expect(prompt).toContain("## Skill: visualise\nCommand: /visualise\n");
    expect(prompt).toContain("begins with a skill's command (for example `/visualise …`)");
    expect(prompt).not.toContain("Handoff");
  });
});
