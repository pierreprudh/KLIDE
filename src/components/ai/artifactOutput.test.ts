import { describe, expect, it } from "vitest";
import { artifactPrompt } from "./artifactOutput";

describe("selected artifact output", () => {
  it("leaves ordinary messages unchanged", () => {
    expect(artifactPrompt("Explain this", null)).toBe("Explain this");
  });
  it.each([["slides", ".pptx"], ["document", ".docx"], ["spreadsheet", ".xlsx"]] as const)("requests an editable %s artifact", (type, extension) => {
    const prompt = artifactPrompt("Quarterly report", type);
    expect(prompt).toContain(`Create an editable ${extension} file`);
    expect(prompt).toContain("Locate and read the matching SKILL.md");
    expect(prompt).toContain("Preserve the current permission and review settings");
  });
  it("includes a selected skill even when it is not globally enabled", () => {
    const prompt = artifactPrompt("Report", "document", [{ id: "docs", name: "documents:documents", description: "", instructions: "Render and inspect every page.", enabled: false, tools: [], fromFile: "/skills/documents/SKILL.md" }]);
    expect(prompt).toContain("Render and inspect every page.");
    expect(prompt).toContain("/skills/documents/SKILL.md");
    expect(prompt).not.toContain("Locate and read");
  });
});
