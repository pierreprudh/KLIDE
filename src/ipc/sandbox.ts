// Containment for commands nobody read (agent/sandbox.rs): whether this
// platform can sandbox a command, and whether the person has it on.

import { invoke } from "@tauri-apps/api/core";

export type CommandSandboxStatus = {
  /** False where there is no sandbox to apply (anything but macOS today). */
  supported: boolean;
  enabled: boolean;
  /** Whether a sandboxed command may reach beyond this machine. */
  network: boolean;
};

export function commandSandboxStatus(): Promise<CommandSandboxStatus> {
  return invoke<CommandSandboxStatus>("command_sandbox_status");
}

/** Change either choice — the one left out keeps its value; answers what is
 *  stored now. */
export function setCommandSandbox(change: { enabled?: boolean; network?: boolean }): Promise<CommandSandboxStatus> {
  return invoke<CommandSandboxStatus>("command_sandbox_set", change);
}
