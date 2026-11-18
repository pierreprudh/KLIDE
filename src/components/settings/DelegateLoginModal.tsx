// One-click CLI sign-in: a Klide dialog hosting a real delegate terminal, so
// the CLI's own login (browser OAuth, device code, …) completes in place.
// Spawned with no task, the PTY runs the bare binary — the TUI's first-run
// sign-in screen — exactly what an interactive `vibe` / `claude` shows.
//
// The shell matches the Add-a-machine dialog: a native <dialog> (focus trap,
// inert backdrop and Escape come free), header with title and X, a framed
// terminal body, and a Cancel footer.

import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { ProviderId } from "../../agent/types";
import { DelegateTerminalSurface } from "../ai/DelegateTerminal";
import { stopDelegatePty } from "../../ipc/delegatePty";
import { CloseIcon } from "../../icons";
import { GhostButton } from "./controls";
import "./delegateLoginDialog.css";

export function DelegateLoginModal({
  providerId,
  title,
  workspaceRoot,
  onClose,
  onExited,
}: {
  providerId: ProviderId;
  title: string;
  workspaceRoot: string | null;
  onClose: () => void;
  /** Fired when the modal unmounts (closed) — the caller re-probes auth. */
  onExited?: () => void;
}) {
  // A fixed id per provider: reopening the modal reattaches the same PTY
  // instead of stacking a second login terminal.
  const sessionId = `login:${providerId}`;
  const dialog = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);

  useEffect(() => {
    return () => {
      void stopDelegatePty(sessionId).catch(() => {});
      onExited?.();
    };
  }, [sessionId, onExited]);

  return createPortal(
    <dialog
      ref={dialog}
      className="klide-login-dialog"
      aria-labelledby="klide-login-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2 id="klide-login-title">Sign in to {title}</h2>
        <button
          type="button"
          className="klide-login-close"
          aria-label={`Close sign in to ${title}`}
          onClick={onClose}
        >
          <CloseIcon size={18} />
        </button>
      </header>
      <div className="klide-login-body">
        <p className="klide-login-hint">
          Finish the login in this window — {title} opens the sign-in in your browser — then close it.
        </p>
        <div className="klide-login-terminal">
          <DelegateTerminalSurface
            sessionId={sessionId}
            providerId={providerId}
            provider={title}
            workspaceRoot={workspaceRoot}
          />
        </div>
      </div>
      <footer className="klide-login-footer">
        <GhostButton onClick={onClose}>Cancel</GhostButton>
      </footer>
    </dialog>,
    document.body
  );
}
