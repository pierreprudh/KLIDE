// Typed frontend adapter for `delegate_slash_commands` — the `/` commands a
// delegate CLI answers itself (Claude Code: built-ins, skills, plugins; omp:
// its file commands).

import { invoke } from "@tauri-apps/api/core";

/** Mirrors `delegate::CliCommands`. */
export type CliCommands = {
  /** Runnable in a headless turn — sent as the message, verbatim. */
  commands: string[];
  /** Need the CLI's own terminal UI; never offered in a composer. */
  terminal: string[];
  /** What the CLI says a command does, when it says (omp). */
  descriptions?: Record<string, string>;
};

export function delegateSlashCommands(provider: string, workspaceRoot: string): Promise<CliCommands> {
  return invoke<CliCommands>("delegate_slash_commands", { provider, workspaceRoot });
}

/** Claude Code's settings as its own files hold them — top-level scalars,
 *  keyed as stored (mirrors `delegate::claude_code_settings`). */
export function claudeCodeSettings(workspaceRoot: string): Promise<Record<string, unknown>> {
  return invoke<Record<string, unknown>>("claude_code_settings", { workspaceRoot });
}
