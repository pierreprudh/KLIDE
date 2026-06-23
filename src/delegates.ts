// The set of Delegate CLIs Klide can dispatch and resume (CONTEXT.md: a
// Delegate is an external CLI agent observed through a PTY). This is the
// frontend's single source of truth — the `DelegateId` type union AND every
// runtime "is this a delegate?" check derive from this one array, so adding a
// delegate is one edit here instead of five scattered string literals.
//
// Mirrors `delegate::ALL` in src-tauri/src/delegate/mod.rs. TypeScript union
// types can't be produced from a runtime IPC call, so the two lists are
// maintained in parallel — the Rust test `frontend_delegate_ids_match_all`
// reads this file and fails the build if they ever drift.
export const DELEGATE_IDS = ["claude-code", "codex", "opencode", "omp"] as const;

export type DelegateId = (typeof DELEGATE_IDS)[number];

export function isDelegateId(id: string): id is DelegateId {
  return (DELEGATE_IDS as readonly string[]).includes(id);
}
