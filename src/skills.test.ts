import { describe, expect, it } from "vitest";
import { enabledFirst, enabledRunSkills, enabledSkillsPrompt, enabledSkillsPromptParts, skillFolderOf } from "./skills";

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
    expect(prompt).toContain("- /visualise — Draw it.");
    expect(prompt).toContain("read_skill");
    expect(prompt).not.toContain("Use svg.");
    expect(prompt).not.toContain("Handoff");
  });

  it("keeps skill definitions out of ordinary answers", () => {
    const prompt = enabledSkillsPrompt([
      { id: "v", name: "visualise", description: "Draw it.", instructions: "Use svg.", tools: [], enabled: true },
    ]);
    expect(prompt).toContain("Use skill definitions as instructions, not as answer content.");
    expect(prompt).toContain("Do not invent additional skills");
    expect(prompt).toContain("unless the user explicitly asks to inspect or edit a skill");
  });

  it("keeps each catalog entry on one line and retains bodies separately", () => {
    const skills = [
      { id: "v", name: "Draw Pictures", description: "Draw\n big\t pictures.", instructions: "long body\n".repeat(1000), tools: ["write_file"], enabled: true },
      { id: "off", name: "Off", description: "Disabled", instructions: "hidden body", tools: [], enabled: false },
    ];
    const prompt = enabledSkillsPrompt(skills);
    expect(prompt).toContain("- /draw-pictures — Draw big pictures.");
    expect(prompt.length).toBeLessThan(600);
    expect(prompt).not.toContain("write_file");
    expect(prompt).not.toContain("long body");
    expect(enabledRunSkills(skills)).toEqual([{ command: "draw-pictures", name: "Draw Pictures", description: skills[0].description, instructions: skills[0].instructions }]);
    expect(enabledSkillsPrompt([])).toBe("");
  });
});

describe("skillFolderOf", () => {
  it("names the skill a SKILL.md in any of the skill locations belongs to", () => {
    expect(skillFolderOf(".agents/skills/software-factory/SKILL.md")).toBe("software-factory");
    expect(skillFolderOf(".klide/skills/review/SKILL.md")).toBe("review");
    expect(skillFolderOf("/Users/p/.claude/skills/tdd/SKILL.md")).toBe("tdd");
  });

  it("ignores a skill's other files and SKILL.md files elsewhere", () => {
    expect(skillFolderOf(".agents/skills/software-factory/RUNNERS.md")).toBeNull();
    expect(skillFolderOf("docs/skills/x/SKILL.md")).toBeNull();
    expect(skillFolderOf(".agents/skills/SKILL.md")).toBeNull();
  });
});

describe("enabledSkillsPromptParts", () => {
  it("is the prompt in pieces — joined, it is the prompt", () => {
    const skills = [
      { id: "v", name: "visualise", description: "Draw it.", instructions: "Use svg.", tools: [], enabled: true },
      { id: "h", name: "Handoff", description: "Hand it off.", instructions: "x", tools: [], enabled: true },
    ];
    const parts = enabledSkillsPromptParts(skills)!;
    expect(parts.lines.map((l) => l.command)).toEqual(["/visualise", "/handoff"]);
    expect(`${parts.preamble}\n${parts.lines.map((l) => l.line).join("\n")}`).toBe(enabledSkillsPrompt(skills));
    expect(enabledSkillsPromptParts([])).toBeNull();
  });
});
