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
// Which filesystem-loaded skills the user has explicitly turned on. Filesystem
// skills are re-read from disk on every launch, so their enabled state can't
// live in the skill objects themselves — it would be overwritten. We persist
// just the set of enabled ids here and re-apply it in loadFilesystemSkills.
const ENABLED_FS_KEY = "klide-enabled-fs-skills";

function loadEnabledFsSkillIds(): Set<string> {
  try {
    const raw = localStorage.getItem(ENABLED_FS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr)
      ? new Set(arr.filter((x): x is string => typeof x === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

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
  {
    // Pairs with the `/interview` slash command in AiPanel — the slash
    // command sends a self-contained prompt, but enabling this skill also
    // gives the agent a fuller system-prompt instruction set so it can run
    // the interview without an explicit `/interview` invocation (e.g. when
    // the user just says "ask me about the project").
    id: "builtin-codebase-interview",
    name: "Codebase Interview",
    description:
      "Interview the user about a project's structure, design, and history. Captures tribal knowledge as a written record.",
    instructions: `You're running a structured interview about a codebase. Goal: capture the *why* and *history* — naming, design tensions, tradeoffs, decisions — that aren't in the code or README. The output is a written record that survives the session.

## Setup

1. Read the project root: \`README.md\`, the top-level manifest (\`package.json\`, \`Cargo.toml\`, \`pyproject.toml\`, \`go.mod\`, etc.), and any obvious entry points. If there's no README, note that and proceed with what you have.
2. Skim the top-level directory structure (\`list_dir\` on the root).
3. Form a one-paragraph mental model of what the project is and what it isn't.

## Interview loop

Identify **5-10 high-signal things** you don't understand from the code alone. Skip trivia. Look for:

- **Ambiguous naming** — \`utils/\`, \`helpers/\`, \`core/\`, abbreviations that don't match what the code does.
- **Surprising structure** — folders that don't follow the language's idiom, files that look out of place, splitting patterns that have no obvious reason.
- **Missing docs** — public APIs without comments, behavior that depends on external knowledge, magic numbers.
- **Design tensions** — places where two valid approaches could've been chosen and one was. Tests that look adversarial. Comments that justify a choice ("we tried X, but…").
- **Historical choices** — dependencies that look unusual, files that look dead-but-kept, anything that smells like a former design decision.

For each one, call the \`userAnswerQuestion\` tool with **one short question** — one sentence, focused on what only the user can answer. Examples of good vs bad:

- ❌ "What's the naming convention for the auth folder?" (the user can grep, you can read it yourself)
- ✅ "Why is \`src/auth/\` structured as a flat list of files instead of a subfolder per provider? Was that deliberate?"
- ✅ "The \`webhook_signing_secret\` lives in env vars but \`feature_flags\` is in a JSON file — was there a reason to split them?"
- ✅ "What's the oldest decision in this codebase that you'd push back on if you started over today?"

Wait for the answer. **Use the answer as-is** — don't ask follow-ups unless the answer is clearly incomplete (one word, "I don't know", "not sure"). The model shouldn't grind through 20 questions when 5 sharp ones do the job.

## Hard rule: never repeat a question

The harness records every \`userAnswerQuestion\` call in the transcript. **Before each call, scroll back through the conversation and confirm your new question is not a duplicate** of one you already asked — same topic, same wording, same intent.

Maintain a numbered list of questions you've already asked in your scratchpad. After every answer, append to it. Re-asking the same question wastes the user's time and signals the agent isn't paying attention.

The only acceptable reasons to ask a question that overlaps with a previous one:

- The user said "I don't know" or "not sure" on the first pass.
- The user's previous answer was a single word and clearly not what they meant.
- You genuinely discovered a *different* angle of the same topic that the first question didn't cover (e.g. "Why is X structured this way?" followed by "Was that structure added before or after the auth refactor?").

If you catch yourself about to ask the same question twice, **stop and move to a different question instead.**

## After the interview

Write a single markdown file to \`docs/codebase-decisions.md\` with this structure:

\`\`\`markdown
# Codebase Decisions — captured {YYYY-MM-DD}

Each section is a question the model couldn't answer from the code, plus
the user's answer in their own words, plus a short note on why it matters
for future work.

## 1. {Short title}
**Question:** {the question}
**Answer:** {verbatim or paraphrased answer}
**Why it matters:** {1-2 sentences on the implication for future code}

## 2. {Short title}
...
\`\`\`

End the run cleanly after the file is written. Don't ask "is this good?" — the user has already seen the doc on the diff review screen and can edit it themselves.

## Notes

- The skill assumes the user is the project author or a long-time contributor. If their answer suggests they aren't, **switch to a discovery mode**: ask about the *intent* of the code rather than its history.
- This skill is read-only by default. If the user wants the doc under a different path, they can ask in a follow-up turn.`,
    // Read-only by design. `userAnswerQuestion` is always available (the
    // tool itself isn't gated by skill allowlists), but listing it here
    // documents the intent for anyone reading the skill.
    tools: [
      "read_file",
      "list_dir",
      "glob",
      "grep",
      "get_git_status",
      "get_git_diff",
      "get_todo_list",
      "userAnswerQuestion",
    ],
    enabled: false,
    builtin: true,
  },
];

export function loadSkills(): Skill[] {
  try {
    const raw = localStorage.getItem(SKILLS_KEY);
    if (raw === null) return DEFAULT_SKILLS;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_SKILLS;
    const stored = parsed
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
    // Merge in any DEFAULT_SKILL that's missing from localStorage. New
    // built-ins ship as DEFAULT_SKILLS entries — without this merge, an
    // existing user (with skills already persisted) would never see them
    // because the loader returns the stored list verbatim. The user's
    // own entries win on id collision; the default is only added when
    // the id is unknown.
    const storedIds = new Set(stored.map((s) => s.id));
    const merged = [...stored];
    for (const def of DEFAULT_SKILLS) {
      if (!storedIds.has(def.id)) merged.push(def);
    }
    return merged;
  } catch {
    return DEFAULT_SKILLS;
  }
}

export function saveSkills(list: Skill[]): void {
  try {
    localStorage.setItem(SKILLS_KEY, JSON.stringify(list));
    // Persist which filesystem skills are on, so the choice survives the
    // disk re-read on next launch (see loadFilesystemSkills).
    const enabledFs = list.filter((s) => s.fromFile && s.enabled).map((s) => s.id);
    localStorage.setItem(ENABLED_FS_KEY, JSON.stringify(enabledFs));
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
  // Default OFF. Every enabled skill's full instructions get folded into the
  // system prompt of every turn, so auto-enabling ~40 global skills bloated
  // the prompt to tens of thousands of tokens (and overflowed small local
  // model context windows). The user opts skills in via the Skills modal;
  // their choice is persisted in ENABLED_FS_KEY and re-applied here.
  const enabledIds = loadEnabledFsSkillIds();
  return raw.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    instructions: s.instructions,
    tools: allIds,
    enabled: enabledIds.has(s.id),
    fromFile: s.fromFile,
    group: s.group,
  }));
}
