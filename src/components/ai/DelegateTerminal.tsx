import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { ProviderId } from "../../agent/types";
import { cssVar } from "./utils";

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
      background: "color-mix(in srgb, var(--bg-elevated) 88%, #000 12%)",
      boxShadow: "inset 0 1px 0 var(--panel-highlight), 0 12px 34px rgba(38, 38, 32, 0.12)",
      overflow: "hidden",
    }}>
      <div style={{
        height: 34, padding: "0 10px", display: "flex", alignItems: "center",
        justifyContent: "space-between", gap: 10, borderBottom: "1px solid var(--border)",
        color: "var(--fg-subtle)", fontSize: 11,
      }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
          <span aria-hidden style={{
            width: 7, height: 7, borderRadius: "50%",
            background: active ? "var(--accent)" : "var(--fg-dim)",
            boxShadow: active ? "0 0 14px var(--accent)" : "none",
          }} />
          <span style={{ color: "var(--fg-strong)", fontWeight: 600 }}>Delegate Console</span>
          <span>{provider}</span>
        </span>
        <span>{active ? "Running" : "Finished"}</span>
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
  task,
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
  /** Pass through to `delegate_pty_spawn` as the CLI's first prompt — used
   *  for Klide handoff so a fresh delegate session opens with the original
   *  user message already sent. */
  task?: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const term = new Terminal({
      fontSize: 11,
      fontFamily: "Monaspace Neon, Monaspace Argon, Monaspace, SF Mono, JetBrains Mono, ui-monospace, monospace",
      theme: {
        background: cssVar("--terminal-bg"),
        foreground: cssVar("--terminal-fg"),
        cursor: cssVar("--terminal-cursor"),
      },
      cursorBlink: true,
      scrollback: 5000,
      convertEol: true,
      disableStdin: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);

    const syncSize = () => {
      fit.fit();
      void invoke("delegate_pty_resize", { sessionId, rows: term.rows, cols: term.cols });
    };

    // Replay-on-reattach: a delegate session keeps running in Rust even after
    // this surface unmounts (panel switch, layout change). On (re)mount we must
    // repaint the history it produced while we were gone instead of coming back
    // blank. Ordering matters to avoid dropping or duplicating output:
    //   1. subscribe FIRST, buffering live chunks (don't write yet)
    //   2. spawn (a no-op that returns the existing session if already live)
    //   3. fetch the snapshot (history bytes + high-water seq)
    //   4. paint history, then flush buffered chunks with seq > snapshot seq
    //   5. go live, dropping any chunk already covered (seq <= writtenThrough)
    let cancelled = false;
    let applied = false;
    let writtenThrough = -1;
    const pending: { seq: number; data: string }[] = [];

    const unlisten = listen<{ sessionId: string; data: string; seq: number }>(
      "delegate-pty:data",
      (e) => {
        if (e.payload.sessionId !== sessionId) return;
        if (!applied) { pending.push(e.payload); return; }
        if (e.payload.seq > writtenThrough) {
          term.write(e.payload.data);
          writtenThrough = e.payload.seq;
        }
      },
    );

    const start = async () => {
      // Make sure the listener is registered before we spawn/snapshot, so no
      // live chunk slips through the gap.
      await unlisten;
      if (cancelled) return;
      try {
        await invoke("delegate_pty_spawn", {
          sessionId,
          provider: providerId,
          workspaceRoot,
          parentRunId,
          resumeSessionId: resumeSessionId ?? null,
          task: task ?? null,
        });
        if (cancelled) return;
        const snap = await invoke<{ data: string; seq: number; live: boolean }>(
          "delegate_pty_snapshot",
          { sessionId },
        );
        if (cancelled) return;
        if (snap.data) term.write(snap.data);
        writtenThrough = snap.seq;
        for (const p of pending) {
          if (p.seq > writtenThrough) {
            term.write(p.data);
            writtenThrough = p.seq;
          }
        }
        pending.length = 0;
        applied = true;
        syncSize();
      } catch (err) {
        term.writeln(`Failed to start ${provider}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    void start();

    term.onData((data) => { void invoke("delegate_pty_write", { sessionId, data }); });

    const resize = new ResizeObserver(syncSize);
    resize.observe(ref.current);
    requestAnimationFrame(syncSize);

    return () => {
      cancelled = true;
      unlisten.then((u) => u());
      resize.disconnect();
      term.dispose();
    };
  }, [providerId, sessionId, workspaceRoot]);

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "color-mix(in srgb, var(--terminal-bg) 94%, var(--bg))" }}>
      <div ref={ref} style={{ minHeight: 0, padding: 4, height: "min(100%, 480px)" }} />
    </div>
  );
}
