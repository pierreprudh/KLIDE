// Which conversations are waiting on you — and the toast that says so when
// you are looking at another one.
//
// A Run that asks (a permission card, a question) shows its card inline, but
// only to a mounted conversation. Walk away and it waited on nobody: no toast,
// nothing in the rail. Rust now emits every Run's asking and clearing app-wide
// (`run:attention`, agent/attention.rs); a background worker's asking comes
// through `worker:status` and marks its parent here (src/workerStatus.ts).
//
// The toast is for a conversation you are NOT looking at: the one on screen
// already shows its card, and a second copy of it in a toast is noise.

import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { dismissToast, notify, type ToastAction } from "./toast";
import { canOpenConversation, openConversation } from "./conversationNavigation";
import { resolvePermission } from "./agent/client";
import { getKlideConvos } from "./klideConvos";
import { errMessage } from "./errors";

export type RunAttention =
  | { runId: string; state: "asking"; kind: "permission" | "question"; requestId: string; summary: string }
  | { runId: string; state: "clear" };

/** conversation id → the things it waits on (its own run, or a worker's). */
const waiting = new Map<string, Set<string>>();
let needsYou: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
/** conversation id → how many mounted, visible panels show it. */
const onScreen = new Map<string, number>();
/** run id → the toast still up for its question. */
const toastFor = new Map<string, number>();

function publish() {
  needsYou = new Set(waiting.keys());
  for (const fn of listeners) fn();
}

/** Mark (or clear) one reason a conversation waits on you. `key` tells the
 *  reasons apart: the run's own id, or a worker's run id. */
export function markNeedsYou(conversationId: string, key: string, on: boolean): void {
  const reasons = waiting.get(conversationId);
  if (on) {
    if (reasons?.has(key)) return;
    waiting.set(conversationId, new Set([...(reasons ?? []), key]));
  } else {
    if (!reasons?.has(key)) return;
    const next = new Set(reasons);
    next.delete(key);
    if (next.size) waiting.set(conversationId, next);
    else waiting.delete(conversationId);
  }
  publish();
}

export function needsYouNow(conversationId: string): boolean {
  return needsYou.has(conversationId);
}

/** Does this conversation wait on you right now? For the rail. */
export function useNeedsYou(conversationId: string): boolean {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    () => needsYouNow(conversationId),
    () => false,
  );
}

/** A panel showing this conversation, visibly. Returns the release. */
export function showConversation(conversationId: string): () => void {
  onScreen.set(conversationId, (onScreen.get(conversationId) ?? 0) + 1);
  return () => {
    const n = (onScreen.get(conversationId) ?? 1) - 1;
    if (n > 0) onScreen.set(conversationId, n);
    else onScreen.delete(conversationId);
  };
}

export function isOnScreen(conversationId: string): boolean {
  return onScreen.has(conversationId);
}

/** Apply one attention change from Rust. A Klide conversation's id is its
 *  run id, so the run names the conversation. */
export function applyRunAttention(attention: RunAttention): void {
  const { runId } = attention;
  if (attention.state === "clear") {
    markNeedsYou(runId, runId, false);
    const id = toastFor.get(runId);
    if (id !== undefined) dismissToast(id);
    toastFor.delete(runId);
    return;
  }
  markNeedsYou(runId, runId, true);
  if (isOnScreen(runId) || toastFor.has(runId)) return;
  const convo = getKlideConvos().find((c) => c.id === runId);
  const title = convo?.title?.trim() || "A conversation";
  const open: ToastAction | undefined = canOpenConversation()
    ? { label: "Open", run: () => openConversation(runId) }
    : undefined;
  const { requestId } = attention;
  const answer = (decision: Parameters<typeof resolvePermission>[0]["decision"]) =>
    void resolvePermission({ runId, requestId, decision }).catch((error) =>
      notify(`Couldn't answer ${title}: ${errMessage(error)}`, { tone: "error" }),
    );
  toastFor.set(runId, notify(
    attention.kind === "permission"
      ? `${title} needs your approval — ${attention.summary}`
      : `${title} asks — ${attention.summary}`,
    {
      tone: "warn",
      provider: convo?.provider ?? undefined,
      duration: 0,
      // A question is answered in its card (it may want words); a
      // permission is a yes or a no, so it can be given from here.
      actions: attention.kind === "permission"
        ? [
            { label: "Deny", run: () => answer({ behavior: "deny" }) },
            { label: "Allow", run: () => answer({ behavior: "allow", scope: "once" }), primary: true },
          ]
        : undefined,
      action: open,
    },
  ));
}

/** Start the app-wide watcher. One, at the App root (ToastHost). */
export function watchRunAttention(): () => void {
  let unlisten: (() => void) | null = null;
  let stopped = false;
  void listen<RunAttention>("run:attention", (e) => applyRunAttention(e.payload)).then((fn) => {
    if (stopped) fn();
    else unlisten = fn;
  });
  return () => {
    stopped = true;
    unlisten?.();
  };
}

/** Test seam. */
export function resetRunAttention(): void {
  waiting.clear();
  onScreen.clear();
  toastFor.clear();
  publish();
}
