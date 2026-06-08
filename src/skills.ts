// Skills — reusable instruction bundles for the AI panel, à la Claude Code.
//
// A skill is a named block of instructions the assistant should follow when
// enabled. Enabled skills get folded into the system prompt (see AiPanel).
// Stored in localStorage so they persist across sessions.
//
// Filesystem-loaded skills (`SKILL.md` files under one of the four well-
// known skill locations) are fetched through the Rust `list_filesystem_skills`
// command — the FS plugin in Tauri 2 is path-scope-restricted, so the
// webview can't read arbitrary home-directory paths on its own.

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
  /** Provenance group for filesystem-loaded skills — e.g. "Vercel",
   *  "Matt Pocock", "Personal", "Workspace (auto-generated)". User-
   *  defined and built-in skills leave this undefined. */
  group?: string;
};

// The tools the AI panel exposes — kept in sync with the Rust tool
// registry (the source of truth) via the `ai_list_tools` IPC command.
// `SKILL_TOOLS` is a static fallback that covers the four tools that
// have existed since v0.1, so the UI stays useful even before the
// async fetch resolves. Call `getAvailableTools()` for the live list.
export const SKILL_TOOLS: { id: string; label: string; description: string }[] = [
  { id: "read_file", label: "Read file", description: "Read the contents of a file." },
  { id: "list_dir", label: "List directory", description: "List files and folders." },
  { id: "glob", label: "Glob", description: "Find workspace files matching a pattern (e.g. src/**/*.ts)." },
  { id: "grep", label: "Grep", description: "Search text files in the workspace for a literal pattern." },
  { id: "get_git_status", label: "Git status", description: "Return git branch and changed files for the workspace." },
  { id: "get_git_diff", label: "Git diff", description: "Return git diff for the workspace or one path." },
  { id: "clean_context", label: "Clean context", description: "Discard tool results that led nowhere from the current turn." },
  { id: "web_search", label: "Web search", description: "Search the web for documentation or current information." },
  { id: "web_fetch", label: "Web fetch", description: "Fetch the content of a URL as text." },
  { id: "get_todo_list", label: "Read todos", description: "Read the current TODO list for this project." },
  { id: "update_todo_list", label: "Update todos", description: "Add, complete, edit, or remove project TODOs." },
  { id: "write_file", label: "Edit file", description: "Propose an edit to an existing file (diff review)." },
  { id: "create_file", label: "Create file", description: "Propose a brand-new file (diff review)." },
  { id: "create_skill", label: "Create skill", description: "Save a reusable skill to .agents/skills/ (diff review)." },
];

export const ALL_TOOL_IDS = SKILL_TOOLS.map((t) => t.id);

// Live, Rust-sourced tool list. Returns the same `{ id, label, description }`
// shape but pulls the canonical descriptions from the agent harness so we
// never drift. Falls back to the static SKILL_TOOLS list if the IPC call
// is unavailable.
export async function getAvailableTools(): Promise<{ id: string; label: string; description: string }[]> {
  try {
    const { listAllTools } = await import("./agent/tools");
    const raw = await listAllTools();
    if (!Array.isArray(raw) || raw.length === 0) return SKILL_TOOLS;
    const mapped = raw
      .map((t: any) => {
        const fn = t?.function;
        if (!fn || typeof fn.name !== "string") return null;
        const id = fn.name;
        return {
          id,
          label: humanizeToolId(id),
          description: typeof fn.description === "string" ? fn.description : "",
        };
      })
      .filter((x: { id: string; label: string; description: string } | null): x is { id: string; label: string; description: string } => x !== null);
    return mapped.length > 0 ? mapped : SKILL_TOOLS;
  } catch {
    return SKILL_TOOLS;
  }
}

// "read_file" -> "Read file", "get_git_status" -> "Get git status",
// "create_skill" -> "Create skill". Reasonable enough for display.
function humanizeToolId(id: string): string {
  return id
    .split("_")
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

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
  // Lives in Rust — see `list_filesystem_skills` in src-tauri/src/lib.rs.
  // The Rust side resolves the home dir, walks the four skill folders,
  // and parses each `SKILL.md` frontmatter. The FS plugin can't see
  // arbitrary home-directory paths under Tauri 2's scope rules.
  type FileSystemSkill = {
    id: string;
    name: string;
    description: string;
    instructions: string;
    fromFile: string;
    source: string;
    group: string;
  };
  let raw: FileSystemSkill[] = [];
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    raw = await invoke<FileSystemSkill[]>("list_filesystem_skills", { workspaceRoot });
  } catch {
    return [];
  }
  // Grant filesystem-loaded skills every tool the harness exposes. Skills
  // pulled from `npx skills` (Vercel, Anthropic, mattpocock, etc.) were
  // designed to use the full Claude Code tool set, and the SKILL.md they
  // ship rarely enumerates an allowlist.
  const available = await getAvailableTools();
  const allIds = available.map((t) => t.id);
  return raw.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    instructions: s.instructions,
    tools: allIds,
    enabled: true,
    fromFile: s.fromFile,
    group: s.group,
  }));
}
