// `klide://` links — the typed wire for deep_link.rs.
//
// Rust parses and checks every link; what arrives here already names a real
// file or folder. Links are queued in Rust until the page drains them, so one
// that launched the app waits for the UI instead of being lost to a listener
// that wasn't registered yet: drain on mount, and again on each `deep-link`
// nudge. A link that didn't parse arrives as `deep-link:error`, in words.

import { invoke } from "@tauri-apps/api/core";
import type { DelegateId } from "../delegates";

export type LinkAction =
  /** A new conversation with `prompt` in the composer — pre-filled, never sent. */
  | { kind: "new"; prompt: string; project: string | null }
  /** A file in a tab, at `line` when given; `project` is its repository. */
  | { kind: "open"; path: string; line: number | null; project: string | null }
  /** A folder as the open project. */
  | { kind: "project"; path: string }
  /** A Delegate CLI's own session, continued in an AI panel (`--resume`);
   *  `project` is the folder it ran in, read from its transcript when known. */
  | { kind: "resume"; provider: DelegateId; session: string; project: string | null };

export const DEEP_LINK_EVENT = "deep-link";
export const DEEP_LINK_ERROR_EVENT = "deep-link:error";

/** Every queued link, oldest first; the queue is empty after. */
export function takeDeepLinks(): Promise<LinkAction[]> {
  return invoke<LinkAction[]>("deep_link_take");
}
