// Remote machines wire — `machines_list` / `machine_check` (src-tauri/src/machines.rs).
// A Remote machine is an SSH host from ~/.klide/machines.json; a Claude Code
// conversation placed on it streams from its durable Run host.
import { invoke } from "@tauri-apps/api/core";
import { providerEndpointVars, providerGroup, providerRow } from "../agent/providerCatalog";

export type MachineFactTone = "ok" | "warn" | "bad" | "quiet";

/** Turn on (push this Mac's keys now) or off (remove them from the machine)
 *  key sync — Rust `machine_key_sync`. Answers the providers now there. */
export function machineKeySync(id: string, enabled: boolean): Promise<{ synced: string[] }> {
  return invoke("machine_key_sync", { id, enabled });
}

export type Machine = {
  id: string;
  label?: string;
  sshHost: string;
  checkouts?: Record<string, string>;
  /** Keeps a copy of this Mac's API keys; only `machineKeySync` changes it. */
  syncKeys?: boolean;
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
    /** Providers whose API key is authorized on the machine. */
    apiKeys?: string[];
    keySync?: "off" | "inSync" | "pending" | "unavailable" | "unknown";
    /** Whether commands there can't read the keys (Rust `secret_wall`). */
    wall?: "ready" | "needsSetup" | "unknown";
    credentials?: "ready" | "needsLogin" | "unknown";
    github?: "ready" | "needsLogin" | "missing" | "unknown";
    githubScope?: "repository" | "account";
    project: "ready" | "missing" | "unknown" | "notSelected";
  };
};

/** The only Delegate a Remote machine runs (Rust `REMOTE_PROVIDER`). */
export const REMOTE_PROVIDER = "claude-code";

/** What a conversation on a Remote machine may run: Claude Code, or Kit on a
 *  hosted API whose key the machine holds (Rust `remote_machine::validate_request`). */
export function isRemoteProvider(provider: string): boolean {
  return provider === REMOTE_PROVIDER || isRemoteApiProvider(provider);
}

/** A hosted API a machine can hold a key for: a plain secret, and a URL that
 *  needs nothing from this Mac (Rust `machine_inference::remote_api_provider`). */
export function isRemoteApiProvider(provider: string): boolean {
  return providerGroup(provider) === "hosted" && providerEndpointVars(provider).length === 0 && !providerRow(provider)?.keyCommand;
}

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
  for (const listener of listeners) listener();
  return machines;
}

export async function machineRemove(id: string): Promise<Machine[]> {
  const machines = await invoke<Machine[]>("machine_remove", { id });
  for (const listener of listeners) listener();
  return machines;
}

export type MachineSetupAction = "connect" | "authorize" | "prepare" | "signIn" | "gitHub" | "clone" | "protectKeys";

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
