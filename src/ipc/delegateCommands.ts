// Typed frontend adapter for `delegate_slash_commands` — the `/` commands a
// delegate CLI answers itself (Claude Code: built-ins, skills, plugins).

import { invoke } from "@tauri-apps/api/core";

/** Mirrors `delegate::CliCommands`. */
export type CliCommands = {
  /** Runnable in a headless turn — sent as the message, verbatim. */
  commands: string[];
  /** Need the CLI's own terminal UI; never offered in a composer. */
  terminal: string[];
};

export function delegateSlashCommands(provider: string, workspaceRoot: string): Promise<CliCommands> {
  return invoke<CliCommands>("delegate_slash_commands", { provider, workspaceRoot });
}
