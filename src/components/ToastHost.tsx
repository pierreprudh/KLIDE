import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Z } from "../zLayers";
import { watchDelegateStatus } from "../delegateStatusNotify";
import {
  type Toast,
  type ToastTone,
  dismissToast,
  subscribeToasts,
} from "../toast";

// The single transient-notification surface. Mounted once at the App root;
// renders whatever the toast bus holds as a quiet bottom-right stack above the
// status bar. Newest sits closest to the corner. Hovering a toast pauses its
// auto-dismiss so a result can be read (or its action taken) without racing a
// timer.

// No spines, no badges — tone shows only through the message text itself,
// and only when it matters (warn/error). Info and success stay neutral.
const TONE_COLOR: Record<ToastTone, string> = {
  info: "var(--fg-strong)",
  success: "var(--fg-strong)",
  warn: "var(--warning)",
  error: "var(--danger)",
};

// "Title — detail" messages render as two lines: the title carries the tone,
// the detail sits quieter underneath. Messages without a dash stay one line.
function splitMessage(message: string): { title: string; detail: string | null } {
  const idx = message.indexOf(" — ");
  if (idx === -1) return { title: message, detail: null };
  return { title: message.slice(0, idx), detail: message.slice(idx + 3) };
}

function ToastRow({ toast }: { toast: Toast }) {
  const { id, message, tone, action, duration } = toast;
  const timer = useRef<number | null>(null);

  const clear = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };
  const arm = () => {
    if (duration > 0 && timer.current === null) {
      timer.current = window.setTimeout(() => dismissToast(id), duration);
    }
  };

  useEffect(() => {
    arm();
    return clear;
    // duration/id are stable for a given toast instance
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toneColor = TONE_COLOR[tone];
  const { title, detail } = splitMessage(message);

  return (
    <div
      role="status"
      aria-live={tone === "error" ? "assertive" : "polite"}
      className="glass-toast toast-enter"
      onMouseEnter={clear}
      onMouseLeave={arm}
      style={{
        pointerEvents: "auto",
        display: "flex",
        alignItems: "center",
        gap: 10,
        maxWidth: 380,
        minWidth: 220,
        padding: "10px 12px 10px 14px",
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--panel-border)",
        boxShadow: "inset 0 1px 0 var(--panel-highlight), var(--panel-shadow)",
        fontSize: 12.5,
        lineHeight: 1.45,
        color: toneColor,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            whiteSpace: "normal",
            wordBreak: "break-word",
          }}
        >
          {title}
        </div>
        {detail && (
          <div
            style={{
              marginTop: 2,
              fontSize: 11.5,
              color: "var(--fg-subtle)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              whiteSpace: "normal",
              wordBreak: "break-word",
            }}
          >
            {detail}
          </div>
        )}
      </div>
      {action && (
        <button
          onClick={() => {
            action.run();
            dismissToast(id);
          }}
          style={{
            flexShrink: 0,
            padding: "3px 7px",
            borderRadius: "var(--radius-sm)",
            border: "none",
            background: "transparent",
            color: "var(--accent)",
            fontSize: 12,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--bg-hover)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
          }}
        >
          {action.label}
        </button>
      )}
      <button
        onClick={() => dismissToast(id)}
        aria-label="Dismiss"
        style={{
          flexShrink: 0,
          width: 20,
          height: 20,
          display: "grid",
          placeItems: "center",
          borderRadius: "var(--radius-sm)",
          color: "var(--fg-dim)",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--bg-hover)";
          e.currentTarget.style.color = "var(--fg-strong)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = "var(--fg-dim)";
        }}
      >
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
          <path
            d="M2.5 2.5l7 7M9.5 2.5l-7 7"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}

// A toast that left the bus (auto-dismiss, ✕, or pushed out by the stack cap)
// stays rendered with `leaving: true` until its exit animation finishes — so
// the oldest toast fades and collapses instead of popping out of the stack.
type Row = { toast: Toast; leaving: boolean };

// Keep in sync with the .toast-leave slide-out in tokens.css (360ms) — the row
// is removed right after the card is off-screen, and the FLIP pass glides the
// survivors into the freed space. Timer-driven, so a missed animation event
// can never leave a ghost toast behind.
const EXIT_MS = 380;

export default function ToastHost() {
  const [rows, setRows] = useState<Row[]>([]);
  const exiting = useRef(new Set<number>());

  useEffect(
    () =>
      subscribeToasts((next) => {
        setRows((prev) => {
          const live = new Map(next.map((t) => [t.id, t]));
          const merged: Row[] = [];
          for (const r of prev) {
            const t = live.get(r.toast.id);
            if (t) {
              merged.push({ toast: t, leaving: false });
              live.delete(r.toast.id);
            } else {
              merged.push(r.leaving ? r : { ...r, leaving: true });
            }
          }
          for (const t of live.values()) merged.push({ toast: t, leaving: false });
          return merged;
        });
      }),
    [],
  );

  useEffect(() => {
    for (const r of rows) {
      if (!r.leaving || exiting.current.has(r.toast.id)) continue;
      const id = r.toast.id;
      exiting.current.add(id);
      window.setTimeout(() => {
        exiting.current.delete(id);
        setRows((prev) => prev.filter((p) => p.toast.id !== id));
      }, EXIT_MS);
    }
  }, [rows]);

  // FLIP the survivors: when the stack reflows (a new toast pushes in, a
  // removed row gives its space back), each remaining card glides from its
  // previous position instead of jumping. Same idea as useFlipIndicator.
  const shells = useRef(new Map<number, HTMLDivElement>());
  const tops = useRef(new Map<number, number>());

  useLayoutEffect(() => {
    for (const [id, el] of shells.current) {
      const prevTop = tops.current.get(id);
      const top = el.getBoundingClientRect().top;
      if (prevTop !== undefined && Math.abs(prevTop - top) > 0.5) {
        el.animate(
          [{ transform: `translateY(${prevTop - top}px)` }, { transform: "translateY(0)" }],
          { duration: 420, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
        );
      }
      tops.current.set(id, top);
    }
    for (const id of tops.current.keys()) {
      if (!shells.current.has(id)) tops.current.delete(id);
    }
  }, [rows]);

  // The delegate status watcher lives with the surface that renders its
  // output: ToastHost is mounted exactly once at the App root, so this is
  // the one place the app-wide "agent needs you / turn done" subscription
  // can't be double-mounted or forgotten.
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    return watchDelegateStatus();
  }, []);

  if (rows.length === 0) return null;

  return createPortal(
    <div
      style={{
        position: "fixed",
        right: 12,
        bottom: "calc(var(--size-status-bar) + 12px)",
        zIndex: Z.toast,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        alignItems: "flex-end",
        pointerEvents: "none",
      }}
    >
      {rows.map((r) => (
        <div
          key={r.toast.id}
          ref={(el) => {
            if (el) shells.current.set(r.toast.id, el);
            else shells.current.delete(r.toast.id);
          }}
          className={r.leaving ? "toast-shell toast-leave" : "toast-shell"}
        >
          <ToastRow toast={r.toast} />
        </div>
      ))}
    </div>,
    document.body,
  );
}
