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
      fontFamily: "SF Mono, JetBrains Mono, ui-monospace, monospace",
      theme: { background: "#161616", foreground: "#E5E5E5", cursor: "#E5E5E5" },
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
        background: "#161616",
        borderTop: "1px solid var(--border-strong)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          padding: "7px 14px",
          fontSize: 11,
          color: "#9B9B9B",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          fontWeight: 500,
          borderBottom: "1px solid #2A2A2A",
        }}
      >
        Terminal
      </div>
      <div ref={ref} style={{ flex: 1, padding: 6, minHeight: 0 }} />
    </div>
  );
}
