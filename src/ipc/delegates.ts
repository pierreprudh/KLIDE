// Typed frontend adapter for `delegate_catalog` — the Delegate CLIs Klide
// knows, as the facts their adapters state (id, label, binary, whether logins
// can be switched). The pinned mirror in src/delegates.ts is what module-level
// code reads; this is the same list live, for anything that can await it.

import { invoke } from "@tauri-apps/api/core";
import type { DelegateFacts } from "../delegates";

/** Mirrors `delegate::DelegateFacts`. */
export function delegateCatalog(): Promise<DelegateFacts[]> {
  return invoke<DelegateFacts[]>("delegate_catalog");
}
