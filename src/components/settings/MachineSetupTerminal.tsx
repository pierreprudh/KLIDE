import { useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { terminalLook } from "../../terminalTheme";
import "@xterm/xterm/css/xterm.css";

/** Optional diagnostic view. Opening or hiding it never restarts setup. */
export default function MachineSetupTerminal({ id, terminal }: {
  id: string; terminal: Terminal;
}) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const view = terminal;
    view.options = { ...terminalLook(), fontSize: 12, cursorBlink: true };
    const fit = new FitAddon();
    view.loadAddon(fit);
    if (view.element) container.current!.appendChild(view.element);
    else view.open(container.current!);
    view.focus();
    const observer = new ResizeObserver(() => {
      fit.fit();
      void invoke("pty_resize", { id, rows: view.rows, cols: view.cols }).catch(() => {});
    });
    observer.observe(container.current!);
    // The session owns the emulator and its input listener. Do not replay old
    // output here: that would answer historical terminal queries a second time.
    return () => { observer.disconnect(); fit.dispose(); };
  }, [id, terminal]);
  return <div ref={container} className="klide-machine-terminal" aria-label="Remote setup terminal" />;
}
