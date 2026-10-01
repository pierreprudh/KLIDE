// The Delegate CLIs Klide can dispatch and resume (CONTEXT.md: a Delegate
// is an external CLI agent observed through a PTY), with the facts a surface
// shows without spawning one. This is the frontend's single source of truth —
// the `DelegateId` type union, every runtime "is this a delegate?" check, every
// label map and the account-switcher flag all derive from this one array, so
// adding a delegate is one edit here instead of a dozen scattered literals.
//
// Mirrors `delegate::catalog()` in src-tauri/src/delegate/mod.rs — each
// adapter's `id`, `label`, `binary` and `supports_accounts`. TypeScript union
// types and module-level maps can't wait on an IPC call, so the two lists are
// maintained in parallel — the Rust test `frontend_catalog_matches_all` reads
// this file and fails the build if they ever drift. The same list is served
// live by `delegateCatalog()` in src/ipc/delegates.ts for anything that can
// await it.
export const DELEGATES = [
  { id: "claude-code", label: "Claude Code", binary: "claude", supportsAccounts: true },
  { id: "codex", label: "Codex", binary: "codex", supportsAccounts: true },
  { id: "opencode", label: "OpenCode", binary: "opencode", supportsAccounts: true },
  { id: "omp", label: "Oh My Pi", binary: "omp", supportsAccounts: false },
] as const;

export type DelegateId = (typeof DELEGATES)[number]["id"];

export type DelegateFacts = {
  id: DelegateId;
  label: string;
  binary: string;
  /** Klide can snapshot/switch saved logins for this CLI (accounts.rs). */
  supportsAccounts: boolean;
};

export const DELEGATE_IDS: readonly DelegateId[] = DELEGATES.map((d) => d.id);

export function isDelegateId(id: string): id is DelegateId {
  return (DELEGATE_IDS as readonly string[]).includes(id);
}

export function delegateFacts(id: DelegateId): DelegateFacts {
  return DELEGATES.find((d) => d.id === id) as DelegateFacts;
}

/** The one human name for a delegate — "Claude Code", never "claude-code".
 *  An unknown id (a custom `cli:` agent, a retired source) reads as itself. */
export function delegateLabel(id: string): string {
  return DELEGATES.find((d) => d.id === id)?.label ?? id;
}
