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
// Both toasts that do appear carry Open, to the conversation the session
// belongs to — the reason you'd act on them at all.

import { playSound } from "./sound";
import { isOnScreen } from "./runAttention";
import { listen } from "@tauri-apps/api/event";
import { notify, type ToastAction } from "./toast";
import { canOpenConversation, openDelegateSession } from "./conversationNavigation";
import { SOURCE_LABEL, type RunSource } from "./runs";

/** A turn shorter than this ends silently — you were probably watching. */
const QUIET_TURN_MS = 30_000;

// Session id is `{convoId}:{provider}` (pty.rs); the provider is the part
// after the last colon.
function providerLabel(sessionId: string): string {
  const provider = sessionId.slice(sessionId.lastIndexOf(":") + 1);
  return SOURCE_LABEL[provider as RunSource] ?? provider;
}

function openAction(sessionId: string): ToastAction | undefined {
  if (!canOpenConversation()) return undefined;
  return { label: "Open", run: () => openDelegateSession(sessionId) };
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

    const conversationId = sessionId.slice(0, sessionId.lastIndexOf(":"));
    if (status === "blocked") {
      if (!isOnScreen(conversationId)) playSound("attention");
      notify(`${providerLabel(sessionId)} needs your input.`, {
        tone: "warn",
        action: openAction(sessionId),
      });
    } else if (
      status === "waiting" &&
      prev?.status === "working" &&
      Date.now() - prev.sinceMs >= QUIET_TURN_MS
    ) {
      if (!isOnScreen(conversationId)) playSound("complete");
      notify(`${providerLabel(sessionId)} finished its turn.`, {
        tone: "success",
        action: openAction(sessionId),
      });
    }
  }).then((u) => {
    if (disposed) u();
    else unlisten = u;
  });

  // A Delegate that started without its coordination tools (pty.rs
  // `wiring_failed`): rare, and otherwise invisible until the CLI says it has
  // no agent_* tool. Always toasts — once per spawn, by construction.
  let unlistenWiring: (() => void) | undefined;
  void listen<{ sessionId: string; reason: string }>("coordination:wiring-failed", (e) => {
    const { sessionId, reason } = e.payload;
    notify(`${providerLabel(sessionId)} started without agent tools: ${reason}`, { tone: "warn" });
  }).then((u) => {
    if (disposed) u();
    else unlistenWiring = u;
  });

  return () => {
    disposed = true;
    unlisten?.();
    unlistenWiring?.();
  };
}
