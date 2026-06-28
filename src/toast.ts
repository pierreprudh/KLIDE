// Global toast bus — the single transient-notification surface.
//
// Before this, action results and failures were scattered: some routed to the
// status-bar `fileNotice` slot, many others were swallowed into `console.error`
// (terminal spawn, AI panel Q&A/permission, delegate handoff, settings, skills).
// A module-level pub/sub lets *any* component report an outcome without
// threading a `notify` prop down through the tree — `import { notify }` and call
// it. The single <ToastHost/> mounted at the App root renders the stack.

export type ToastTone = "info" | "success" | "warn" | "error";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
  action?: ToastAction;
  /** ms before auto-dismiss; 0 keeps it until dismissed (use for errors). */
  duration: number;
}

export interface ToastOptions {
  tone?: ToastTone;
  action?: ToastAction;
  duration?: number;
}

type Listener = (toasts: Toast[]) => void;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<Listener>();
// Cap the stack so a burst (e.g. a failing poll loop) can't bury the screen.
const MAX_VISIBLE = 4;

function emit() {
  for (const l of listeners) l(toasts);
}

/** Infer a tone from the message when the caller doesn't pass one, so the
 *  ~30 existing string-only `notify(msg)` call sites gain colour for free. */
function inferTone(message: string): ToastTone {
  const m = message.toLowerCase();
  if (/(fail|error|unavailable|denied|can'?t|cannot|couldn'?t|invalid|unreachable|missing)/.test(m)) {
    return "error";
  }
  if (/(changed on disk|warning|stale|overwrite)/.test(m)) return "warn";
  if (/(saved|written|ready|done|generated|created|installed|reverted|applied|merged|forked|connected|verified|removed|copied)/.test(m)) {
    return "success";
  }
  return "info";
}

/** Push a toast. Returns its id so the caller can dismiss it early. */
export function pushToast(message: string, opts: ToastOptions = {}): number {
  const id = nextId++;
  const tone = opts.tone ?? inferTone(message);
  // Errors are sticky by default (duration 0) — a failure the user never saw is
  // the bug we're fixing. Everything else clears on its own.
  const duration =
    opts.duration ?? (tone === "error" ? 0 : tone === "warn" ? 6000 : 4000);
  const toast: Toast = { id, message, tone, action: opts.action, duration };
  toasts = [...toasts, toast].slice(-MAX_VISIBLE);
  emit();
  return id;
}

export function dismissToast(id: number) {
  const next = toasts.filter((t) => t.id !== id);
  if (next.length !== toasts.length) {
    toasts = next;
    emit();
  }
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  listener(toasts);
  return () => {
    listeners.delete(listener);
  };
}

/** Convenience alias — reads naturally at call sites (`notify("Saved …")`). */
export const notify = pushToast;
