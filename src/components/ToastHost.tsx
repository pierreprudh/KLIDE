import { useEffect, useRef, useState } from "react";
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

const TONE_COLOR: Record<ToastTone, string> = {
  info: "var(--fg-subtle)",
  success: "var(--success)",
  warn: "var(--warning)",
  error: "var(--danger)",
};

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
        padding: "9px 11px 9px 13px",
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--panel-border)",
        borderLeft: `2px solid ${toneColor}`,
        boxShadow: "var(--panel-shadow)",
        fontSize: 12.5,
        fontWeight: 500,
        lineHeight: 1.4,
        color: "var(--fg-strong)",
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          display: "-webkit-box",
          WebkitLineClamp: 3,
          WebkitBoxOrient: "vertical",
          whiteSpace: "normal",
          wordBreak: "break-word",
        }}
      >
        {message}
      </span>
      {action && (
        <button
          onClick={() => {
            action.run();
            dismissToast(id);
          }}
          style={{
            flexShrink: 0,
            padding: "3px 9px",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--border-strong)",
            background: "var(--bg-elevated)",
            color: "var(--accent)",
            fontSize: 12,
            fontWeight: 600,
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

export default function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => subscribeToasts(setToasts), []);

  // The delegate status watcher lives with the surface that renders its
  // output: ToastHost is mounted exactly once at the App root, so this is
  // the one place the app-wide "agent needs you / turn done" subscription
  // can't be double-mounted or forgotten.
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    return watchDelegateStatus();
  }, []);

  if (toasts.length === 0) return null;

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
      {toasts.map((t) => (
        <ToastRow key={t.id} toast={t} />
      ))}
    </div>,
    document.body,
  );
}
