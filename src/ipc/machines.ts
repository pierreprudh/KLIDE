// Remote machines wire — `machines_list` / `machine_check` (src-tauri/src/machines.rs).
// A Remote machine is an SSH host from ~/.klide/machines.json; a Claude Code
// conversation placed on it streams from its durable Run host.
import { invoke } from "@tauri-apps/api/core";

export type MachineFactTone = "ok" | "warn" | "bad" | "quiet";

export type MachineInference = { provider: "openrouter"; model: string };
export type MachineKeyOption = { id: string; label: string };
export function machineOpenrouterKeys(): Promise<MachineKeyOption[]> { return invoke("machine_openrouter_keys"); }
export function machineOpenrouterAuthorize(id: string, keyId: string): Promise<void> { return invoke("machine_openrouter_authorize", { id, keyId }); }

export type Machine = {
  id: string;
  label?: string;
  sshHost: string;
  checkouts?: Record<string, string>;
  inference?: MachineInference;
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
    connection: "connected" | "offline" | "needsTrust" | "needsAuthentication" | "unsupported";
    host: "ready" | "outdated" | "missing" | "unknown";
    claude: "ready" | "needsLogin" | "missing" | "unknown";
    credentialMode?: "subscription" | "openrouter";
    credentials?: "ready" | "needsAuthorization" | "needsLogin" | "unknown";
    github?: "ready" | "needsLogin" | "missing" | "unknown";
    githubScope?: "repository" | "account";
    project: "ready" | "missing" | "unknown" | "notSelected";
  };
};

/** The only Delegate the first slice runs remotely (Rust `REMOTE_PROVIDER`). */
export const REMOTE_PROVIDER = "claude-code";

export function machinesList(): Promise<Machine[]> {
  return invoke<Machine[]>("machines_list");
}

export type RemoteChanges = { diff: string; status: string; worktree: string };
export function machineRunChanges(runId: string): Promise<RemoteChanges> {
  return invoke("machine_run_changes", { runId });
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
  if (machine.inference) {
    const saved = machines.find((value) => value.id === machine.id)?.inference;
    if (saved?.provider !== machine.inference.provider || saved.model !== machine.inference.model) throw new Error("Restart Klide to load OpenRouter remote credentials. The running backend did not save this choice.");
  }
  for (const listener of listeners) listener();
  return machines;
}

export async function machineRemove(id: string): Promise<Machine[]> {
  const machines = await invoke<Machine[]>("machine_remove", { id });
  for (const listener of listeners) listener();
  return machines;
}

export type MachineSetupAction = "connect" | "authorize" | "prepare" | "signIn" | "gitHub" | "clone";

export type RemoteDirectories = { path: string; parent: string | null; entries: { name: string; path: string }[]; truncated: boolean };
export function machineRemoteDirectories(id: string, path: string): Promise<RemoteDirectories> {
  return invoke("machine_remote_directories", { id, path });
}
export function machineRemoteCreateDirectory(id: string, parent: string, name: string): Promise<RemoteDirectories> {
  return invoke("machine_remote_create_directory", { id, parent, name });
}

export type RepositoryContext = { repository: string; authorName: string; authorEmail: string };
export function machineRepositoryContext(workspaceRoot: string): Promise<RepositoryContext> { return invoke("machine_repository_context", { workspaceRoot }); }
export function machineRepositoryConnect(id: string, workspaceRoot: string, allowPush: boolean | null): Promise<string> { return invoke("machine_repository_connect", { id, workspaceRoot, allowPush }); }
export function machineRepositoryConfigure(id: string, workspaceRoot: string, path: string): Promise<void> { return invoke("machine_repository_configure", { id, workspaceRoot, path }); }
export function machineGithubAccounts(id: string): Promise<string[]> { return invoke("machine_github_accounts", { id }); }
export function machineGithubLogout(id: string, login: string): Promise<void> { return invoke("machine_github_logout", { id, login }); }

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
