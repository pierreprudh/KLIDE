// Containment for commands nobody read (agent/sandbox.rs): whether this
// platform can sandbox a command, and whether the person has it on.

import { invoke } from "@tauri-apps/api/core";

export type CommandSandboxStatus = {
  /** False where there is no sandbox to apply (anything but macOS today). */
  supported: boolean;
  enabled: boolean;
};

export function commandSandboxStatus(): Promise<CommandSandboxStatus> {
  return invoke<CommandSandboxStatus>("command_sandbox_status");
}

/** Turn containment on or off; answers what is stored now. */
export function setCommandSandbox(enabled: boolean): Promise<CommandSandboxStatus> {
  return invoke<CommandSandboxStatus>("command_sandbox_set", { enabled });
}
