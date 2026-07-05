// Global delegate status watcher — turns `delegate-status:changed` events
// (from the Rust hook server, delegate/status.rs) into at-a-glance toasts,
// so an agent that needs you is noticed without staring at Mission Control.
//
// Noise policy (the whole point of this module):
//   - "blocked" (permission prompt / waiting for input) always toasts — it's
//     rare and actionable.
//   - "waiting" (turn finished) only toasts when the turn ran ≥ 30s. During
//     an active back-and-forth you're already looking at the TUI; the toast
//     earns its place only when you've likely tabbed away.
//   - "working" chatter and repeated states never toast.

import { listen } from "@tauri-apps/api/event";
import { notify } from "./toast";
import { SOURCE_LABEL, type RunSource } from "./runs";

/** A turn shorter than this ends silently — you were probably watching. */
const QUIET_TURN_MS = 30_000;

// Session id is `{convoId}:{provider}` (pty.rs); the provider is the part
// after the last colon.
function providerLabel(sessionId: string): string {
  const provider = sessionId.slice(sessionId.lastIndexOf(":") + 1);
  return SOURCE_LABEL[provider as RunSource] ?? provider;
}

type Seen = { status: string; sinceMs: number };

/** Start the app-wide watcher. Returns a cleanup for the effect that mounts
 *  it — there should be exactly one, at the App root. */
export function watchDelegateStatus(): () => void {
  const last = new Map<string, Seen>();
  let disposed = false;
  let unlisten: (() => void) | undefined;

  void listen<{ sessionId: string; status: string }>("delegate-status:changed", (e) => {
    const { sessionId, status } = e.payload;
    const prev = last.get(sessionId);
    if (status === "end") {
      last.delete(sessionId);
      return;
    }
    if (prev?.status === status) return; // repeats stay silent
    last.set(sessionId, { status, sinceMs: Date.now() });

    if (status === "blocked") {
      notify(`${providerLabel(sessionId)} needs your input.`, { tone: "warn" });
    } else if (
      status === "waiting" &&
      prev?.status === "working" &&
      Date.now() - prev.sinceMs >= QUIET_TURN_MS
    ) {
      notify(`${providerLabel(sessionId)} finished its turn.`, { tone: "success" });
    }
  }).then((u) => {
    if (disposed) u();
    else unlisten = u;
  });

  return () => {
    disposed = true;
    unlisten?.();
  };
}
