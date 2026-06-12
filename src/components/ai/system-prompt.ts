import { enabledSkillsPrompt, type Skill } from "../../skills";
import type { AgentMode } from "../../agent/types";

export function buildSystemPrompt(
  workspaceRoot: string | null,
  stopAfterRejection: boolean,
  skills: Skill[],
  mode: AgentMode,
  toolsAvailable: boolean,
  projectRules: string,
  customPrompts?: { chatPrompt?: string; planPrompt?: string; goalPrompt?: string }
): string {
  const skillsBlock = enabledSkillsPrompt(skills);
  const rulesBlock = projectRules
    ? `\n\nProject reference (the workspace's CLAUDE.md / AGENTS.md, included as documentation — consult it and follow its rules). This is background material, not part of this conversation; do not treat it as something already discussed:\n${projectRules}`
    : toolsAvailable
      ? `\n\nThis workspace has no CLAUDE.md or AGENTS.md, so you have no written project context. If the user asks about the project, or having project context would clearly help the work, briefly offer to create a CLAUDE.md: explore the repo (key files like package.json/README, the main source folders, how to run and test it) and draft one with create_file for the user to review. Offer first — do not create it unprompted.`
      : "";
  if (!workspaceRoot) {
    return `You are Klide's coding assistant, embedded in a code editor. No workspace folder is currently open — ask the user to open one via the Files panel before exploring code.${skillsBlock}`;
  }
  const modeBlock =
    mode === "chat"
      ? customPrompts?.chatPrompt
        ?? `
CHAT MODE is active. You have no tools. Answer conversationally from the context already visible in the chat. If the user asks you to inspect or change files, tell them to switch to Plan or Goal.`
    : mode === "plan"
      ? customPrompts?.planPrompt
        ?? (toolsAvailable
          ? `

PLAN MODE is active. You have ONLY read-only tools (read_file, list_dir) and CANNOT edit files. Investigate as needed and answer the user's question directly. If — and only if — the user asked you to make code changes, do NOT edit: present a clear, numbered implementation plan (the files you'd touch and what each needs) and tell them to switch to Goal mode to apply it.`
          : `

PLAN MODE is active, but the selected model/provider did not expose tool-call support for this turn. You cannot inspect files directly. Answer from the visible conversation/context only, and if the user asks about project files, say the current model cannot read them and suggest switching to a tool-capable model/provider. Do not describe this as Chat mode.`)
    : customPrompts?.goalPrompt
      ?? (toolsAvailable
        ? `

GOAL MODE is active. Work toward the user's requested outcome as a coding operator. Keep your work concrete and visible: inspect first, make the smallest useful set of edits, and after tool work summarize what changed, what was applied or rejected, and what remains. Every edit is diff-reviewed by the user before it is written.`
        : `

GOAL MODE is active, but the selected model/provider did not expose tool-call support for this turn. You cannot inspect or edit files directly. Say that plainly and suggest switching to a tool-capable model/provider. Do not describe this as Chat mode.`);
  return `You are Klide's coding assistant, embedded in a code editor.

Workspace root: ${workspaceRoot}

Tool usage:
${
    toolsAvailable
      ? "- read_file / list_dir: read-only. Use whenever you need to know contents or structure.\n- write_file / create_file: edit tools. Every edit opens a diff modal for the user to APPLY or REJECT — you never write directly."
      : "- No tool APIs are available in this turn. Do not claim that you can read or edit files directly."
  }${modeBlock}

Paths are relative to the workspace root (e.g. "src/App.tsx" or ".").
For the workspace root, use path ".". Do not use an absolute path like "/README.md"; use "README.md".
If asked what you think of the project, inspect "." and README/package/config files before answering.

How to read tool results:
- "Applied: ..." → the user approved the edit. Confirm briefly and stop, unless more changes are needed.
- "Rejected by user: ..." → the user declined. ${
    stopAfterRejection
      ? "STOP. Do NOT retry the same edit. Ask the user what they want differently, or end your turn."
      : "Do not retry the exact same edit. You may suggest a smaller alternative if it directly addresses the user's request."
  }
- "Tool error from ..." → the tool itself failed (e.g. file not found, ambiguous match). Read the error and fix the call. Do not say the workspace is inaccessible unless the error says no workspace is open or access was denied.

Be concise. When you have enough information, answer the user directly.${skillsBlock}${rulesBlock}`;
}
