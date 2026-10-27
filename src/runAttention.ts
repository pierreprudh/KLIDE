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
import { getAgentRunStatus, readAgentRunEvents, resolvePermission } from "./agent/client";
import { pendingGatesFromEvents } from "./agent/pendingGates";
import type { AgentEvent } from "./agent/types";
import { getRunningConversationIds, subscribeRunningConversations } from "./runningConversations";
import { getKlideConvos } from "./klideConvos";
import { errMessage } from "./errors";

export type RunAttention =
  | { runId: string; state: "asking"; kind: "permission" | "question"; requestId: string; summary: string; externalPaths?: string[] }
  | { runId: string; state: "clear" };

/** conversation id → the things it waits on (its own run, or a worker's). */
const waiting = new Map<string, Set<string>>();
let needsYou: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
/** conversation id → how many mounted, visible panels show it. */
const onScreen = new Map<string, number>();
/** run id → the toast still up for its question. */
const toastFor = new Map<string, number>();
/** Conversations whose run ended while nobody was looking — until opened. */
let finishedUnseen: ReadonlySet<string> = new Set();

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

/** Did this conversation finish while you were elsewhere? Cleared when it is
 *  shown. For the rail, which lifts the row's ink a step. */
export function useFinishedUnseen(conversationId: string): boolean {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    () => finishedUnseen.has(conversationId),
    () => false,
  );
}

export function finishedUnseenNow(conversationId: string): boolean {
  return finishedUnseen.has(conversationId);
}

function setFinishedUnseen(conversationId: string, on: boolean): void {
  if (finishedUnseen.has(conversationId) === on) return;
  const next = new Set(finishedUnseen);
  if (on) next.add(conversationId);
  else next.delete(conversationId);
  finishedUnseen = next;
  for (const fn of listeners) fn();
}

/** A panel showing this conversation, visibly. Returns the release. */
export function showConversation(conversationId: string): () => void {
  setFinishedUnseen(conversationId, false);
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
  const outside = !!attention.externalPaths?.length;
  const answer = (decision: Parameters<typeof resolvePermission>[0]["decision"]) =>
    void resolvePermission({ runId, requestId, decision }).catch((error) =>
      notify(`Couldn't answer ${title}: ${errMessage(error)}`, { tone: "error" }),
    );
  toastFor.set(runId, notify(
    outside
      ? `Outside its working folder: ${title} needs approval — Open to review ${attention.externalPaths!.join(", ")}`
      : attention.kind === "permission"
      ? `${title} needs your approval — ${attention.summary}`
      : `${title} asks — ${attention.summary}`,
    {
      tone: "warn",
      provider: convo?.provider ?? undefined,
      duration: 0,
      // A question is answered in its card (it may want words); a
      // permission is a yes or a no, so it can be given from here.
      actions: attention.kind === "permission" && !outside
        ? [
            { label: "Deny", run: () => answer({ behavior: "deny" }) },
            { label: "Allow", run: () => answer({ behavior: "allow", scope: "once" }), primary: true },
          ]
        : undefined,
      action: open,
    },
  ));
}

/** What a transcript says its run is asking right now, if anything. Diffs are
 *  left out on purpose: Rust's `run:attention` doesn't carry them either. */
export function attentionFromEvents(runId: string, events: readonly AgentEvent[]): RunAttention | null {
  const { permission, question } = pendingGatesFromEvents(events);
  if (permission) {
    const paths = (permission.input as { externalPaths?: unknown } | null)?.externalPaths;
    const externalPaths = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === "string") : [];
    return { runId, state: "asking", kind: "permission", requestId: permission.id, summary: permission.summary, externalPaths };
  }
  if (question) return { runId, state: "asking", kind: "question", requestId: question.requestId, summary: question.question };
  return null;
}

/** A run that was already asking before this webview loaded (the window was
 *  reopened, the page reloaded) sent its `run:attention` to nobody. Ask Rust
 *  whether it is parked, and if so read what on from its transcript. */
async function recoverRunAttention(runId: string): Promise<void> {
  const parked = async () => (await getAgentRunStatus(runId).catch(() => null)) === "waiting_for_permission";
  if (!(await parked())) return;
  const events = await readAgentRunEvents(runId).catch(() => null);
  const attention = events && attentionFromEvents(runId, events);
  // Answered while we read: the live `clear` already went by, so check again
  // rather than raise a card nobody is waiting on.
  if (attention && (await parked())) applyRunAttention(attention);
}

/** Start the app-wide watcher. One, at the App root (ToastHost). */
export function watchRunAttention(): () => void {
  let unlisten: (() => void) | null = null;
  let stopped = false;
  void listen<RunAttention>("run:attention", (e) => applyRunAttention(e.payload)).then((fn) => {
    if (stopped) fn();
    else unlisten = fn;
  });
  // Each run confirmed live is checked once for a request it made before we
  // were listening; after that the live events carry it.
  const checked = new Set<string>();
  const sweep = () => {
    const live = getRunningConversationIds();
    // A run that left the live set while its conversation was off screen
    // finished without you: the rail says so until you open it.
    for (const id of checked) if (!live.has(id) && !isOnScreen(id)) setFinishedUnseen(id, true);
    for (const id of checked) if (!live.has(id)) checked.delete(id);
    for (const id of live) {
      if (checked.has(id)) continue;
      checked.add(id);
      void recoverRunAttention(id);
    }
  };
  const stopSweep = subscribeRunningConversations(sweep);
  sweep();
  return () => {
    stopped = true;
    unlisten?.();
    stopSweep();
  };
}

/** Test seam. */
export function resetRunAttention(): void {
  waiting.clear();
  onScreen.clear();
  toastFor.clear();
  finishedUnseen = new Set();
  publish();
}
