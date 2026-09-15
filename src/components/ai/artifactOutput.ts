import type { Skill } from "../../skills";

export const ARTIFACT_OUTPUTS = [
  { id: "slides", label: "Slides", extension: ".pptx", skillNames: ["presentations", "pptx"] },
  { id: "document", label: "Document", extension: ".docx", skillNames: ["documents", "docx"] },
  { id: "spreadsheet", label: "Spreadsheet", extension: ".xlsx", skillNames: ["spreadsheets", "xlsx"] },
] as const;
export type ArtifactOutput = typeof ARTIFACT_OUTPUTS[number]["id"];

export function artifactPrompt(text: string, output: ArtifactOutput | null, skills: Skill[] = []): string {
  if (!output) return text;
  const choice = ARTIFACT_OUTPUTS.find((item) => item.id === output)!;
  const skill = skills.find((item) => choice.skillNames.some((name) => item.name.toLowerCase().split(":").pop() === name));
  return `${text}\n\n[Selected output: ${choice.label} (${choice.extension})]\nCreate an editable ${choice.extension} file. Use the ${choice.skillNames[0]} skill for this task. ${skill ? `Follow these skill instructions${skill.fromFile ? ` from ${skill.fromFile} (resolve relative resources from its directory)` : ""}:\n${skill.instructions}` : "Locate and read the matching SKILL.md before creating the artifact. If unavailable, state that limitation and use available file-generation tools."}\nVerify the generated file and provide its path. If creation fails, report the blocker; do not claim a file exists without tool evidence. Preserve the current permission and review settings.`;
}
