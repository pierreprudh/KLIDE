import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { ProviderId } from "../../agent/types";
import { terminalLook } from "../../terminalTheme";
import { notify } from "../../toast";
import { attachDelegatePty, resizeDelegatePty, writeDelegatePty } from "../../ipc/delegatePty";

export function DelegateConsole({
  provider,
  output,
  active,
}: {
  provider: string;
  output: string;
  active: boolean;
}) {
  const lines = output.trimEnd().split("\n").filter(Boolean);
  return (
    <div style={{
      border: "1px solid var(--border-strong)", borderRadius: "var(--radius-md)",
      background: "color-mix(in srgb, var(--bg-elevated) 88%, var(--terminal-bg) 12%)",
      overflow: "hidden",
    }}>
      <div style={{
        height: 34, padding: "0 10px", display: "flex", alignItems: "center",
        justifyContent: "space-between", gap: 10, borderBottom: "1px solid var(--border)",
        color: "var(--fg-subtle)", fontSize: 11,
      }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
          <span style={{ color: "var(--fg-strong)", fontWeight: 600 }}>Delegate Console</span>
          <span>{provider}</span>
        </span>
        <span style={{ color: active ? "var(--accent)" : "var(--fg-subtle)" }}>{active ? "Working" : "Done"}</span>
      </div>
      <pre style={{
        margin: 0, minHeight: 96, maxHeight: 260, overflow: "auto", padding: "10px 11px",
        color: "var(--fg)", fontFamily: "var(--font-mono)", fontSize: 11.5,
        lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word",
      }}>
        {lines.length ? lines.join("\n") : active ? "launching delegate agent..." : "delegate finished without console output."}
      </pre>
    </div>
  );
}

export function DelegateTerminalSurface({
  sessionId,
  providerId,
  provider,
  workspaceRoot,
  parentRunId,
  resumeSessionId,
  model,
  effort,
  task,
  attachOnly = false,
  readOnly = false,
}: {
  sessionId: string;
  providerId: ProviderId;
  provider: string;
  workspaceRoot: string | null;
  parentRunId?: string;
  /** Pass through to `delegate_pty_spawn` so the TUI continues a past
   *  session (e.g. `claude --resume <id>` / `codex resume <id>` /
   *  `opencode -s <id>`). */
  resumeSessionId?: string | null;
  /** Selected model for delegates that accept a model flag, and for custom
   *  CLI templates using `{model}`. */
  model?: string | null;
  /** The reasoning effort for CLIs that take one (Codex reads it as a
   *  `-c model_reasoning_effort=` override). Only ever a level the CLI
   *  published for this model — the picker is fed from its own manifest. */
  effort?: string | null;
  /** Pass through to `delegate_pty_spawn` as the CLI's first prompt — used
   *  for Klide handoff so a fresh delegate session opens with the original
   *  user message already sent. */
  task?: string | null;
  /** Read persisted/live output without ensuring the session exists. Mission
   * review uses this so opening a settled attempt can never respawn it. */
  attachOnly?: boolean;
  readOnly?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const term = new Terminal({
      fontSize: 11,
      lineHeight: 1.35,
      ...terminalLook(),
      cursorBlink: !readOnly,
      scrollback: 5000,
      convertEol: true,
      disableStdin: readOnly,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);

    const syncSize = () => {
      fit.fit();
      void resizeDelegatePty(sessionId, term.rows, term.cols);
    };

    // The replay handshake (subscribe → spawn → snapshot → flush by seq → live)
    // lives in ipc/delegatePty so all three delegate surfaces share one
    // implementation. See that module for why the ordering matters.
    const attachment = attachDelegatePty({
      sessionId,
      term,
      spawn: attachOnly
        ? undefined
        : {
            provider: providerId,
            workspaceRoot,
            parentRunId,
            resumeSessionId: resumeSessionId ?? null,
            model: model ?? null,
            effort: effort ?? null,
            task: task ?? null,
          },
      onReady: syncSize,
      onError: (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        term.writeln(`\x1b[31mFailed to ${attachOnly ? "load" : "start"} ${provider}: ${msg}\x1b[0m`);
        notify(
          attachOnly
            ? `Couldn't load ${provider} terminal evidence.`
            : `Couldn't start ${provider} — check it's installed and on your PATH.`,
          { tone: "error" }
        );
      },
    });

    if (!readOnly) {
      term.onData((data) => {
        // Gated on the replay: xterm answers the terminal queries inside the
        // replayed history, and those stale answers would land in the agent's
        // input as typed junk.
        if (attachment.isReplaying()) return;
        void writeDelegatePty(sessionId, data);
      });
    }

    const resize = new ResizeObserver(syncSize);
    resize.observe(ref.current);
    requestAnimationFrame(syncSize);

    return () => {
      attachment.dispose();
      resize.disconnect();
      term.dispose();
    };
  }, [attachOnly, model, parentRunId, provider, providerId, readOnly, resumeSessionId, sessionId, task, workspaceRoot]);

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "color-mix(in srgb, var(--terminal-bg) 94%, var(--bg))" }}>
      <div ref={ref} style={{ minHeight: 0, padding: 4, height: "min(100%, 480px)" }} />
    </div>
  );
}
