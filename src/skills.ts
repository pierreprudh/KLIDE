// Skills — reusable instruction bundles for the AI panel, à la Claude Code.
//
// A skill is a named block of instructions the assistant should follow when
// enabled. Enabled skills get folded into the system prompt (see AiPanel).
// Stored in localStorage so they persist across sessions.

export type Skill = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  tools: string[];
  enabled: boolean;
  builtin?: boolean;
  updatedAt?: number;
  fromFile?: string;
};

// The tools the AI panel exposes — kept in sync with the TOOLS array in AiPanel.
// A skill lists which of these it's allowed to use, à la Claude Code's allowed-tools.
export const SKILL_TOOLS: { id: string; label: string; description: string }[] = [
  { id: "read_file", label: "Read file", description: "Read the contents of a file." },
  { id: "list_dir", label: "List directory", description: "List files and folders." },
  { id: "write_file", label: "Edit file", description: "Propose an edit to an existing file (diff review)." },
  { id: "create_file", label: "Create file", description: "Propose a brand-new file (diff review)." },
];

export const ALL_TOOL_IDS = SKILL_TOOLS.map((t) => t.id);

const SKILLS_KEY = "klide-skills";

export function genSkillId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// The "classic" default skill — a starting point users can review and tweak.
export const DEFAULT_SKILLS: Skill[] = [
  {
    id: "builtin-code-review",
    name: "Code Review",
    description: "Review code for bugs, edge cases, and clarity before changes land.",
    instructions: `When asked to review code, act as a careful senior reviewer:

- Read the relevant files with read_file before commenting — never review blind.
- Focus on correctness first: logic bugs, off-by-one errors, unhandled errors, and edge cases.
- Then call out clarity and naming issues, and any obvious performance traps.
- Be specific: cite the file and line, and show the smallest fix.
- Keep feedback concise and ordered by severity. Skip nitpicks unless asked.
- If you propose a change, use write_file so the user can review the diff.`,
    tools: ["read_file", "list_dir", "write_file"],
    enabled: true,
    builtin: true,
  },
];

export function loadSkills(): Skill[] {
  try {
    const raw = localStorage.getItem(SKILLS_KEY);
    if (raw === null) return DEFAULT_SKILLS;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_SKILLS;
    return parsed
      .filter(
        (s): s is Skill =>
          s &&
          typeof s.id === "string" &&
          typeof s.name === "string" &&
          typeof s.instructions === "string"
      )
      .map((s) => ({
        ...s,
        // Older saved skills predate the tools field — grant all tools.
        tools: Array.isArray(s.tools)
          ? s.tools.filter((t) => ALL_TOOL_IDS.includes(t))
          : [...ALL_TOOL_IDS],
      }));
  } catch {
    return DEFAULT_SKILLS;
  }
}

export function saveSkills(list: Skill[]): void {
  try {
    localStorage.setItem(SKILLS_KEY, JSON.stringify(list));
  } catch {
    /* storage full or unavailable — skip */
  }
}

/** Instructions block for the enabled skills, ready to append to a system prompt. */
export function enabledSkillsPrompt(skills: Skill[]): string {
  const active = skills.filter((s) => s.enabled && s.instructions.trim());
  if (active.length === 0) return "";
  const blocks = active
    .map((s) => {
      const source = s.builtin ? "" : s.fromFile ? ` (loaded from ${s.fromFile})` : "";
      const tools = s.tools.length
        ? `\nAllowed tools: ${s.tools.join(", ")}.`
        : "\nThis skill uses no tools — answer from context only.";
      return `## Skill: ${s.name}${source}\n${s.description}${tools}\n\n${s.instructions.trim()}`;
    })
    .join("\n\n");
  return `\n\nThe user has enabled the following skills. Follow their instructions whenever relevant:\n\n${blocks}`;
}

export async function loadFilesystemSkills(workspaceRoot: string | null): Promise<Skill[]> {
  const skills: Skill[] = [];
  const { exists, readDir, readTextFile } = await import("@tauri-apps/plugin-fs");
  const { homeDir } = await import("@tauri-apps/api/path");

  const home = await homeDir();
  const dirs: string[] = [];
  if (workspaceRoot) dirs.push(`${workspaceRoot}/.agents/skills`);
  dirs.push(`${home}/.agents/skills`);

  for (const baseDir of dirs) {
    try {
      if (!(await exists(baseDir))) continue;
      const entries = await readDir(baseDir);
      for (const entry of entries) {
        if (!entry.isDirectory) continue;
        const skillDir = `${baseDir}/${entry.name}`;
        const skillFile = `${skillDir}/SKILL.md`;
        try {
          if (!(await exists(skillFile))) continue;
          const raw = await readTextFile(skillFile);
          const { name, description, instructions } = parseSkillMd(raw, entry.name);
          skills.push({
            id: `file-${entry.name}`,
            name,
            description: description || `Skill from ${skillFile}`,
            instructions,
            tools: ["read_file", "list_dir", "write_file", "create_file", "glob", "grep"],
            enabled: true,
            fromFile: skillFile,
          });
        } catch { /* skip unreadable skill */ }
      }
    } catch { /* directory doesn't exist */ }
  }

  return skills;
}

function parseSkillMd(raw: string, folderName: string): { name: string; description: string; instructions: string } {
  let name = folderName;
  let description = "";
  let instructions = raw;

  // Parse YAML frontmatter if present
  if (raw.startsWith("---\n")) {
    const end = raw.indexOf("\n---\n", 4);
    if (end > 0) {
      const frontmatter = raw.slice(4, end);
      for (const line of frontmatter.split("\n")) {
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const key = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (key === "name") name = value;
        if (key === "description") description = value;
      }
      instructions = raw.slice(end + 5).trim();
    }
  }

  return { name, description, instructions };
}
