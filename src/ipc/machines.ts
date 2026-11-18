// Remote machines wire — `machines_list` / `machine_check` (src-tauri/src/machines.rs).
// A Remote machine is an SSH host from ~/.klide/machines.json; a Claude Code
// conversation placed on it streams from its durable Run host.
import { invoke } from "@tauri-apps/api/core";

export type MachineFactTone = "ok" | "warn" | "bad" | "quiet";

export type Machine = {
  id: string;
  label?: string;
  sshHost: string;
  checkouts?: Record<string, string>;
};

export type MachineFact = { label: string; value: string; tone: MachineFactTone; fix?: string };

export type HostTarget = { os: "linux" | "macos" | "windows"; arch: "x86_64" | "aarch64" };

export type MachineStatus = {
  target?: HostTarget | null;
  id: string;
  label: string;
  sshHost: string;
  /** Ready to start a conversation in the workspace that was checked. */
  ready: boolean;
  /** One line for the picker: what it offers, or why it can't start. */
  caption: string;
  facts: MachineFact[];
  checkout: string | null;
  setup: {
    connection: "connected" | "offline" | "needsTrust" | "needsAuthentication";
    host: "ready" | "outdated" | "missing" | "unknown";
    claude: "ready" | "needsLogin" | "missing" | "unknown";
    project: "ready" | "missing" | "unknown" | "notSelected";
  };
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

const listeners = new Set<() => void>();
export function subscribeMachines(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export async function machineSave(machine: Machine, creating: boolean): Promise<Machine[]> {
  const machines = await invoke<Machine[]>("machine_save", { machine, creating });
  for (const listener of listeners) listener();
  return machines;
}

export async function machineRemove(id: string): Promise<Machine[]> {
  const machines = await invoke<Machine[]>("machine_remove", { id });
  for (const listener of listeners) listener();
  return machines;
}

export type MachineSetupAction = "connect" | "prepare" | "signIn" | "gitHub" | "clone";

/** Explicit setup action; omitted binaryPath downloads this revision's public helper. */
export async function machineInstallHost(id: string, binaryPath?: string): Promise<void> {
  await invoke("machine_install_host", { id, binaryPath: binaryPath ?? null });
  for (const listener of listeners) listener();
}

export type MachineConnectionMethod = "tailscale" | "vpn" | "ssh";
export type MachineCandidate = { label: string; sshHost: string; source: "tailscale" | "sshConfig" | "saved"; online: boolean | null; supported: boolean; detail: string; machine: Machine | null };
export type MachineDiscovery = { machines: MachineCandidate[]; message: string };
export function machineDiscover(method: MachineConnectionMethod): Promise<MachineDiscovery> {
  return invoke("machine_discover", { method });
}
