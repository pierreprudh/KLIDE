import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

export function TerminalPanel() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const term = new Terminal({
      fontSize: 12,
      fontFamily: "JetBrains Mono, ui-monospace, monospace",
      theme: { background: "#0a0a0a", foreground: "#eaeaea" },
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);
    fit.fit();

    invoke("pty_spawn");
    const unlisten = listen<string>("pty:data", (e) => term.write(e.payload));
    term.onData((data) => invoke("pty_write", { data }));

    const resize = new ResizeObserver(() => fit.fit());
    resize.observe(ref.current);

    return () => {
      unlisten.then((u) => u());
      resize.disconnect();
      term.dispose();
    };
  }, []);

  return (
    <div
      style={{
        height: "var(--size-terminal)",
        background: "#0a0a0a",
        borderTop: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          padding: "6px 10px",
          fontSize: 11,
          color: "var(--fg-muted)",
          letterSpacing: "0.08em",
          borderBottom: "1px solid var(--border)",
        }}
      >
        TERMINAL
      </div>
      <div ref={ref} style={{ flex: 1, padding: 6, minHeight: 0 }} />
    </div>
  );
}
