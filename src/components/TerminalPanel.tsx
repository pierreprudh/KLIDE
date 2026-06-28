import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import type { ThemeId } from "../theme";
import { notify } from "../toast";

type Props = {
  visible: boolean;
  onToggle: () => void;
  theme: ThemeId;
  height: number;
  workspaceRoot: string | null;
  fill?: boolean;
};

function ChevronDownIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function TerminalPanel({
  visible,
  onToggle,
  theme,
  height,
  workspaceRoot,
  fill,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const cwdLabel = workspaceRoot?.split("/").filter(Boolean).pop() ?? "home";

  useEffect(() => {
    if (!ref.current || !visible) return;
    const term = new Terminal({
      fontSize: 11.5,
      lineHeight: 1.25,
      fontFamily:
        "Monaspace Neon, Monaspace Argon, JetBrains Mono, SF Mono, Menlo, ui-monospace, monospace",
      theme: {
        background: cssVar("--terminal-bg"),
        foreground: cssVar("--terminal-fg"),
        cursor: cssVar("--terminal-cursor"),
      },
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);
    fit.fit();

    let disposed = false;
    const spawn = () => {
      invoke("pty_spawn", { workspaceRoot }).catch((e) => {
        if (disposed) return;
        const msg = e instanceof Error ? e.message : String(e);
        // Surface inline in the panel itself (red), not just a toast — a blank
        // terminal that silently failed to start reads as a frozen app.
        term.writeln(`\x1b[31mShell failed to start: ${msg}\x1b[0m`);
        notify(`Terminal failed to start: ${msg}`, {
          tone: "error",
          action: { label: "Retry", run: spawn },
        });
      });
    };
    spawn();
    const unlisten = listen<string>("pty:data", (e) => term.write(e.payload));
    term.onData((data) => invoke("pty_write", { data }));

    const resize = new ResizeObserver(() => fit.fit());
    resize.observe(ref.current);

    return () => {
      disposed = true;
      unlisten.then((u) => u());
      resize.disconnect();
      term.dispose();
    };
  }, [visible, theme, workspaceRoot]);

  return (
    <div
      className={visible ? "terminal-enter" : undefined}
      aria-hidden={!visible}
      style={{
        height: fill ? "100%" : visible ? height : 0,
        flex: fill ? 1 : undefined,
        flexShrink: 0,
        overflow: "hidden",
        opacity: fill || visible ? 1 : 0,
        background: "color-mix(in srgb, var(--terminal-bg) 96%, var(--bg))",
        borderTop: visible ? "1px solid var(--terminal-border)" : "1px solid transparent",
        transition:
          "height 240ms var(--ease-soft), opacity 180ms var(--ease-out), border-color 180ms var(--ease-out), background 180ms var(--ease-out)",
        display: "flex",
        flexDirection: "column",
        backdropFilter: "blur(12px)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          height: 32,
          padding: "0 8px 0 14px",
          borderBottom: visible ? "1px solid var(--terminal-border)" : "none",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 11,
            color: "var(--terminal-muted)",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            fontWeight: 500,
          }}
        >
          Terminal · {cwdLabel}
        </span>
        <button
          onClick={onToggle}
          title={visible ? "Hide terminal" : "Show terminal"}
          aria-label={visible ? "Hide terminal" : "Show terminal"}
          style={{
            width: 24,
            height: 24,
            borderRadius: "var(--radius-sm)",
            display: "grid",
            placeItems: "center",
            color: "var(--terminal-muted)",
            transition:
              "background var(--motion-med) var(--ease-out), color var(--motion-med) var(--ease-out), transform var(--motion-med) var(--ease-soft)",
            transform: visible ? "none" : "rotate(180deg)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--terminal-hover)";
            e.currentTarget.style.color = "var(--terminal-fg)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "var(--terminal-muted)";
          }}
        >
          <ChevronDownIcon />
        </button>
      </div>
      {visible && <div ref={ref} style={{ flex: 1, padding: 6, minHeight: 0 }} />}
    </div>
  );
}
