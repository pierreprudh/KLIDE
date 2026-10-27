// Background workers, seen from anywhere in the app.
//
// A background worker keeps working while its parent conversation is off
// screen, and the row that follows it (`SubagentCallRow`) only exists while
// that conversation is mounted. So a worker that asked for approval waited on
// nobody, and one that finished said so only when the parent's follow-up turn
// ended. Rust now tells the whole app (`worker:status`, agent/mod.rs
// `broadcast`): this module turns that into
//   - a toast when a worker asks, and when it finishes or fails — each with
//     Open, to the conversation that dispatched it;
//   - the parent counting as running in the rail while a worker works.
// Only transitions toast: a worker that asks twice in a row is one toast.

import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { notify, type ToastAction } from "./toast";
import { canOpenConversation, openConversation } from "./conversationNavigation";

export type WorkerState = "working" | "asking" | "finished" | "failed";

export type WorkerStatus = {
  parentId: string;
  runId: string;
  label: string;
  role: string;
  state: WorkerState;
  detail?: string | null;
};

/** What one status change means: the toast to show (if any) and whether the
 *  worker still counts as live. Pure, so the policy is testable. */
export function workerTransition(
  previous: WorkerState | undefined,
  next: WorkerStatus,
): { toast: { message: string; tone: "warn" | "success" | "error" } | null; live: boolean } {
  const live = next.state === "working" || next.state === "asking";
  if (previous === next.state) return { toast: null, live };
  const who = `${next.label} (${next.role})`;
  switch (next.state) {
    case "asking":
      return { toast: { message: `${who} needs your approval${next.detail ? `: ${next.detail}` : ""}`, tone: "warn" }, live };
    case "finished":
      return { toast: { message: `${who} finished`, tone: "success" }, live };
    case "failed":
      return { toast: { message: `${who} stopped${next.detail ? `: ${next.detail}` : ""}`, tone: "error" }, live };
    default:
      return { toast: null, live };
  }
}

const lastState = new Map<string, WorkerState>();
/** child run id → parent conversation id, for workers still going. */
const liveWorkers = new Map<string, string>();
let liveParents: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function publish() {
  liveParents = new Set(liveWorkers.values());
  for (const fn of listeners) fn();
}

/** Apply one status from Rust. Exported for tests; the watcher calls it. */
export function applyWorkerStatus(status: WorkerStatus): void {
  const { toast, live } = workerTransition(lastState.get(status.runId), status);
  lastState.set(status.runId, status.state);
  const wasLive = liveWorkers.has(status.runId);
  if (live) liveWorkers.set(status.runId, status.parentId);
  else {
    liveWorkers.delete(status.runId);
    lastState.delete(status.runId);
  }
  if (live !== wasLive) publish();
  if (toast) {
    const action: ToastAction | undefined = canOpenConversation()
      ? { label: "Open", run: () => openConversation(status.parentId) }
      : undefined;
    notify(toast.message, { tone: toast.tone, action });
  }
}

/** Does this conversation have a background worker going right now? */
export function hasLiveWorker(conversationId: string): boolean {
  return liveParents.has(conversationId);
}

/** `hasLiveWorker`, kept current for a component. */
export function useHasLiveWorker(conversationId: string): boolean {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    () => hasLiveWorker(conversationId),
    () => false,
  );
}

/** Start the app-wide watcher. One, at the App root (ToastHost). */
export function watchWorkerStatus(): () => void {
  let unlisten: (() => void) | null = null;
  let stopped = false;
  void listen<WorkerStatus>("worker:status", (e) => applyWorkerStatus(e.payload)).then((fn) => {
    if (stopped) fn();
    else unlisten = fn;
  });
  return () => {
    stopped = true;
    unlisten?.();
  };
}

/** Test seam. */
export function resetWorkerStatus(): void {
  lastState.clear();
  liveWorkers.clear();
  publish();
}
