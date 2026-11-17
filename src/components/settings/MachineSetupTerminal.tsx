import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { terminalLook } from "../../terminalTheme";
import { errMessage } from "../../errors";
import type { MachineSetupAction } from "../../ipc/machines";
import "@xterm/xterm/css/xterm.css";

export default function MachineSetupTerminal({ machineId, workspaceRoot, action, onDone }: {
  machineId: string; workspaceRoot: string | null; action: MachineSetupAction;
  onDone: (success: boolean) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const done = useRef(onDone);
  done.current = onDone;
  const [error, setError] = useState("");
  useEffect(() => {
    const id = `machine-setup-${crypto.randomUUID()}`;
    let disposed = false;
    const cleanup: (() => void)[] = [];
    const terminal = new Terminal({ ...terminalLook(), fontSize: 12, cursorBlink: true, scrollback: 1500 });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container.current!);
    fit.fit();
    const report = (reason: unknown) => { if (!disposed) setError(errMessage(reason)); };
    const input = terminal.onData((data) => { void invoke("pty_write", { id, data }).catch(report); });
    const resize = new ResizeObserver(() => {
      fit.fit();
      void invoke("pty_resize", { id, rows: terminal.rows, cols: terminal.cols }).catch(() => {});
    });
    resize.observe(container.current!);
    void (async () => {
      // Subscribe before spawning, including when the remote command exits immediately.
      for (const [name, callback] of [
        ["pty:data", (event: { payload: { id: string; chunk: string } }) => { if (event.payload.id === id && !disposed) terminal.write(event.payload.chunk); }],
        ["machine-setup:exit", (event: { payload: { id: string; success: boolean } }) => { if (event.payload.id === id && !disposed) done.current(event.payload.success); }],
      ] as const) {
        const unlisten = await listen(name, callback as (event: { payload: unknown }) => void);
        if (disposed) { unlisten(); return; }
        cleanup.push(unlisten);
      }
      if (disposed) return;
      await invoke("machine_setup_spawn", { id: machineId, terminalId: id, action, workspaceRoot, rows: terminal.rows, cols: terminal.cols });
      if (disposed) await invoke("machine_setup_close", { id });
      else terminal.focus();
    })().catch((reason) => { report(reason); if (!disposed) done.current(false); });
    return () => {
      disposed = true;
      cleanup.forEach((fn) => fn());
      resize.disconnect(); input.dispose(); terminal.dispose();
      void invoke("machine_setup_close", { id }).catch(() => {});
    };
  }, [machineId, workspaceRoot, action]);
  return <><div ref={container} className="klide-machine-terminal" aria-label="Remote setup terminal" />{error && <p role="alert">{error}</p>}</>;
}
