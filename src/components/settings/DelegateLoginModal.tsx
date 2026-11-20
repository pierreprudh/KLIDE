// One-click CLI sign-in: a Klide dialog hosting a real delegate terminal, so
// the CLI's own login (browser OAuth, device code, …) completes in place.
// Spawned with no task, the PTY runs the bare binary — the TUI's first-run
// sign-in screen — exactly what an interactive `vibe` / `claude` shows.
//
// The shell matches the Add-a-machine dialog: a native <dialog> (focus trap,
// inert backdrop and Escape come free), header with title and X, a framed
// terminal body, and a Cancel footer.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ProviderId } from "../../agent/types";
import { DelegateTerminalSurface } from "../ai/DelegateTerminal";
import { onDelegateExit, stopDelegatePty } from "../../ipc/delegatePty";
import { saveDelegateApiKey } from "../../ipc/delegates";
import { errMessage } from "../../errors";
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
  // Native sign-in form (API key) vs. the CLI's own terminal flow.
  const [showTerminal, setShowTerminal] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // The PTY is stopped only on a real close — never in an effect cleanup,
  // which React StrictMode runs once on mount in dev and would kill the
  // just-spawned CLI mid-start.
  const close = useCallback(() => {
    void stopDelegatePty(sessionId).catch(() => {});
    onExited?.();
    onClose();
  }, [sessionId, onClose, onExited]);

  const saveKey = useCallback(() => {
    if (!apiKey.trim() || saving) return;
    setSaving(true);
    setSaveError(null);
    void saveDelegateApiKey(providerId, apiKey.trim())
      .then(() => close())
      .catch((e) => {
        setSaving(false);
        setSaveError(errMessage(e));
      });
  }, [apiKey, saving, providerId, close]);

  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);

  // When the CLI exits (login done, `/exit` typed), the window finishes
  // itself: stop, close, re-probe auth.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onDelegateExit((exit) => {
      if (!cancelled && exit.sessionId === sessionId) close();
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [sessionId, close]);

  return createPortal(
    <dialog
      ref={dialog}
      className="klide-login-dialog"
      aria-labelledby="klide-login-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <header>
        <h2 id="klide-login-title">Sign in to {title}</h2>
        <button
          type="button"
          className="klide-login-close"
          aria-label={`Close sign in to ${title}`}
          onClick={close}
        >
          <CloseIcon size={18} />
        </button>
      </header>
      <div className="klide-login-body">
        <p className="klide-login-hint">
          Sign in to {title} with a Mistral API key (create one at console.mistral.ai), or open {title}'s
          own browser sign-in in a terminal below.
        </p>
        <form
          className="klide-login-form"
          onSubmit={(e) => {
            e.preventDefault();
            saveKey();
          }}
        >
          <input
            type="password"
            className="klide-field"
            placeholder="MISTRAL_API_KEY"
            aria-label={`${title} API key`}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit" className="klide-button klide-button-primary" disabled={!apiKey.trim() || saving}>
            {saving ? "Saving…" : "Save and sign in"}
          </button>
        </form>
        {saveError ? <p className="klide-login-error">{saveError}</p> : null}
        <button type="button" className="klide-button klide-button-ghost" onClick={() => setShowTerminal((v) => !v)}>
          {showTerminal ? "Hide terminal" : "Use browser sign-in in a terminal"}
        </button>
        {showTerminal ? (
          <div className="klide-login-terminal">
            <DelegateTerminalSurface
              sessionId={sessionId}
              providerId={providerId}
              provider={title}
              workspaceRoot={workspaceRoot}
            />
          </div>
        ) : null}
      </div>
      <footer className="klide-login-footer">
        <GhostButton onClick={close}>Cancel</GhostButton>
      </footer>
    </dialog>,
    document.body
  );
}
