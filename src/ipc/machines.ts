// Remote machines wire — `machines_list` / `machine_check` (src-tauri/src/machines.rs).
// A Remote machine is an SSH host from ~/.klide/machines.json; a Claude Code
// conversation placed on it runs there inside a tmux session.
import { invoke } from "@tauri-apps/api/core";

export type MachineFactTone = "ok" | "warn" | "bad" | "quiet";

export type Machine = {
  id: string;
  label?: string;
  sshHost: string;
  checkouts?: Record<string, string>;
};

export type MachineFact = { label: string; value: string; tone: MachineFactTone; fix?: string };

export type MachineStatus = {
  id: string;
  label: string;
  sshHost: string;
  /** Ready to start a conversation in the workspace that was checked. */
  ready: boolean;
  /** One line for the picker: what it offers, or why it can't start. */
  caption: string;
  facts: MachineFact[];
  checkout: string | null;
};

/** The only Delegate the first slice runs remotely (Rust `REMOTE_PROVIDER`). */
export const REMOTE_PROVIDER = "claude-code";

export function machinesList(): Promise<Machine[]> {
  return invoke<Machine[]>("machines_list");
}

/** One SSH round trip — ask when a picker opens, not on every render. */
export function machineCheck(id: string, workspaceRoot: string | null): Promise<MachineStatus> {
  return invoke<MachineStatus>("machine_check", { id, workspaceRoot });
}

export function machineLabel(machine: Pick<Machine, "id" | "label">): string {
  return machine.label?.trim() || machine.id;
}
