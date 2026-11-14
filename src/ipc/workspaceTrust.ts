// Typed frontend Adapter for the `workspace_trust_*` pair — which folders a
// person has trusted. Rust owns the list (`~/.klide/trusted-folders.json`)
// because Rust's git launcher is what acts on it.

import { invoke } from "@tauri-apps/api/core";

export type WorkspaceTrust = {
  trusted: boolean;
  /** Restricted, and the repository's own Git settings name programs, so
   *  Klide runs no Git there until the folder is trusted. */
  gitPaused: boolean;
};

export function workspaceTrustStatus(root: string): Promise<WorkspaceTrust> {
  return invoke<WorkspaceTrust>("workspace_trust_status", { root });
}

export function trustWorkspaces(roots: string[]): Promise<void> {
  return invoke("workspace_trust_grant", { roots });
}
